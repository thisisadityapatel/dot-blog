import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { loadBlogPost } from '../utils/blogLoader';
import './BlogPost.css';

function CodeBlock({ language, children, theme }) {
  const [copied, setCopied] = useState(false);
  const code = String(children).replace(/\n$/, '');

  function handleCopy() {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div className="code-block-wrapper" data-theme={theme}>
      <button className="copy-button" onClick={handleCopy}>
        {copied ? 'Copied!' : 'Copy'}
      </button>
      <SyntaxHighlighter
        style={theme === 'dark' ? vscDarkPlus : oneLight}
        language={language}
        PreTag="div"
        customStyle={{ borderRadius: '8px', overflow: 'hidden', fontSize: '0.85rem' }}
        codeTagProps={{ style: { fontSize: 'inherit' } }}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  );
}

function BlogPost({ theme }) {
  const { slug } = useParams();
  const [post, setPost] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchPost() {
      setLoading(true);
      // Load only the specific blog post needed
      const foundPost = await loadBlogPost(slug);
      setPost(foundPost);
      setLoading(false);
    }
    fetchPost();
  }, [slug]);

  if (loading) {
    return <div>Loading...</div>;
  }

  if (!post) {
    return <div>Post not found</div>;
  }

  return (
    <div className="blog-post">
      <Link to="/" className="back-link">← Back to all posts</Link>
      <div className="blog-content">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeRaw]}
          components={{
            code({ node, inline, className, children, ...props }) {
              const match = /language-(\w+)/.exec(className || '');
              return !inline && match ? (
                <CodeBlock language={match[1]} theme={theme}>{children}</CodeBlock>
              ) : (
                <code className={className} {...props}>
                  {children}
                </code>
              );
            }
          }}
        >
          {post.content}
        </ReactMarkdown>
      </div>
    </div>
  );
}

export default BlogPost;
