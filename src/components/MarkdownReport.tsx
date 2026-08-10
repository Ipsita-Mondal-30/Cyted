"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function MarkdownReport({ content }: { content: string }) {
  return (
    <div className="prose-report max-w-none text-sm leading-relaxed text-zinc-300">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1 className="mb-4 mt-8 border-b border-zinc-800 pb-2 text-2xl font-semibold tracking-tight text-white first:mt-0">
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="mb-3 mt-8 text-xl font-semibold tracking-tight text-white">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="mb-2 mt-6 text-lg font-semibold text-zinc-100">
              {children}
            </h3>
          ),
          h4: ({ children }) => (
            <h4 className="mb-2 mt-4 text-base font-semibold text-zinc-100">
              {children}
            </h4>
          ),
          p: ({ children }) => (
            <p className="mb-3 text-zinc-300 leading-relaxed">{children}</p>
          ),
          strong: ({ children }) => (
            <strong className="font-semibold text-white">{children}</strong>
          ),
          em: ({ children }) => (
            <em className="italic text-zinc-200">{children}</em>
          ),
          ul: ({ children }) => (
            <ul className="mb-4 list-disc space-y-1.5 pl-5 text-zinc-300">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="mb-4 list-decimal space-y-1.5 pl-5 text-zinc-300">
              {children}
            </ol>
          ),
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
          a: ({ href, children }) => (
            <a
              href={href}
              className="text-emerald-400 underline underline-offset-2 hover:text-emerald-300"
              target="_blank"
              rel="noreferrer"
            >
              {children}
            </a>
          ),
          code: ({ children }) => (
            <code className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-xs text-emerald-300">
              {children}
            </code>
          ),
          pre: ({ children }) => (
            <pre className="mb-4 overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-950 p-3 text-xs text-zinc-200">
              {children}
            </pre>
          ),
          blockquote: ({ children }) => (
            <blockquote className="mb-4 border-l-2 border-emerald-600/60 pl-4 text-zinc-400">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-6 border-zinc-800" />,
          table: ({ children }) => (
            <div className="mb-4 overflow-x-auto">
              <table className="w-full min-w-[480px] border-collapse text-left text-sm">
                {children}
              </table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border-b border-zinc-700 px-2 py-2 font-medium text-zinc-200">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border-b border-zinc-800/80 px-2 py-2 text-zinc-300">
              {children}
            </td>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
