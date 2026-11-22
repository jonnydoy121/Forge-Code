import { useEffect, useRef, useState } from "react";
import { loadSettings, saveSettings, DEFAULT_MODELS, type AgentSettings } from "../lib/settings";

const KEY = "forge.onboarded.v1";

export const needsOnboarding = () => {
  try {
    return localStorage.getItem(KEY) === null;
  } catch {
    return false;
  }
};

interface Props {
  onDone: () => void;
  onOpenFolder: () => void;
}

/** First-run welcome: the privacy choice comes first, then how the agent keeps you in control. */
export function Welcome({ onDone, onOpenFolder }: Props) {
  const [choice, setChoice] = useState<"local" | "hosted">("local");
  const [review, setReview] = useState<AgentSettings["reviewMode"]>("review");
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);

  const finish = (open: boolean) => {
    const s = loadSettings();
    const next: AgentSettings = choice === "local" ? { ...s, provider: "ollama", model: DEFAULT_MODELS.ollama, baseUrl: "", localOnly: true, reviewMode: review } : { ...s, provider: "anthropic", model: DEFAULT_MODELS.anthropic, localOnly: false, reviewMode: review };
    saveSettings(next);
    try {
      localStorage.setItem(KEY, "1");
    } catch {
      /* private window: ask again next time */
    }
    onDone();
    if (open) onOpenFolder();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" role="dialog" aria-modal="true" aria-labelledby="welcome-title" data-testid="welcome">
      <div className="max-h-[90vh] w-[560px] overflow-auto rounded-lg border border-[var(--border)] bg-[var(--panel)] p-6 text-sm shadow-2xl">
        <h1 id="welcome-title" className="mb-2 text-xl font-semibold">Welcome to Forge</h1>
        <p className="mb-4 text-[var(--muted)]">An editor where the AI agent researches, plans, edits and runs checks, while you stay in control: every change is a diff you can reject and roll back.</p>
        <fieldset className="mb-4">
          <legend className="mb-1 font-semibold">Where should the AI run?</legend>
          <label className="mb-1 flex items-start gap-2">
            <input ref={first} type="radio" name="where" checked={choice === "local"} onChange={() => setChoice("local")} data-testid="choose-local" />
            <span><strong>On this machine (recommended)</strong><br /><span className="text-[var(--muted)]">Uses a local model such as Ollama. Local-only mode blocks every request that would leave your computer.</span></span>
          </label>
          <label className="flex items-start gap-2">
            <input type="radio" name="where" checked={choice === "hosted"} onChange={() => setChoice("hosted")} data-testid="choose-hosted" />
            <span><strong>A hosted provider</strong><br /><span className="text-[var(--muted)]">Prompts and the code you attach are sent to the provider you configure. You can see every request in the audit log.</span></span>
          </label>
        </fieldset>
        <fieldset className="mb-4">
          <legend className="mb-1 font-semibold">When the agent edits files</legend>
          <label className="mr-4"><input type="radio" name="review" checked={review === "review"} onChange={() => setReview("review")} /> Show me every edit first</label>
          <label><input type="radio" name="review" checked={review === "auto"} onChange={() => setReview("auto")} /> Apply automatically (checkpointed, undoable)</label>
        </fieldset>
        <ul className="mb-4 list-disc space-y-1 pl-5 text-[var(--muted)]">
          <li>Ctrl+Shift+P opens the command palette; Shift+Tab in the agent box cycles Ask, Plan, Agent and Debug.</li>
          <li>Large requests get a plan you can edit before any code changes.</li>
          <li>Commands run in a sandbox with no network, and dangerous ones always ask.</li>
        </ul>
        <div className="flex gap-2">
          <button className="rounded bg-green-700/70 px-4 py-1.5" data-testid="welcome-open" onClick={() => finish(true)}>Open a folder</button>
          <button className="rounded bg-[var(--hover)] px-4 py-1.5" data-testid="welcome-skip" onClick={() => finish(false)}>Start without a folder</button>
        </div>
      </div>
    </div>
  );
}
