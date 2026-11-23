import { describe, expect, it } from "vitest";
import { mayBeTextToolCall, recoverToolCalls } from "../src";

const NAMES = ["edit_file", "read_file", "grep"];

describe("recoverToolCalls", () => {
  it("reads the flat form models write: name and arguments", () => {
    expect(recoverToolCalls('{"name": "read_file", "arguments": {"path": "math.ts"}}', NAMES)).toEqual([{ id: "call_text_1", name: "read_file", args: { path: "math.ts" } }]);
    expect(recoverToolCalls('{ "name": "edit_file", "arguments": { "path": "a.ts", "old_string": "x", "new_string": "y" } }', NAMES)![0]!.args).toEqual({ path: "a.ts", old_string: "x", new_string: "y" });
  });

  it("accepts the other spellings: parameters, args, input, arguments as a JSON string, and the OpenAI function form", () => {
    expect(recoverToolCalls('{"name":"grep","parameters":{"pattern":"x"}}', NAMES)![0]!.args).toEqual({ pattern: "x" });
    expect(recoverToolCalls('{"name":"grep","args":{"pattern":"x"}}', NAMES)![0]!.args).toEqual({ pattern: "x" });
    expect(recoverToolCalls('{"name":"grep","input":{"pattern":"x"}}', NAMES)![0]!.args).toEqual({ pattern: "x" });
    expect(recoverToolCalls('{"name":"grep","arguments":"{\\"pattern\\":\\"x\\"}"}', NAMES)![0]!.args).toEqual({ pattern: "x" });
    expect(recoverToolCalls('{"type":"function","function":{"name":"grep","arguments":{"pattern":"x"}}}', NAMES)![0]!.name).toBe("grep");
    expect(recoverToolCalls('{"name":"ls"}'.replace("ls", "grep"), NAMES)![0]!.args).toEqual({}); // no arguments is an empty object
  });

  it("unwraps a code fence and <tool_call> tags", () => {
    expect(recoverToolCalls('```json\n{"name":"read_file","arguments":{"path":"a.ts"}}\n```', NAMES)).toHaveLength(1);
    expect(recoverToolCalls('<tool_call>\n{"name":"read_file","arguments":{"path":"a.ts"}}\n</tool_call>', NAMES)).toHaveLength(1);
  });

  it("reads several calls: an array, or one after another", () => {
    const two = '[{"name":"read_file","arguments":{"path":"a.ts"}},{"name":"grep","arguments":{"pattern":"x"}}]';
    expect(recoverToolCalls(two, NAMES)!.map((c) => c.name)).toEqual(["read_file", "grep"]);
    const tags = '<tool_call>{"name":"read_file","arguments":{"path":"a"}}</tool_call>\n<tool_call>{"name":"read_file","arguments":{"path":"b"}}</tool_call>';
    expect(recoverToolCalls(tags, NAMES)!.map((c) => [c.id, c.args.path])).toEqual([["call_text_1", "a"], ["call_text_2", "b"]]);
  });

  it("keeps braces and quotes inside string arguments intact", () => {
    const text = JSON.stringify({ name: "edit_file", arguments: { path: "a.ts", old_string: 'if (x) { return "}"; }', new_string: "y" } });
    expect(recoverToolCalls(text, NAMES)![0]!.args.old_string).toBe('if (x) { return "}"; }');
  });

  it("does NOT treat a call to a tool that was not offered as a call (the model invented it)", () => {
    expect(recoverToolCalls('{"name": "rename_function", "arguments": {"module": "utils"}}', NAMES)).toBeNull();
    expect(recoverToolCalls('{"name":"read_file","arguments":{}}', [])).toBeNull();
  });

  it("does NOT treat prose, prose around JSON, or a JSON answer that is not a call as calls", () => {
    expect(recoverToolCalls("The function returns x * 2.", NAMES)).toBeNull();
    expect(recoverToolCalls('I will read it: {"name":"read_file","arguments":{"path":"a.ts"}}', NAMES)).toBeNull();
    expect(recoverToolCalls('{"name":"read_file","arguments":{"path":"a.ts"}} and then I will edit it', NAMES)).toBeNull();
    expect(recoverToolCalls('{"result": 42, "ok": true}', NAMES)).toBeNull();
    expect(recoverToolCalls('{"name": "read_file"', NAMES)).toBeNull(); // cut off
    expect(recoverToolCalls('{"name":"read_file","arguments":"not json"}', NAMES)).toBeNull();
    expect(recoverToolCalls('{"name":"read_file","arguments":[1,2]}', NAMES)).toBeNull();
    expect(recoverToolCalls("", NAMES)).toBeNull();
  });

  it("is all or nothing: one unrecognised call among good ones means none are run", () => {
    expect(recoverToolCalls('[{"name":"read_file","arguments":{"path":"a"}},{"name":"made_up","arguments":{}}]', NAMES)).toBeNull();
  });
});

describe("mayBeTextToolCall", () => {
  it("says yes for text that starts like a call, no for ordinary text, and waits when it cannot tell yet", () => {
    expect(mayBeTextToolCall("  { \"name\"")).toBe(true);
    expect(mayBeTextToolCall("[{")).toBe(true);
    expect(mayBeTextToolCall("<tool_call>{")).toBe(true);
    expect(mayBeTextToolCall("```json")).toBe(true);
    expect(mayBeTextToolCall("The function")).toBe(false);
    expect(mayBeTextToolCall("<div>")).toBe(false);
    expect(mayBeTextToolCall("")).toBeUndefined();
    expect(mayBeTextToolCall("   ")).toBeUndefined();
    expect(mayBeTextToolCall("<tool")).toBeUndefined();
    expect(mayBeTextToolCall("``")).toBeUndefined();
  });
});
