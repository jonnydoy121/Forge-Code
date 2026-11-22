import { isSecretPath, redactSecrets } from "@forge/protocol";
import type { ContextSection } from "@forge/agent-runtime";
import { htmlToText, renderDocHits, type DocsStore, type Memory, type RuleEngine } from "@forge/context-store";

/** What the developer attached to the next message (the chips under the input). */
export type Attachment =
  | { kind: "file"; arg: string }
  | { kind: "folder"; arg: string }
  | { kind: "symbol"; arg: string }
  | { kind: "docs"; arg: string }
  | { kind: "web"; arg: string }
  | { kind: "diff"; arg: "" }
  | { kind: "terminal"; arg: "" }
  | { kind: "rule"; arg: string }
  | { kind: "memory"; arg: string };

export const attachmentKey = (a: Attachment) => `${a.kind}:${a.arg}`;
export const attachmentLabel = (a: Attachment) => (a.kind === "file" || a.kind === "folder" ? `${a.kind === "folder" ? "📁 " : ""}${a.arg.split(/[\\/]/).pop()}` : a.kind === "diff" ? "git diff" : a.kind === "terminal" ? "terminal output" : `${a.kind}: ${a.arg}`);

export interface AttachmentBackends {
  readFile(path: string): Promise<string>;
  listDir(path: string): Promise<{ name: string; is_dir: boolean }[]>;
  symbol(name: string): Promise<{ file: string; line: number; end_line: number; signature: string }[]>;
  gitDiff(): Promise<string>;
  terminalText(): string;
  fetchText(url: string): Promise<string>;
  docs: DocsStore;
  rules: RuleEngine;
  memories(): Promise<Memory[]>;
  root: string;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "\n[truncated]" : s);

/** Turn an attachment into a context section. Anything fetched from outside is labelled untrusted data. */
export async function resolveAttachment(a: Attachment, b: AttachmentBackends, query: string): Promise<ContextSection | null> {
  const id = attachmentKey(a);
  const sec = (label: string, text: string): ContextSection => ({ id, label, text: redactSecrets(text), priority: 2 });
  switch (a.kind) {
    case "file":
      return isSecretPath(a.arg) ? null : sec(`Attached file ${a.arg}`, await b.readFile(a.arg));
    case "folder": {
      const entries = await b.listDir(a.arg);
      return sec(`Attached folder ${a.arg}`, entries.filter((e) => !isSecretPath(e.name)).map((e) => e.name + (e.is_dir ? "/" : "")).join("\n"));
    }
    case "symbol": {
      const hits = await b.symbol(a.arg);
      if (!hits.length) return sec(`Symbol ${a.arg}`, "not found in the index");
      const parts: string[] = [];
      for (const h of hits.slice(0, 3)) {
        const file = `${b.root}/${h.file}`;
        const lines = (await b.readFile(file)).split("\n").slice(h.line - 1, Math.min(h.end_line, h.line + 60));
        parts.push(`${h.file}:${h.line}\n${lines.join("\n")}`);
      }
      return sec(`Symbol ${a.arg}`, parts.join("\n\n"));
    }
    case "docs": {
      const r = await b.docs.search(a.arg, query || a.arg, 4);
      return r ? sec(`Docs: ${a.arg} (untrusted reference data)`, renderDocHits(r.set, r.hits)) : sec(`Docs: ${a.arg}`, "no docs indexed under this name");
    }
    case "web":
      return sec(`Web page ${a.arg} (untrusted data)`, clip(htmlToText(await b.fetchText(a.arg)), 6000));
    case "diff":
      return sec("Git diff", clip(await b.gitDiff(), 12_000));
    case "terminal":
      return sec("Terminal output", clip(b.terminalText(), 6000));
    case "rule": {
      const r = (await b.rules.load()).find((x) => x.name === a.arg);
      return r ? sec(`Rule ${r.name}`, r.text) : null;
    }
    case "memory": {
      const m = (await b.memories()).find((x) => x.name === a.arg);
      return m ? sec(`Memory ${m.name}`, m.body) : null;
    }
  }
}
