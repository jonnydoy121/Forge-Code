import { describe, expect, it } from "vitest";
import { DiagnosticsTracker, shadowUri, type DocClient, type OpenDoc } from "./diagnosticsTracker";
import type { Diagnostic } from "./lspClient";

const err = (message: string, line = 0): Diagnostic => ({ range: { start: { line, character: 0 }, end: { line, character: 1 } }, severity: 1, message });
const URI = "file:///C:/ws/src/a.ts";

/** A fake language server: records what it is told and answers each didOpen with the diagnostics `reply` gives for that text. */
function fakeServer(tracker: DiagnosticsTracker, reply: (text: string) => Diagnostic[], delayMs = 1) {
  const calls: string[] = [];
  const uris: string[] = [];
  const client: DocClient = {
    openDocument: (uri, _lang, version, text) => {
      uris.push(uri);
      calls.push(`open v${version} ${JSON.stringify(text)}`);
      setTimeout(() => tracker.publish(uri, reply(text)), delayMs);
    },
    closeDocument: () => {
      calls.push("close");
    },
  };
  return { client, calls, uris };
}

describe("DiagnosticsTracker.check", () => {
  it("opens a file the editor does not have, waits for the server, and closes it again", async () => {
    const t = new DiagnosticsTracker(500, 10);
    const { client, calls } = fakeServer(t, (text) => (text.includes("bad") ? [err("Cannot find name 'bad'")] : []));
    const r = await t.check(URI, "typescript", "bad();", client, () => undefined);
    expect(r).toEqual({ status: "ok", diagnostics: [err("Cannot find name 'bad'")] });
    expect(calls).toEqual(['open v1 "bad();"', "close"]);
    expect(await t.check(URI, "typescript", "ok();", client, () => undefined)).toEqual({ status: "ok", diagnostics: [] });
  });

  it("uses the live diagnostics when the editor has exactly this text open, without touching the server", async () => {
    const t = new DiagnosticsTracker(500, 10);
    const { client, calls } = fakeServer(t, () => []);
    t.publish(URI, [err("live problem")]);
    const open: OpenDoc = { language: "typescript", version: 7, text: "same" };
    expect(await t.check(URI, "typescript", "same", client, () => open)).toEqual({ status: "ok", diagnostics: [err("live problem")] });
    expect(calls).toEqual([]);
  });

  it("probes different text for an open file under a shadow uri, leaving the editor's own document alone", async () => {
    const t = new DiagnosticsTracker(500, 10);
    const { client, calls, uris } = fakeServer(t, () => [err("pending edit is broken")]);
    const open: OpenDoc = { language: "typescript", version: 7, text: "disk text" };
    const r = await t.check(URI, "typescript", "pending text", client, () => open);
    expect(r).toEqual({ status: "ok", diagnostics: [err("pending edit is broken")] });
    expect(calls).toEqual(['open v1 "pending text"', "close"]); // no close/reopen of the real document, so its versions never go backwards
    expect(uris).toEqual(["file:///C:/ws/src/a.forge-check.ts"]);
  });

  it("shadow uris sit beside the file and keep its extension", () => {
    expect(shadowUri("file:///C:/ws/src/a.ts")).toBe("file:///C:/ws/src/a.forge-check.ts");
    expect(shadowUri("file:///ws/pkg/mod.py")).toBe("file:///ws/pkg/mod.forge-check.py");
    expect(shadowUri("file:///ws/Makefile")).toBe("file:///ws/Makefile.forge-check");
    expect(shadowUri("file:///ws/.eslintrc")).toBe("file:///ws/.eslintrc.forge-check");
  });

  it("a probe never disturbs what the editor sees for the real file", async () => {
    const t = new DiagnosticsTracker(500, 10);
    const { client } = fakeServer(t, () => [err("probe only")]);
    t.publish(URI, [err("editor's own")]);
    await t.check(URI, "typescript", "different", client, () => ({ language: "typescript", version: 3, text: "editor text" }));
    const open: OpenDoc = { language: "typescript", version: 3, text: "editor text" };
    expect(await t.check(URI, "typescript", "editor text", client, () => open)).toEqual({ status: "ok", diagnostics: [err("editor's own")] });
  });

  it("keeps probe results away from the editor but lets everything else through", async () => {
    const t = new DiagnosticsTracker(500, 10);
    const shown: string[] = [];
    const orig = t.publish.bind(t);
    t.publish = (uri, d) => {
      const visible = orig(uri, d);
      if (visible) shown.push(`${uri}:${d.length}`);
      return visible;
    };
    const { client } = fakeServer(t, () => [err("probe")]);
    await t.check(URI, "typescript", "x", client, () => undefined);
    expect(shown).toEqual([]); // hidden while probing
    t.publish(URI, [err("later")]);
    expect(shown).toEqual([`${URI}:1`]); // and visible again afterwards
  });

  it("waits for the server to go quiet, so a second round of diagnostics is not missed", async () => {
    const t = new DiagnosticsTracker(500, 30);
    const client: DocClient = {
      openDocument: (uri) => {
        setTimeout(() => t.publish(uri, [err("syntax")]), 1);
        setTimeout(() => t.publish(uri, [err("syntax"), err("type error", 3)]), 15);
      },
      closeDocument: () => {},
    };
    const r = await t.check(URI, "typescript", "x", client, () => undefined);
    expect(r.status === "ok" && r.diagnostics.map((d) => d.message)).toEqual(["syntax", "type error"]);
  });

  it("times out when the server never answers", async () => {
    const t = new DiagnosticsTracker(40, 10);
    const client: DocClient = { openDocument: () => {}, closeDocument: () => {} };
    expect(await t.check(URI, "typescript", "x", client, () => undefined)).toEqual({ status: "timeout" });
  });

  it("matches the file whichever way the server spells its uri (drive letter case, encoded colon)", async () => {
    const t = new DiagnosticsTracker(500, 10);
    const client: DocClient = {
      openDocument: () => setTimeout(() => t.publish("file:///c%3A/ws/src/a.forge-check.ts", [err("found it")]), 1),
      closeDocument: () => {},
    };
    const r = await t.check("file:///C:/ws/src/a.ts", "typescript", "x", client, () => undefined);
    expect(r).toEqual({ status: "ok", diagnostics: [err("found it")] });
  });

  it("runs checks of the same file one after the other", async () => {
    const t = new DiagnosticsTracker(500, 10);
    const { client, calls } = fakeServer(t, (text) => [err(text)], 5);
    const [a, b] = await Promise.all([t.check(URI, "typescript", "first", client, () => undefined), t.check(URI, "typescript", "second", client, () => undefined)]);
    expect(a.status === "ok" && a.diagnostics[0]!.message).toBe("first");
    expect(b.status === "ok" && b.diagnostics[0]!.message).toBe("second");
    expect(calls).toEqual(['open v1 "first"', "close", 'open v1 "second"', "close"]);
  });
});
