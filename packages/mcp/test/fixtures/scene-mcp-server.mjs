// An MCP server that behaves like the bridge to a game or 3D editor: a huge scene dump, a huge build log, a build that fails, a tiny ping.
import readline from "node:readline";

const tools = [
  { name: "get_scene", description: "Dump the whole scene", inputSchema: { type: "object", properties: {} } },
  { name: "get_build_log", description: "The full build log", inputSchema: { type: "object", properties: {} } },
  { name: "build", description: "Compile the project (fails with a long log)", inputSchema: { type: "object", properties: {} } },
  { name: "ping", description: "Tiny", inputSchema: { type: "object", properties: {} } },
];
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const scene = {
  scene: "Level_01",
  objects: Array.from({ length: 4000 }, (_, i) => ({ id: i, name: `Wall_${String(i).padStart(4, "0")}`, transform: { position: [i, 0, i * 2], rotation: [0, 0, 0], scale: [1, 1, 1] }, components: [{ type: "MeshRenderer", material: "Concrete" }] })),
};
const log = Array.from({ length: 6000 }, (_, i) => `[${i}] compiling Assets/Scripts/Module${i}.cs`).join("\n");
const text = (t, isError = false) => ({ isError, content: [{ type: "text", text: t }] });

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "scene-mcp", version: "1.0.0" } } });
  if (m.method === "tools/list") return send({ jsonrpc: "2.0", id: m.id, result: { tools } });
  if (m.method === "tools/call") {
    const { name } = m.params;
    if (name === "get_scene") return send({ jsonrpc: "2.0", id: m.id, result: text(JSON.stringify(scene)) });
    if (name === "get_build_log") return send({ jsonrpc: "2.0", id: m.id, result: text(log) });
    if (name === "build") return send({ jsonrpc: "2.0", id: m.id, result: text(`${log}\nerror CS0103: The name 'Rigidbody2D' does not exist in the current context`, true) });
    if (name === "ping") return send({ jsonrpc: "2.0", id: m.id, result: text("pong") });
    return send({ jsonrpc: "2.0", id: m.id, error: { code: -32602, message: `unknown tool ${name}` } });
  }
  if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `method not found: ${m.method}` } });
});
