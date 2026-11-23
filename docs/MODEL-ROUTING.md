# Model routing

Forge-Code can use more than one model in a session: a cheap fast one for chores, the everyday one for the work, and the
strongest one where it counts. It is off until you set a tier, and with nothing set every request goes to the main model,
exactly as before. Set it up under **Settings > Model routing**.

| Tier | Meant for | Used for |
|---|---|---|
| **Scout** (Haiku, Gemini Flash, a local Qwen or Llama via Ollama or LM Studio) | chores | summarising older turns when the context fills up, commit messages, and (with triage) simple questions and small edits |
| **Builder** (the main model in Settings > Model) | the everyday work | everything not sent elsewhere; also the fallback for a tier you have not set |
| **Architect** (Opus, o3, DeepSeek-R1) | the hard part | plan mode, and fixes after the checks have failed twice |

A tier you leave off falls back to the builder, so you can set only the one you want (a local scout alone, or an architect alone).

## How a request is routed

1. **Triage** (opt-in, Settings > Triage). *Off*: the builder answers. *By wording*: a free, instant guess from the request's
   words and length. A short question in Ask mode, or a small well-defined edit ("rename x", "fix the typo", "change the button
   colour") goes to the scout; design or debugging words together with a long request or several files go to the architect;
   everything else stays with the builder. It needs two signals before it says "complex", so it errs towards the builder.
   *Ask the scout first*: one extra model call to the scout (two second limit) before the answer; if it is slow, fails or
   rambles, the wording guess is used.
2. **Plan mode** goes to the architect when there is one.
3. **Escalation.** The builder answers and edits. If the automatic checks (format, lint, types, language-server errors, tests)
   fail, the builder gets one attempt to fix what they found. If they fail a second time, the architect takes over for the rest
   of that run. The threshold is *Escalate after* (default 2). The next message starts on the builder again.

The panel shows a line when the model changes ("Model: architect (claude-opus-5-5). checks failed 2 times with the default
model, so the architect model takes over."), and the audit log records the model that actually answered each request.

## What stays the same

- **Edits are search-and-replace diffs** (`edit_file`), reviewed by you. Routing changes who writes them, not how.
- **Sub-agents** (`delegate`) use the builder, for quality.
- **Local-only mode** skips any remote tier (the panel says so) rather than failing the run on a blocked request.
- The **privacy badge** says "remote" if the builder *or any tier that could be used* is remote.

## Cost and caching

- Each request is costed by the model that answered it. Prices follow Anthropic's published table (with the source and date in
  the code). **Models without a price (local models, other providers) are counted as free**, so the *Max $* limit does not see
  them: an escalation to a remote model that has no price is invisible to it.
- **Anthropic prompt caching** is on. Requests carry an automatic cache breakpoint that follows the end of the conversation, so
  each step of a tool loop reads the earlier steps from the cache, plus an explicit breakpoint on the stable system text (rules and
  mode) which is sent as its own message ahead of the sections that change (repo map, attachments, plan). Cache writes cost 1.25x,
  reads 0.1x (0.05x for Opus 5.5 and Sonnet 5.5). Prefixes under the model's minimum (512 tokens for the 5.5 models) are just not
  cached. OpenAI-compatible providers cache prefixes by themselves; the usage they report is read the same way.
- One API key is kept per provider kind, so two tiers on the same provider with different endpoints share a key.

## Measured: small local models as the scout

Run on this development machine (RTX 5070 Ti, Ollama, default sampling) with `FORGE_LIVE_SCOUT=<model> npx vitest run packages/agent-runtime/test/scout.live`
(opt-in; talks only to Ollama on this machine). Six small tasks through the real agent loop and tools, 3 runs each, 18 runs per model.

| | Edits and questions that passed, before tool-call recovery | after |
|---|---|---|
| `qwen2.5-coder:7b` (the app's default local model) | **0 of 18**, zero tool calls | **13 of 18** (rename 3/3, typo 3/3, question 3/3, add a function 3/3, colour 1/3, comment 0/3) |
| `qwen2.5-coder:1.5b` | 0 of 18 | 4 of 18 |

What happened before: both models picked the right tool with sensible arguments, but wrote the call as JSON *text* instead of the
structured `tool_calls` field, so the agent loop took it for an ordinary answer and ran nothing. This was not specific to routing: it
affected agent mode with the default local model. The gateway now reads such a reply back as tool calls, but only when the whole reply
is calls to tools that were actually offered (prose with some JSON in it, or a made-up tool name, stays an answer).
What still goes wrong with the 7B: it invents an `old_string` that is not in the file (the colour task), and places a comment inside
an `export` statement. The 1.5B mostly invents tools and arguments.

**Sizing up requests** (18 labelled prompts): the free wording heuristic got 17 right. The 7B model asked to classify got 14; the 1.5B model
got 8, answered off-format 3 times, and called ordinary feature requests "trivial", which would send real work to a model that cannot do it.
Hence the defaults: triage is off, the wording guess is what to use if you turn it on, the scout takes simple *edits* only if you tick the box
(Settings > Model routing), and it always gets a single attempt before the builder takes over.

**Commit messages**: both models wrote usable subjects (36-56 characters, well under 72), but the 1.5B wrapped two of three in backticks and a
markdown `#`, which git would read as a comment; messages are now cleaned of that decoration whichever model wrote them.

These are small samples (18 runs, one machine, default sampling, one run of the triage set): they show what goes wrong and by roughly how much, not
a benchmark.

## Against the original proposal

| Proposal | Status |
|---|---|
| Three tiers, scout / builder / architect | Built |
| Intent triage by a tiny model | Built, opt-in; the free wording guess is the default because a model call before every message costs latency |
| Context compression | Already there: ranked repo map, token-budgeted context, compaction (now run by the scout), sub-agents with fresh contexts. The Unity/Blender scene summaries do not apply to a code editor |
| 2-3 options and a preview before generating code | See "Options before code" below |
| Diff-only execution | Already there (`edit_file` search/replace) |
| Escalate to the architect after two failures | Built, driven by failing checks rather than errors from a Unity/Blender bridge |
| Prompt caching | Built for Anthropic; OpenAI-compatible usage is read |
| Local models for zero-cost chores | Built: summaries, commit messages and triage can run on Ollama or LM Studio (as an OpenAI-compatible server) |
| Never pre-generate the options you do not pick | Nothing pre-generates; no options step exists |

## Limits to know about

- **Hosted providers are not verified live.** Routing is tested end to end in the real window against a mock server that records the model each
  request names, and the cache request and usage handling against the documented shapes. Real cache hits and real savings with Anthropic or OpenAI
  have not been measured (no API key was available). Local Ollama models were measured, see above.
- A small scout is poor at tool use (see the measurements). Leave triage off, or keep the scout to chores, unless yours is good at it.
- The wording guess is deliberately simple and will misjudge some requests. The escalation to the architect does not depend on it.
- Once the architect has taken over it keeps the rest of that run, even after the checks pass.
- **Max $** counts only models with a price: the built-in table, or one you type under Settings > Model prices (one line per model:
  `model input-$ output-$` per million tokens). A remote model without a price is flagged in settings and next to the cost in the panel;
  local models are free.
