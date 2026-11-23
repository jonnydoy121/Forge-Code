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

## Against the original proposal

| Proposal | Status |
|---|---|
| Three tiers, scout / builder / architect | Built |
| Intent triage by a tiny model | Built, opt-in; the free wording guess is the default because a model call before every message costs latency |
| Context compression | Already there: ranked repo map, token-budgeted context, compaction (now run by the scout), sub-agents with fresh contexts. The Unity/Blender scene summaries do not apply to a code editor |
| 2-3 options and a preview before generating code | **Not built.** Plan mode is the nearest thing (a plan you review before any code changes) and it uses the architect |
| Diff-only execution | Already there (`edit_file` search/replace) |
| Escalate to the architect after two failures | Built, driven by failing checks rather than errors from a Unity/Blender bridge |
| Prompt caching | Built for Anthropic; OpenAI-compatible usage is read |
| Local models for zero-cost chores | Built: summaries, commit messages and triage can run on Ollama or LM Studio (as an OpenAI-compatible server) |
| Never pre-generate the options you do not pick | Nothing pre-generates; no options step exists |

## Limits to know about

- **Not verified against a live provider.** Routing is tested end to end in the real window against a mock server that records the
  model each request names, and the cache request and usage handling against the documented shapes. Real cache hits, real savings
  and how a small local scout copes with tool calls have not been measured.
- A small scout can be poor at tool use. Triage sends it whole requests, including small edits in Agent mode; leave triage off, or
  use the scout only for chores, if yours struggles.
- The wording guess is deliberately simple and will misjudge some requests. The escalation to the architect does not depend on it.
- Once the architect has taken over it keeps the rest of that run, even after the checks pass.
