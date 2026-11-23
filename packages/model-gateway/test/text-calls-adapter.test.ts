import { describe, expect, it } from "vitest";
import type { ModelRequest, StreamEvent } from "@forge/protocol";
import { Gateway, type FetchLike } from "../src";

const enc = new TextEncoder();
const NL = String.fromCharCode(10);
const chunk = (o: unknown) => `data: ${JSON.stringify(o)}${NL}${NL}`;
const text = (...pieces: string[]) => [...pieces.map((p) => chunk({ choices: [{ delta: { content: p } }] })), chunk({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } })];
const response = (chunks: string[]) => new Response(new ReadableStream<Uint8Array>({ start: (c) => (chunks.forEach((x) => c.enqueue(enc.encode(x))), c.close()) }), { status: 200 });

const tools: ModelRequest["tools"] = [
  { name: "read_file", description: "r", parameters: { type: "object" }, class: "read" },
  { name: "edit_file", description: "e", parameters: { type: "object" }, class: "write" },
];

async function run(chunks: string[], withTools = true): Promise<StreamEvent[]> {
  const gw = new Gateway({ fetch: (async () => response(chunks)) as FetchLike });
  gw.register("local", { kind: "ollama" });
  const out: StreamEvent[] = [];
  for await (const ev of gw.stream({ provider: "local", model: "qwen2.5-coder:7b", messages: [{ role: "user", content: "hi" }], tools: withTools ? tools : undefined })) out.push(ev);
  return out;
}
const texts = (events: StreamEvent[]) => events.filter((e): e is Extract<StreamEvent, { type: "text" }> => e.type === "text").map((e) => e.delta);
const calls = (events: StreamEvent[]) => events.filter((e): e is Extract<StreamEvent, { type: "tool_call" }> => e.type === "tool_call").map((e) => e.call);

describe("tool calls a local model wrote as text", () => {
  it("become tool calls, with no text shown (what qwen2.5-coder:7b actually sends)", async () => {
    const events = await run(text('{"name": "edit_file", "arguments": {"path": "utils.ts", "old_string": "add(", "new_string": "sum(", "reason": "rename"}}'));
    expect(texts(events)).toEqual([]);
    expect(calls(events)).toEqual([{ id: "call_text_1", name: "edit_file", args: { path: "utils.ts", old_string: "add(", new_string: "sum(", reason: "rename" } }]);
    expect(events.at(-1)!.type).toBe("done");
  });

  it("are found even when the JSON arrives in many small pieces", async () => {
    const events = await run(text("{", '"na', 'me": "read_', 'file", "argu', 'ments": {"pa', 'th": "math.ts"}', "}"));
    expect(calls(events)).toEqual([{ id: "call_text_1", name: "read_file", args: { path: "math.ts" } }]);
    expect(texts(events)).toEqual([]);
  });

  it("are found inside a code fence or <tool_call> tags", async () => {
    expect(calls(await run(text("```json", NL, '{"name":"read_file","arguments":{"path":"a.ts"}}', NL, "```")))).toHaveLength(1);
    expect(calls(await run(text("<tool_call>", NL, '{"name":"read_file","arguments":{"path":"a.ts"}}', NL, "</tool_call>")))).toHaveLength(1);
  });

  it("stay plain text when the tool was not offered (the model invented it): the loop sees what it said", async () => {
    const json = '{"name": "rename_function", "arguments": {"module": "utils"}}';
    const events = await run(text(json));
    expect(calls(events)).toEqual([]);
    expect(texts(events).join("")).toBe(json);
  });

  it("stay plain text when there are no tools at all, or when the reply is prose or code", async () => {
    const json = '{"name": "read_file", "arguments": {"path": "a.ts"}}';
    expect(calls(await run(text(json), false))).toEqual([]);
    expect(texts(await run(text(json), false)).join("")).toBe(json);
    const code = "```ts\nconst a = 1;\n```";
    const events = await run(text(code));
    expect(calls(events)).toEqual([]);
    expect(texts(events).join("")).toBe(code); // held back, then released unchanged
    expect(texts(await run(text("I will read it: ", json))).join("")).toBe(`I will read it: ${json}`);
  });

  it("do not delay ordinary answers: prose streams piece by piece as it arrives", async () => {
    const events = await run(text("The function ", "returns ", "x * 2."));
    expect(texts(events)).toEqual(["The function ", "returns ", "x * 2."]);
  });

  it("keep the text when the model also sent a proper structured call", async () => {
    const proper = [chunk({ choices: [{ delta: { content: '{"note": "reading"}' } }] }), chunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read_file", arguments: '{"path":"a.ts"}' } }] } }] }), chunk({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } })];
    const events = await run(proper);
    expect(calls(events)).toEqual([{ id: "c1", name: "read_file", args: { path: "a.ts" } }]);
    expect(texts(events).join("")).toBe('{"note": "reading"}');
  });

  it("do not change the usage that is reported", async () => {
    const events = await run(text('{"name":"read_file","arguments":{}}'));
    expect((events.at(-1) as Extract<StreamEvent, { type: "done" }>).usage).toMatchObject({ inputTokens: 10, outputTokens: 5 });
  });
});
