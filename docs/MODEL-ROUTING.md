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
- **Measured prefix reuse (what makes caching pay).** With a real model server (Ollama, `qwen2.5-coder:7b`, `cache.live.test.ts`), step 2 and later of a run
  reused 89-92% of the prompt (the whole earlier conversation), and the first request of a run with a *different* prompt reused 98% (only the new
  message was processed fresh). In the real window, `prefix.spec.ts` checks that the system text and the tools are byte-identical from request to
  request through a read, an edit and another read, with the repo map in the prompt. Ollama's cache is not Anthropic's, but both only help when the
  prefix is stable, and ours is.
- **Anthropic's real savings are still unmeasured by me** (no API key). To check them yourself, one command that spends a fraction of a cent (three
  requests of about 3,000 prompt tokens on Haiku): `FORGE_LIVE_ANTHROPIC=1 ANTHROPIC_API_KEY=... npx vitest run packages/agent-runtime/test/cache.live`.
  It fails unless the first request writes to the cache, the later ones read from it, and the third costs less than it would uncached.
- One API key is kept per provider kind, so two tiers on the same provider with different endpoints share a key.

## External apps over MCP (game and 3D editors, anything with a bridge)

Forge talks to MCP servers, so a Unity, Blender or Unreal bridge is just another server. Two parts of the original proposal were about such apps, and
both are built in a form that works for any MCP server:

- **Big results are shrunk before the model sees them.** A scene dump or build log can be hundreds of KB; the built-in tools cap their output but an MCP
  result used to go to the model whole. Now a result over 12,000 characters is compacted locally (no model call, free, deterministic): JSON keeps the top
  level and the first items of each array, with deep levels and long strings cut and each cut counted ("… 3,990 more items"); other text keeps its
  beginning and its end (the cause of a failed build is at the end). A note says what was done and to ask again with a narrower query. A failing call
  still fails, with its error compacted the same way. Tested through a real server process that behaves like such a bridge (a 4,000-object scene, a
  6,000-line build log, a build that fails).
- **Errors from the external app count toward escalation.** A step in which an MCP tool returned an error counts as a failed attempt, like a failed check:
  the builder gets one attempt, the architect the second (and the scout, if it was used, only the first). A permission you denied, a hook block, or a
  built-in tool failing does not count. Tested with a real MCP server process whose tool fails.

Not done: summarising a scene with a small model (the proposal's other option). A local compaction is free and predictable, a model summary can lose the
one detail that matters; if you want it, the scout is the place for it.
**Not run against Unity, Blender or Unreal themselves**, only against mock servers that behave like them.

## Options before code

For a request with more than one reasonable way to do it, type it in Agent or Plan mode and press **Options** (next to Attach) instead of Enter.
The main model is asked for 2 or 3 short approaches, as JSON and with no code: a title, how it works, the files it would probably change, what you
give up, and a rough size. It is given the repo map and the file you have open, so the files are real ones. They appear as cards in the panel.
**Use option B** then runs the agent on that approach alone: it is told the request, the chosen approach and its files, and not to build the others.

- **Nothing is generated for the options you do not pick.** The whole step is one short model call (a few hundred tokens) plus the one run you choose;
  a test counts the requests that reach the model.
- The "preview" is the files list, the trade-off and the size, not rendered output: a code editor has no scene to preview before code exists.
- It uses the **main model**, not the scout: the measurements below show a small model's approaches can be generic, and picking the approach is the
  decision that steers everything after it.
- If the reply cannot be read as at least two options, your request goes back in the box and nothing is lost. Ask mode does not change code, so the
  button is off there.
- Measured with real local models (4 requests): `qwen2.5-coder:7b` gave usable, specific options 4 of 4 times in 1.2-3.4 s; `qwen2.5-coder:1.5b` 4 of 4
  once the parser accepted the bare JSON array it sometimes returns, in about half a second, with more generic approaches. Not measured with a hosted model.

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
| Context compression | Already there for code: ranked repo map, token-budgeted context, compaction (run by the scout), sub-agents with fresh contexts. For external apps over MCP: big results are compacted locally, see above |
| 2-3 options and a preview before generating code | See "Options before code" below |
| Diff-only execution | Already there (`edit_file` search/replace) |
| Escalate to the architect after two failures | Built, driven by failing checks and by errors from external (MCP) tools |
| Prompt caching | Built for Anthropic; OpenAI-compatible usage is read. Prefix reuse measured on a real server; Anthropic savings not measured (a one-command check is provided) |
| Local models for zero-cost chores | Built: summaries, commit messages and triage can run on Ollama or LM Studio (as an OpenAI-compatible server) |
| Never pre-generate the options you do not pick | Nothing pre-generates; no options step exists |

## Limits to know about

- **Hosted providers are not verified live.** Routing is tested end to end in the real window against a mock server that records the model each
  request names, and the cache request and usage handling against the documented shapes. Real cache hits and real savings with Anthropic or OpenAI
  have not been measured (no API key was available; see the one-command check above). Local Ollama models were measured, see above.
- **Unity, Blender and Unreal are untested.** The MCP features are tested against mock servers that behave like such bridges.
- A small scout is poor at tool use (see the measurements). Leave triage off, or keep the scout to chores, unless yours is good at it.
- The wording guess is deliberately simple and will misjudge some requests. The escalation to the architect does not depend on it.
- Once the architect has taken over it keeps the rest of that run, even after the checks pass.
- **Max $** counts only models with a price: the built-in table, or one you type under Settings > Model prices (one line per model:
  `model input-$ output-$` per million tokens). A remote model without a price is flagged in settings and next to the cost in the panel;
  local models are free.
