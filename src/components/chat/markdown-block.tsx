'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Markdown 渲染块
 * 使用 react-markdown + remark-gfm，自定义样式适配聊天气泡。
 */
export default function MarkdownBlock({ content }: { content: string }) {
  return (
    <div className="markdown-body text-sm leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="my-1.5 first:mt-0 last:mb-0">{children}</p>,
          h1: ({ children }) => <h1 className="text-lg font-bold my-2 first:mt-0">{children}</h1>,
          h2: ({ children }) => <h2 className="text-base font-bold my-2 first:mt-0">{children}</h2>,
          h3: ({ children }) => <h3 className="text-sm font-bold my-1.5">{children}</h3>,
          ul: ({ children }) => <ul className="list-disc pl-5 my-1.5 space-y-0.5">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal pl-5 my-1.5 space-y-0.5">{children}</ol>,
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
          code: ({ children, className }) => {
            const isInline = !className;
            if (isInline) {
              return (
                <code className="px-1 py-0.5 rounded bg-black/5 font-mono text-[0.85em]">
                  {children}
                </code>
              );
            }
            return (
              <pre className="my-2 p-2.5 rounded-lg bg-gray-900 text-gray-100 overflow-x-auto text-xs leading-relaxed">
                <code className={className}>{children}</code>
              </pre>
            );
          },
          pre: ({ children }) => <>{children}</>,
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-gray-300 pl-3 my-1.5 text-gray-500 italic">
              {children}
            </blockquote>
          ),
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noreferrer" className="text-blue-600 underline hover:text-blue-700">
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className="overflow-x-auto my-2">
              <table className="text-xs border-collapse w-full">{children}</table>
            </div>
          ),
          th: ({ children }) => <th className="border border-gray-300 px-2 py-1 text-left font-semibold bg-gray-50">{children}</th>,
          td: ({ children }) => <td className="border border-gray-300 px-2 py-1">{children}</td>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
