import { describe, expect, it } from "vitest";
import { LspClient, type Transport } from "./lspClient";
import { filterCommands, matchesKeybinding, type Command } from "./commands";
import { initialTabs, tabsReducer } from "./tabs";
import { languageForPath, normalizeUri, pathToUri } from "./uri";

function fakeTransport() {
  const sent: { id: number; method?: string; result?: unknown }[] = [];
  let handler: (m: string) => void = () => {};
  const t: Transport = { send: (m) => sent.push(JSON.parse(m)), onMessage: (h) => (handler = h) };
  return { t, sent, deliver: (o: unknown) => handler(JSON.stringify(o)), deliverRaw: (s: string) => handler(s) };
}

describe("LspClient", () => {
  it("correlates responses to requests and sends initialized after initialize", async () => {
    const f = fakeTransport();
    const c = new LspClient(f.t);
    const p = c.initialize("file:///w");
    expect(f.sent[0]!.method).toBe("initialize");
    f.deliver({ jsonrpc: "2.0", id: f.sent[0]!.id, result: { capabilities: {} } });
    await expect(p).resolves.toEqual({ capabilities: {} });
    expect(f.sent[1]!.method).toBe("initialized");
  });

  it("rejects on error responses", async () => {
    const f = fakeTransport();
    const p = new LspClient(f.t).request("x");
    f.deliver({ id: f.sent[0]!.id, error: { message: "boom" } });
    await expect(p).rejects.toThrow("boom");
  });

  it("dispatches publishDiagnostics", () => {
    const f = fakeTransport();
    const c = new LspClient(f.t);
    const got: string[] = [];
    c.onDiagnostics((p) => got.push(`${p.uri}:${p.diagnostics.length}`));
    f.deliver({ method: "textDocument/publishDiagnostics", params: { uri: "file:///a", diagnostics: [{ message: "m", range: {} }] } });
    expect(got).toEqual(["file:///a:1"]);
  });

  it("answers server requests so the server never stalls", () => {
    const f = fakeTransport();
    new LspClient(f.t);
    f.deliver({ id: 7, method: "workspace/configuration", params: { items: [{}, {}] } });
    f.deliver({ id: 8, method: "client/registerCapability", params: {} });
    expect(f.sent[0]).toMatchObject({ id: 7, result: [null, null] });
    expect(f.sent[1]).toMatchObject({ id: 8, result: null });
  });

  it("ignores malformed frames", () => {
    const f = fakeTransport();
    new LspClient(f.t);
    expect(() => f.deliverRaw("not json {")).not.toThrow();
  });
});

describe("uri helpers", () => {
  it("converts windows and posix paths", () => {
    expect(pathToUri("C:\\a b\\c.ts")).toBe("file:///C:/a%20b/c.ts");
    expect(pathToUri("/home/u/c.ts")).toBe("file:///home/u/c.ts");
  });
  it("normalizes encoded colons and drive case", () => {
    expect(normalizeUri("file:///c%3A/a/b.ts")).toBe(normalizeUri(pathToUri("C:\\a\\b.ts")));
  });
  it("maps extensions to languages", () => {
    expect(languageForPath("x/y.tsx")).toBe("typescriptreact");
    expect(languageForPath("a.py")).toBe("python");
    expect(languageForPath("LICENSE")).toBe("plaintext");
  });
});

describe("tabsReducer", () => {
  it("opens, dedupes, and activates", () => {
    let s = tabsReducer(initialTabs, { type: "open", path: "/a/x.ts" });
    s = tabsReducer(s, { type: "open", path: "/a/y.ts" });
    s = tabsReducer(s, { type: "open", path: "/a/x.ts" });
    expect(s.tabs.map((t) => t.name)).toEqual(["x.ts", "y.ts"]);
    expect(s.active).toBe("/a/x.ts");
  });
  it("closing the active tab activates a neighbour, last close clears", () => {
    let s = tabsReducer(initialTabs, { type: "open", path: "a" });
    s = tabsReducer(s, { type: "open", path: "b" });
    s = tabsReducer(s, { type: "close", path: "b" });
    expect(s.active).toBe("a");
    s = tabsReducer(s, { type: "close", path: "a" });
    expect(s.active).toBeNull();
  });
  it("tracks dirty state", () => {
    let s = tabsReducer(initialTabs, { type: "open", path: "a" });
    s = tabsReducer(s, { type: "dirty", path: "a", dirty: true });
    expect(s.tabs[0]?.dirty).toBe(true);
  });
});

describe("command palette helpers", () => {
  const cmds: Command[] = ["Open Folder", "Save File", "Toggle Terminal", "Toggle Theme"].map((title) => ({ id: title, title, run: () => {} }));
  it("filters fuzzily and ranks word starts", () => {
    expect(filterCommands(cmds, "tt").map((c) => c.title).sort()).toEqual(["Toggle Terminal", "Toggle Theme"]);
    expect(filterCommands(cmds, "zzz")).toEqual([]);
    expect(filterCommands(cmds, "")).toHaveLength(4);
  });
  it("matches keybindings with Ctrl or Cmd", () => {
    const ev = { key: "P", ctrlKey: false, metaKey: true, shiftKey: true, altKey: false };
    expect(matchesKeybinding(ev, "Ctrl+Shift+P")).toBe(true);
    expect(matchesKeybinding({ ...ev, shiftKey: false }, "Ctrl+Shift+P")).toBe(false);
  });
});
