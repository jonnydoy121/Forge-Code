import type { Mode } from "@forge/protocol";

const MODES: Mode[] = ["ask", "plan", "agent", "debug"];

export function App() {
  return (
    <main className="min-h-screen bg-zinc-950 p-8 text-zinc-100">
      <h1 className="text-2xl font-semibold" data-testid="title">Forge</h1>
      <p className="mt-2 text-zinc-400">Phase 0 scaffold. Modes: {MODES.join(", ")}.</p>
    </main>
  );
}
