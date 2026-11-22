import { useState } from "react";
import type { Question } from "@forge/plans";

export function QuestionPrompt({ questions, onAnswer }: { questions: Question[]; onAnswer: (answers: string[]) => void }) {
  const [answers, setAnswers] = useState(questions.map((q) => q.default ?? ""));
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" role="dialog" aria-modal="true" aria-label="Questions from the agent" data-testid="question-prompt">
      <div className="w-[520px] rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4 text-sm shadow-2xl">
        <h2 className="mb-2 font-semibold">The agent needs a few answers before planning</h2>
        {questions.map((q, i) => (
          <label key={i} className="mb-2 block">
            <span className="block">{q.question}</span>
            <input
              data-testid={`answer-${i}`}
              className="mt-1 w-full rounded bg-[var(--hover)] px-2 py-1"
              value={answers[i]}
              placeholder={q.default ? `Suggested: ${q.default}` : ""}
              onChange={(e) => setAnswers((a) => a.map((x, j) => (j === i ? e.target.value : x)))}
            />
          </label>
        ))}
        <button className="rounded bg-green-700/70 px-3 py-1" data-testid="submit-answers" onClick={() => onAnswer(answers)}>
          Continue
        </button>
      </div>
    </div>
  );
}

export function AddFilePrompt({ question, path, onAnswer }: { question: string; path: string; onAnswer: (add: boolean) => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" role="dialog" aria-modal="true" aria-label="Edit outside the plan" data-testid="addfile-prompt">
      <div className="w-[480px] rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4 text-sm shadow-2xl">
        <h2 className="mb-2 font-semibold">Edit outside the approved plan</h2>
        <p className="mb-3" data-testid="addfile-question">{question}</p>
        <p className="mb-3 text-xs text-[var(--muted)]">The agent stopped before touching <code>{path}</code>. If you add it, it is recorded in the plan file.</p>
        <div className="flex gap-2">
          <button className="rounded bg-green-700/70 px-3 py-1" data-testid="addfile-yes" onClick={() => onAnswer(true)} autoFocus>Add to plan</button>
          <button className="rounded bg-red-700/70 px-3 py-1" data-testid="addfile-no" onClick={() => onAnswer(false)}>Don't edit it</button>
        </div>
      </div>
    </div>
  );
}
