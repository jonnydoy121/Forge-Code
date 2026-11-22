import { isIgnoredDir, isSecretPath, resolveInRoot, type TouchedFile } from "@forge/protocol";
import type { RegisteredTool } from "./index";

export interface EditOutcome {
  status: "pending" | "applied" | "conflict" | "noop";
  added: number;
  removed: number;
  checkpoint?: string;
  /** the file did not exist before this change */
  created?: boolean;
  /** why the change needs explicit developer approval even in auto-apply modes (suppressions, weakened tests) */
  warnings?: string[];
}

/** Where edits go. In the app this is the PendingChanges model; the tools never touch disk directly. */
export interface EditSink {
  /** Current content the agent should edit against: pending proposal if any, else disk. null = missing file. */
  read(path: string): Promise<string | null>;
  propose(path: string, proposed: string | null, reason: string): Promise<EditOutcome>;
}

const str = (v: unknown, name: string) => {
  if (typeof v !== "string") throw new Error(`missing required argument: ${name}`);
  return v;
};

function target(root: string, raw: unknown): string {
  const rel = str(raw, "path");
  if (!rel) throw new Error("missing required argument: path");
  const path = resolveInRoot(root, rel);
  if (isSecretPath(path)) throw new Error("refusing to modify a file that looks like it holds secrets");
  if (path.split("/").some((c) => isIgnoredDir(c))) throw new Error("refusing to modify files in ignored or generated directories");
  return path;
}

function describeOutcome(path: string, o: EditOutcome, root: string): { output: string; touched: TouchedFile[] } {
  return { output: describeText(path, o, root), touched: [{ path, created: o.created ?? false, applied: o.status === "applied" }] };
}

function describeText(path: string, o: EditOutcome, root: string): string {
  const rel = path.slice(root.replace(/\/+$/, "").length + 1);
  const delta = `+${o.added} -${o.removed}`;
  switch (o.status) {
    case "pending":
      if (o.warnings?.length) return `Proposed change to ${rel} (${delta}) but it is FLAGGED and needs the developer's explicit approval: it ${o.warnings.join("; ")}. Do not make checks pass by weakening tests or suppressing errors. Fix the underlying problem instead.`;
      return `Proposed change to ${rel} (${delta}). It is pending the developer's review and is not on disk yet; reading the file shows your proposed version.`;
    case "applied":
      return `Applied change to ${rel} (${delta}); checkpoint ${o.checkpoint ?? "saved"}.`;
    case "conflict":
      return `The change to ${rel} conflicts with edits the developer made; it was NOT applied and needs their resolution.`;
    case "noop":
      return `No change: ${rel} already has that content.`;
  }
}

const reasonProp = { reason: { type: "string", description: "One-line reason for this change, shown to the reviewer." } };

export function createEditTools(sink: EditSink): RegisteredTool[] {
  return [
    {
      spec: {
        name: "edit_file",
        description: "Replace an exact, unique occurrence of old_string with new_string in a file. Read the file first. Set replace_all to change every occurrence (e.g. a rename).",
        parameters: {
          type: "object",
          properties: { path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" }, replace_all: { type: "boolean" }, ...reasonProp },
          required: ["path", "old_string", "new_string"],
        },
        class: "write",
      },
      async run(args, ctx) {
        const path = target(ctx.root, args.path);
        const oldS = str(args.old_string, "old_string");
        const newS = str(args.new_string, "new_string");
        if (!oldS) throw new Error("old_string must not be empty; use write_file to create a file");
        const cur = await sink.read(path);
        if (cur === null) throw new Error(`file does not exist: ${args.path}. Use write_file to create it.`);
        const count = cur.split(oldS).length - 1;
        if (count === 0) throw new Error("old_string not found. Re-read the file and copy the text exactly, including whitespace.");
        if (count > 1 && args.replace_all !== true) throw new Error(`old_string matches ${count} places. Include more surrounding context, or set replace_all.`);
        const next = args.replace_all === true ? cur.split(oldS).join(newS) : cur.replace(oldS, () => newS);
        return describeOutcome(path, await sink.propose(path, next, typeof args.reason === "string" ? args.reason : ""), ctx.root);
      },
    },
    {
      spec: {
        name: "write_file",
        description: "Create a file or replace its entire content. Prefer edit_file for changes to existing files.",
        parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" }, ...reasonProp }, required: ["path", "content"] },
        class: "write",
      },
      async run(args, ctx) {
        const path = target(ctx.root, args.path);
        return describeOutcome(path, await sink.propose(path, str(args.content, "content"), typeof args.reason === "string" ? args.reason : ""), ctx.root);
      },
    },
    {
      spec: {
        name: "delete_file",
        description: "Delete a file.",
        parameters: { type: "object", properties: { path: { type: "string" }, ...reasonProp }, required: ["path"] },
        class: "write",
      },
      async run(args, ctx) {
        const path = target(ctx.root, args.path);
        if ((await sink.read(path)) === null) throw new Error(`file does not exist: ${args.path}`);
        return describeOutcome(path, await sink.propose(path, null, typeof args.reason === "string" ? args.reason : ""), ctx.root);
      },
    },
  ];
}
