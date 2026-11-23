import { useState, type ReactNode } from "react";
import { parseBlocks, type Block, type Inline } from "../lib/markdown";

function inline(nodes: Inline[]): ReactNode[] {
  return nodes.map((n, i) => {
    switch (n.type) {
      case "text":
        return n.text;
      case "code":
        return (
          <code key={i} className="rounded bg-[var(--hover)] px-1 py-0.5 font-mono text-[0.88em]">
            {n.text}
          </code>
        );
      case "bold":
        return <strong key={i}>{inline(n.children)}</strong>;
      case "italic":
        return <em key={i}>{inline(n.children)}</em>;
      case "link":
        // Shown as text with the address on hover. It never navigates: in a desktop window a link would replace the whole app.
        return (
          <span key={i} className="underline decoration-dotted underline-offset-2" title={n.url}>
            {n.text}
          </span>
        );
    }
  });
}

function CodeBlock({ lang, text, closed }: { lang: string; text: string; closed: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="overflow-hidden rounded border border-[var(--border)] bg-black/30" data-testid="code-block">
      <div className="flex items-center justify-between border-b border-[var(--border)] px-2 py-0.5 text-[11px] text-[var(--muted)]">
        <span>{lang || "code"}</span>
        {closed && (
          <button className="rounded px-1 hover:bg-[var(--hover)]" data-testid="copy-code" onClick={copy} aria-label="Copy code">
            {copied ? "Copied" : "Copy"}
          </button>
        )}
      </div>
      <pre className="overflow-auto p-2 font-mono text-xs leading-relaxed">
        <code>{text}</code>
      </pre>
    </div>
  );
}

function block(b: Block, i: number): ReactNode {
  switch (b.type) {
    case "code":
      return <CodeBlock key={i} lang={b.lang} text={b.text} closed={b.closed} />;
    case "heading":
      return (
        <div key={i} className={b.level === 1 ? "text-base font-semibold" : "text-sm font-semibold"} role="heading" aria-level={b.level + 2}>
          {inline(b.inline)}
        </div>
      );
    case "list": {
      const Tag = b.ordered ? "ol" : "ul";
      return (
        <Tag key={i} className={`${b.ordered ? "list-decimal" : "list-disc"} space-y-0.5 pl-5`}>
          {b.items.map((it, k) => (
            <li key={k}>{inline(it)}</li>
          ))}
        </Tag>
      );
    }
    case "para":
      return (
        <p key={i} className="whitespace-pre-wrap">
          {inline(b.inline)}
        </p>
      );
  }
}

/** A reply from the model, formatted. Built from React elements only: reply text is never inserted as HTML. */
export function Markdown({ text }: { text: string }) {
  return <div className="space-y-2">{parseBlocks(text).map(block)}</div>;
}
