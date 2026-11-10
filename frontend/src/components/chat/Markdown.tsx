import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import CopyButton from "../console/CopyButton";

/* Raw HTML in model output is never rendered (react-markdown escapes it by default). */
const components: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ),
  pre: ({ children }) => {
    // fenced code block: <pre><code class="language-x">…</code></pre>
    const child = Array.isArray(children) ? children[0] : children;
    const props = (child as { props?: { className?: string; children?: unknown } } | undefined)?.props;
    const lang = /language-([\w-]+)/.exec(props?.className ?? "")?.[1];
    const text = String(props?.children ?? "").replace(/\n$/, "");
    return (
      <div className="md-code">
        <div className="md-code-head">
          <span className="mono">{lang ?? "code"}</span>
          <CopyButton text={text} compact />
        </div>
        <pre>{children}</pre>
      </div>
    );
  },
  table: ({ children }) => (
    <div className="md-table">
      <table>{children}</table>
    </div>
  ),
};

/** Formatted model reply: headings, lists, tables, code blocks, quotes, links. */
function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

export default memo(Markdown);
