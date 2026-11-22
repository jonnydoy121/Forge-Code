// Turn tool output into structured errors instead of dumping raw logs into the model's context.

export interface StructuredError {
  file?: string;
  line?: number;
  col?: number;
  /** lint rule id, TS code, or similar */
  rule?: string;
  /** failing test name */
  test?: string;
  message: string;
  stack?: string;
  severity: "error" | "warning";
}

const MAX_MESSAGE = 400;
const MAX_STACK = 600;
export const MAX_ERRORS = 40;

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
export const stripAnsi = (s: string) => s.replace(ANSI, "");

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);
const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");

function mk(partial: Partial<StructuredError> & { message: string }): StructuredError {
  return { severity: "error", ...partial, message: clip(partial.message.trim(), MAX_MESSAGE), file: partial.file ? norm(partial.file) : undefined, stack: partial.stack ? clip(partial.stack, MAX_STACK) : undefined };
}

// ---- individual formats ----

/** tsc: src/a.ts(12,5): error TS2322: ...   or   src/a.ts:12:5 - error TS2322: ... */
function parseTsc(lines: string[]): StructuredError[] {
  const out: StructuredError[] = [];
  const a = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.*)$/;
  const b = /^(.+?):(\d+):(\d+)\s+-\s+(error|warning)\s+(TS\d+):\s+(.*)$/;
  for (const l of lines) {
    const m = a.exec(l) ?? b.exec(l);
    if (m) out.push(mk({ file: m[1], line: +m[2]!, col: +m[3]!, severity: m[4] as "error" | "warning", rule: m[5], message: m[6]! }));
  }
  return out;
}

/** eslint stylish: a file path line followed by "  12:5  error  message  rule-id" */
function parseEslint(lines: string[]): StructuredError[] {
  const out: StructuredError[] = [];
  let file: string | undefined;
  const item = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.*?)\s{2,}([@\w\-/]+)\s*$/;
  for (const l of lines) {
    if (/^\S.*\.(?:[cm]?[jt]sx?|vue|svelte)$/.test(l.trim()) && !/^\s/.test(l)) file = l.trim();
    const m = item.exec(l);
    if (m && file) out.push(mk({ file, line: +m[1]!, col: +m[2]!, severity: m[3] as "error" | "warning", message: m[4]!, rule: m[5] }));
  }
  return out;
}

/** ruff / flake8 / pylint-ish and generic compilers: file:line:col: CODE message */
function parseColonStyle(lines: string[]): StructuredError[] {
  const out: StructuredError[] = [];
  const re = /^(\S+?\.(?:py|go|c|cc|cpp|h|hpp|cs|java|rs|js|ts)):(\d+):(?:(\d+):)?\s*(?:(error|warning)[:\s]+)?(?:([A-Z]{1,4}\d{2,5})\s+)?(.+)$/;
  for (const l of lines) {
    if (/^\s*(at |File ")/.test(l)) continue;
    const m = re.exec(l);
    if (m) out.push(mk({ file: m[1], line: +m[2]!, col: m[3] ? +m[3] : undefined, severity: m[4] === "warning" ? "warning" : "error", rule: m[5], message: m[6]! }));
  }
  return out;
}

/** cargo / rustc: error[E0425]: msg \n  --> src/main.rs:5:9 */
function parseCargo(lines: string[]): StructuredError[] {
  const out: StructuredError[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(error|warning)(?:\[(\w+)\])?:\s+(.*)$/.exec(lines[i]!);
    if (!m || /^(aborting|could not compile|build failed)/.test(m[3]!)) continue;
    const loc = /^\s*-->\s+(.+?):(\d+):(\d+)/.exec(lines[i + 1] ?? "");
    out.push(mk({ severity: m[1] as "error" | "warning", rule: m[2], message: m[3]!, file: loc?.[1], line: loc ? +loc[2]! : undefined, col: loc ? +loc[3]! : undefined }));
  }
  return out;
}

/** pytest: "FAILED tests/test_a.py::test_x - AssertionError: assert 1 == 2" plus "tests/test_a.py:12: AssertionError" */
function parsePytest(lines: string[]): StructuredError[] {
  const out: StructuredError[] = [];
  const loc = new Map<string, { line: number }>();
  for (const l of lines) {
    const m = /^(\S+\.py):(\d+):\s+(\w+(?:Error|Exception)?.*)$/.exec(l);
    if (m) loc.set(m[1]!, { line: +m[2]! });
  }
  for (const l of lines) {
    const m = /^FAILED\s+(\S+?)::(\S+)(?:\s+-\s+(.*))?$/.exec(l);
    if (m) out.push(mk({ file: m[1], test: m[2], line: loc.get(m[1]!)?.line, message: m[3] ?? "test failed" }));
  }
  return out;
}

/** vitest / jest: " FAIL  path/x.test.ts > suite > name" or "✗/× name", then "AssertionError: ..." and "❯ file:line:col" */
function parseJsTests(lines: string[]): StructuredError[] {
  const out: StructuredError[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(?:FAIL|✗|×|✕|❯)\s+(\S+\.(?:test|spec)\.[cm]?[jt]sx?)(?:\s+[>›]\s+(.*?))?(?:\s+\d+ms)?\s*$/.exec(lines[i]!);
    if (!m) continue;
    let message = "";
    let line: number | undefined;
    let stack = "";
    for (let j = i + 1; j < Math.min(lines.length, i + 25); j++) {
      const l = lines[j]!;
      if (/^\s*(?:FAIL|✗|×|✕)\s/.test(l)) break;
      if (!message) {
        const e = /^\s*(?:Assertion|Type|Reference|Range)?Error:\s*(.*)$/.exec(l) ?? /^\s*(expected .*)$/i.exec(l);
        if (e) message = e[1] ?? l.trim();
      }
      const at = new RegExp(`${m[1]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:(\\d+):(\\d+)`).exec(l);
      if (at && line === undefined) line = +at[1]!;
      if (/^\s*(at |❯ )/.test(l) && stack.length < MAX_STACK) stack += l.trim() + "\n";
    }
    out.push(mk({ file: m[1], test: m[2], line, message: message || "test failed", stack: stack.trim() || undefined }));
  }
  return out;
}

/** node:test TAP-ish ("not ok 1 - name" + yaml with "error:" and "location:") */
function parseNodeTest(lines: string[]): StructuredError[] {
  const out: StructuredError[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*not ok \d+ - (.*)$/.exec(lines[i]!);
    if (!m) continue;
    let message = "";
    let file: string | undefined;
    let line: number | undefined;
    for (let j = i + 1; j < Math.min(lines.length, i + 30); j++) {
      const l = lines[j]!;
      if (/^\s*(?:not )?ok \d+ /.test(l)) break;
      const e = /^\s*error:\s*'?(.*?)'?$/.exec(l);
      if (e && !message) message = e[1]!;
      const loc = /^\s*location:\s*'?(.+?):(\d+):\d+'?\s*$/.exec(l);
      if (loc) {
        file = loc[1]!.replace(/^file:\/\/\/?/, "");
        line = +loc[2]!;
      }
      const ex = /^\s*(expected|actual):\s*(.*)$/.exec(l);
      if (ex && message && !message.includes(ex[1]!)) message += ` (${ex[1]}: ${ex[2]})`;
    }
    out.push(mk({ test: m[1], file, line, message: message || "test failed" }));
  }
  return out;
}

/** node:test "spec" reporter (the default when not a TTY): "test at file:line:col" then "✖ name" and the assertion error. */
function parseNodeSpec(lines: string[]): StructuredError[] {
  const out: StructuredError[] = [];
  for (let i = 0; i < lines.length; i++) {
    const at = /^test at (.+?):(\d+):\d+\s*$/.exec(lines[i]!);
    if (!at) continue;
    const name = /^✖\s+(.*?)(?:\s+\([\d.]+ms\))?\s*$/.exec(lines[i + 1] ?? "")?.[1];
    if (!name) continue;
    let message = "";
    let detail = "";
    let actual: string | undefined;
    let expected: string | undefined;
    let stack = "";
    for (let j = i + 2; j < Math.min(lines.length, i + 40); j++) {
      const l = lines[j]!;
      if (/^test at /.test(l) || /^✖ /.test(l)) break;
      const e = /^\s+(?:\w+)?Error(?:\s+\[\w+\])?:\s*(.*)$/.exec(l);
      if (e && !message) message = e[1]!.replace(/:\s*$/, "");
      else if (message && !detail && /\S/.test(l) && !/^\s+at /.test(l) && !/^\s+\w+:/.test(l)) detail = l.trim();
      const a = /^\s+actual:\s*(.*?),?\s*$/.exec(l);
      if (a) actual = a[1];
      const x = /^\s+expected:\s*(.*?),?\s*$/.exec(l);
      if (x) expected = x[1];
      if (/^\s+at /.test(l) && stack.length < MAX_STACK) stack += l.trim() + "\n";
    }
    const loc = /([^\s()]+?\.[cm]?[jt]sx?):(\d+):(\d+)/.exec(stack);
    const parts = [message, detail].filter(Boolean).join(" ");
    const ae = actual !== undefined && expected !== undefined ? ` (actual ${actual}, expected ${expected})` : "";
    out.push(mk({ test: name, file: at[1], line: loc ? +loc[2]! : +at[2]!, message: (parts || "test failed") + ae, stack: stack.trim() || undefined }));
  }
  return out;
}

/** go test: "--- FAIL: TestX (0.00s)" then "    x_test.go:12: message" */
function parseGoTest(lines: string[]): StructuredError[] {
  const out: StructuredError[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*--- FAIL:\s+(\S+)/.exec(lines[i]!);
    if (!m) continue;
    const loc = /^\s+(\S+_test\.go):(\d+):\s*(.*)$/.exec(lines[i + 1] ?? "");
    out.push(mk({ test: m[1], file: loc?.[1], line: loc ? +loc[2]! : undefined, message: loc?.[3] || "test failed" }));
  }
  return out;
}

/** Python tracebacks that are not pytest: last "File ..., line N" and the exception line. */
function parseTraceback(lines: string[]): StructuredError[] {
  const idx = lines.findIndex((l) => l.startsWith("Traceback (most recent call last)"));
  if (idx < 0) return [];
  let file: string | undefined;
  let line: number | undefined;
  let msg = "";
  for (let i = idx + 1; i < lines.length; i++) {
    const f = /^\s+File "(.+?)", line (\d+)/.exec(lines[i]!);
    if (f) {
      file = f[1];
      line = +f[2]!;
    } else if (/^\w+(?:Error|Exception)\b/.test(lines[i]!)) {
      msg = lines[i]!;
      break;
    }
  }
  return msg ? [mk({ file, line, message: msg })] : [];
}

export interface ParseOptions {
  /** hint: which kind of check produced the output, to pick sensible parsers */
  kind?: "typecheck" | "lint" | "test" | "build" | "format";
}

const dedupe = (errs: StructuredError[]): StructuredError[] => {
  const seen = new Set<string>();
  return errs.filter((e) => {
    const k = `${e.file}|${e.line}|${e.col}|${e.rule}|${e.test}|${e.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

/**
 * Parse combined stdout+stderr into structured errors: deduplicated and capped. Unparseable failing output
 * yields no errors here; callers fall back to a truncated tail of the raw output.
 */
export function parseOutput(raw: string, opts: ParseOptions = {}): { errors: StructuredError[]; omitted: number } {
  const lines = stripAnsi(raw).split(/\r?\n/);
  const parsers = [parseTsc, parseEslint, parseCargo, parsePytest, parseJsTests, parseNodeTest, parseNodeSpec, parseGoTest, parseColonStyle, parseTraceback];
  let all: StructuredError[] = [];
  for (const p of parsers) {
    const r = p(lines);
    if (r.length) all = all.concat(r);
  }
  // colon-style also matches pytest/ts-like lines; prefer richer entries by dedupe on file+line+message prefix
  all = dedupe(all);
  const files = new Set(all.filter((e) => e.test).map((e) => `${e.file}:${e.line}`));
  all = all.filter((e) => e.test || !files.has(`${e.file}:${e.line}`)); // test failures supersede bare location lines
  void opts;
  const errors = all.filter((e) => e.severity === "error").concat(all.filter((e) => e.severity === "warning"));
  return { errors: errors.slice(0, MAX_ERRORS), omitted: Math.max(0, errors.length - MAX_ERRORS) };
}

/** Last N characters of output, for when nothing could be parsed. */
export function tail(raw: string, max = 1500): string {
  const s = stripAnsi(raw).trim();
  return s.length > max ? "…" + s.slice(-max) : s;
}

export function formatError(e: StructuredError): string {
  const loc = e.file ? `${e.file}${e.line ? `:${e.line}${e.col ? `:${e.col}` : ""}` : ""}` : "";
  const bits = [loc, e.rule ? `[${e.rule}]` : "", e.test ? `(${e.test})` : "", e.message].filter(Boolean);
  return bits.join(" ");
}
