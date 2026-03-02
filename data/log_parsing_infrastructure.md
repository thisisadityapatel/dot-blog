# Log Processing Infrastructure for Enterprise CI/CD Pipelines
30th August, 2024

<br>

Had built systems for distributed log processing in one of my past internships, here is my take and understanding on designing such scalable infrastructure. Modern CI/CD pipelines generate massive volumes of unstructured log data that contain critical insights about deployment failures and performance bottlenecks, requiring real-time processing infrastructure to extract actionable data insights from these streams. This data can be used to generate DevOps Insights ([DevOps DORA](https://www.atlassian.com/devops/frameworks/dora-metrics), [DevOps SPACE](https://linearb.io/blog/space-framework) frameworks), clean pre-training datasets for machine learning models, or for government regulatory needs ([SMOB](https://www.cyber.gc.ca/en/news-events/joint-guidance-shared-vision-software-bill-materials-cyber-security)).

<br>

### Why

In my case the deployment were in Github Actions + OpenShift Container Platform, development teams deploy applications hundreds or thousands of times per day across multiple environments, cloud providers (AWS, GCP), and deployment tools. This technical blog walks through building a high performance log parsing system using a distributed event-driven architecture, to ingest data in a data warehouse (Elasticsearch in this case).

<br>

### Design Overview

<div style="text-align: center; margin: 60px 0;">
  <img src="/images/system_design.png" alt="System Design" style="max-width: 800px; width: 100%; height: auto" />
</div>

<br>

### Producer - Log Collection and Event Publishing

This part is responsible for pulling new log data, ingesting it on AWS S3 & PostgreSQL, and triggering downstream processing event stream to a Kafka topic.

<br>

#### Apache Airflow DAG

Using [Apache Airflow](https://airflow.apache.org/) to orchestrate log collection through a scheduled DAG cron-job running every 5 minutes (this is important, this must me the average run-time of the DAG itself). Airflow is good for scheduling, retry mechanisms, and monitoring capabilities essential for production ETL data pipelines.

The DAG performs four key operations in sequence:
1. Detects OCP deployments and links deployment IDs to GitHub Actions pipelines
2. Retrieves logs from GitHub Actions Enterprise API and other CI/CD sources (3rd party vendors like [AquaScans](https://www.aquasec.com/products/container-vulnerability-scanning/), [SonarQube](https://www.sonarsource.com/products/sonarqube/) etc.)
3. Uploads .log files to S3 bucket with datetime partitioning
4. Saves metadata to PostgreSQL and publishes Kafka events

<br>

#### Storage and Metadata

**S3 Storage Strategy**: Log files are organized using datetime-based partitioning to enable parallel processing and efficient retrieval:
```bash
s3://deployment-logs/
├── year=2024/
│   ├── month=01/
│   │   ├── day=15/
│   │   │   ├── hour=14/
│   │   │   │   └── {deployment_key}.log
```

**PostgreSQL Metadata Tracking**: Maintains a lightweight tracking table to map deployment keys to their S3 location pathways and processing status:

```sql
CREATE TABLE deployment_metadata (
    id SERIAL PRIMARY KEY,
    deployment_key VARCHAR(255) UNIQUE NOT NULL,
    s3_path TEXT NOT NULL,
    status VARCHAR(50) DEFAULT 'PENDING',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    processed_at TIMESTAMP,
    application_name VARCHAR(255),
    deployment_type VARCHAR(100)
);
```

<br>

#### Event Publishing with Kafka

After storing logs and metadata, the DAG publishes an event to Kafka topic attached with the deployment key. This decouples log collection from processing.

```python
def publish_to_kafka(deployment_key):
    producer = KafkaProducer(
        bootstrap_servers=['kafka-cluster:9092'],
        value_serializer=lambda v: json.dumps(v).encode('utf-8'),
        acks='all',  # Wait for all replicas to acknowledge
        retries=3
    )
    
    event = {
        'deployment_key': deployment_key,
        'timestamp': datetime.utcnow().isoformat(),
        'source': 'github_actions'
    }
    
    producer.send('log-processing-events', event)
    producer.flush()
```

The code above sends events to a random partition in the Kafka topic. In the current setup where Spark workers can consume from any partition, random partitioning works fine and provides good load balancing. However, as the system scales, teams may want to assign specific workers to specific partitions for any scalability issue/reason. In such cases, using the deployment key as a partition key ensures that related events consistently route to the same partition and eventually worker.

<br>

**Useful Resources:**
- [Apache Airflow Documentation](https://airflow.apache.org/docs/)
- [Airflow Parallel Processing Task Groups](https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/dags.html#taskgroups)
- [GitHub Actions API for Workflow Runs](https://docs.github.com/en/rest/actions/workflow-runs)
- [Apache Kafka Producer Configuration](https://kafka.apache.org/documentation/#producerconfigs) 
- [AWS S3 Unload Documentation](https://docs.aws.amazon.com/redshift/latest/dg/r_UNLOAD.html)
  
<br>
  
### Consumer - Event Subscription and Spark Processing

The consumer component subscribes to Kafka events and manages distributed processing through Apache Spark cluster coordination.

#### Apache Spark Architecture

[Apache Spark](https://spark.apache.org/) provides the distributed computing framework for processing logs at scale. This project architecture uses a master-worker pattern where the Spark master coordinates job distribution across multiple worker nodes.

**Spark Master Responsibilities:**
- Resource allocation and job scheduling
- Worker node health monitoring  
- Fault tolerance and job recovery
- Load balancing across available workers

**Spark Worker Responsibilities:**
- Execute assigned processing tasks
- Download logs from S3
- Apply parsing logic and regular expressions
- Update Elasticsearch documents

<br>

#### Kafka Event Consumption

The Spark master runs a continuous consumer that subscribes to the log processing topic and distributes work across available worker nodes:

```python
consumer = KafkaConsumer('log-processing-events', group_id='spark-log-processors')

for message in consumer:
    deployment_key = message.value['deployment_key']
    spark.sparkContext.parallelize([deployment_key]) \
        .foreach(lambda key: process_deployment_logs(key))
```

This code reads Kafka messages from multiple partitions in the topic and each event triggers a new Spark job that gets distributed across available worker nodes. This is the core point where horizontal scaling is possible, adding more worker nodes increases the processing throughput directly (but yeah, too complicated to talk about in this tiny blog).

<br>

#### AWS Spark Cluster

To set up Spark workers on AWS, you can use several approaches:

**AWS EMR (Managed)**: 
```shell
aws emr create-cluster --name "LogProcessingCluster" --release-label emr-6.9.0 --instance-groups InstanceGroupType=MASTER,InstanceType=m5.xlarge,InstanceCount=1 InstanceGroupType=CORE,InstanceType=m5.2xlarge,InstanceCount=5
```

1 Master node (m5.xlarge), 5 Core nodes (m5.2xlarge) for the above code.

**EC2 Instances (Self-managed but chaotic)**: Launch EC2 instances with Spark installed and configure them to join the master cluster using the master's IP.

<br>

#### Multi-Worker Node Coordination

Multiple Spark worker nodes enable parallel processing of different deployments simultaneously. The master distributes jobs based on available resources and current workload. Workers communicate with shared storage (S3, PostgreSQL, Elasticsearch) but process different deployment keys independently, ensuring horizontal scalability without resource conflicts.

**Key Resources:**
- [Apache Spark Cluster Mode Overview](https://spark.apache.org/docs/latest/cluster-overview.html)
- [Kafka Consumer API Documentation](https://kafka.apache.org/documentation/#consumerapi)
- [AWS EMR Spark Configuration](https://docs.aws.amazon.com/emr/latest/ReleaseGuide/emr-spark-configure.html)

<br>

### Processor - Log Parsing and Data Structuring

The processor component performs the core work of transforming unstructured log files into structured, searchable data using regular expressions and database operations.

<br>

#### PySpark Log Processing

Each Spark worker executes the processing logic for assigned deployment keys. The processor follows a five-step workflow:

```python
def process_deployment_logs(deployment_key):
    try:
        metadata = get_deployment_metadata(deployment_key)             # Query PostgreSQL
        raw_logs = download_logs_from_s3(metadata['s3_path'])          # Download from S3
        structured_data = parse_logs(raw_logs, metadata)               # Apply regex parsing
        update_elasticsearch_document(deployment_key, structured_data) # Update ES record
        update_processing_status(deployment_key, 'COMPLETED')          # Mark complete
    except Exception as e:
        update_processing_status(deployment_key, 'FAILED', str(e))
```

The processing function handles database connections to PostgreSQL for metadata retrieval, S3 operations for log file access, and Elasticsearch updates for the final structured data.

<br>

#### Regular Expression (Regex Magic)

The parser applies multiple layers of regular expressions to extract structured information from diverse log formats. The system defines regex patterns for different log types and components:

```python
patterns = {
    'timestamp': r'(\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)',
    'log_level': r'\b(DEBUG|INFO|WARN|WARNING|ERROR|FATAL|TRACE)\b',
    'build_step': r'(Building|Testing|Deploying|Scanning|Publishing)\s+(.+?)(?:\s|$)',
    'error_message': r'(ERROR|FAILED?):\s*(.+?)(?:\n|$)',
    'docker_layer': r'Step\s+(\d+/\d+)\s*:\s*(.+)',
    'maven_phase': r'\[INFO\]\s+---\s+(.+?):(.+?):(.+?)\s+\((.+?)\)\s+@\s+(.+?)\s+---',
    'sonarqube_result': r'ANALYSIS\s+SUCCESSFUL.*Quality\s+Gate\s+(passed|FAILED)'
}
```

The parsing engine processes each log line to extract timestamps, log levels, build steps, error messages, and tool-specific outputs, etc. (this is just a sample example). It handles edge cases like multi-line errors, inconsistent timestamp formats, and varying log formats from different CI/CD tools.

<br>

#### Elasticsearch Document Warehouse

The final Elasticsearch document contains structured data including parsed log entries organized by type and timestamp, identified build steps with success/failure status, extracted error messages with severity classifications, and calculated metrics such as deployment duration and error rates. Elasticsearch was chosen as our document store because it enables fast dashboard generation and provides powerful search capabilities for developers to query deployment logs.

<br>

---

This distributed log parsing infrastructure transforms unstructured CI/CD logs into actionable intelligence through a three-component architecture: Airflow producers for reliable collection, Kafka-Spark consumers for scalable processing, and regex-based processors for data structuring. The system handles enterprise-scale deployment volumes while maintaining fault tolerance and enables insights into DevOps deployment data, training ML models, generating DORA metrics, and powering developer AI tools.

<br>

– Aditya


<br><br><br>
