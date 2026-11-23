# Forge-Code performance: what was measured, what changed, what did not help

Everything here was measured on one Windows 11 machine with the real release build, using the scripts in `scripts/`.
Numbers are medians of 5 runs unless noted. Treat them as relative (before/after on the same machine), not as promises.

## How to measure

| What | Command |
|---|---|
| App startup, memory, idle CPU (release exe) | `npx tauri build --no-bundle` then `node scripts/perf-startup.mjs 5` |
| Indexer on a large repo (first index, grep, symbol, semantic, repo map) | `FORGE_PERF_REPO=<dir> cargo test -p forge-core --release --test perf -- --ignored --nocapture` |
| Typing latency, large-file open | `scripts/desktop-e2e.ps1 polish.spec.ts` (asserts a budget) |

## Research that shaped the changes
- **Ship less JavaScript at startup.** Code splitting exists to minimise startup time: less JavaScript to parse, compile and
  run means the main thread is free sooner ([web.dev, "Reduce JavaScript payloads with code splitting"](https://web.dev/articles/reduce-javascript-payloads-with-code-splitting)).
  Our app shipped one 3.97 MB file, about 85% of it the Monaco editor engine.
- **Release profile.** Tauri's own size/speed guide recommends link-time optimisation, one codegen unit and stripped symbols
  for release builds ([Tauri, "App Size"](https://v2.tauri.app/concept/size/)). We had no release profile at all.
  We deliberately did **not** adopt `panic = "abort"` from that list: a panic in one worker thread (indexer, file watcher)
  should not take the whole editor down.
- **Text data structures.** Zed's speed comes partly from its rope/SumTree text representation
  ([Zed Decoded: Rope & SumTree](https://zed.dev/blog/zed-decoded-rope-sumtree)). Not applicable here: Monaco owns the text buffer.

## Results

### Startup (real release window, median of 5)
| | Before | After | Change |
|---|---|---|---|
| DOM ready | 153 ms | 26 ms | -83% |
| First paint | 216 ms | 112 ms | -48% |
| Shell mounted | 278 ms | 118 ms | -58% |
| JavaScript parsed at startup | 3,971 KB (1,046 KB gzip) | 355 KB (122 KB gzip) | -91% |
| Executable | 36.4 MB | 34.5 MB | -5% |
| Memory (7 processes) | 384 MB | 374 MB | -3% |
| Idle CPU | ~0% | ~0% | none |

How: Monaco (3.3 MB) now loads the first time a file is opened, and is warmed in the background shortly after a
workspace opens so the first file still opens instantly. The terminal (xterm.js, 335 KB) and the review, plan and context
views load when first shown. Nothing was removed: the total shipped is the same (about 5.1 MB), it is just not all on the
critical path.

**Honest note on memory:** steady-state memory is essentially unchanged, because the editor engine is loaded within moments
of startup anyway. The win is how soon the window is usable, not how much it holds afterwards.

### Indexer, 120,000 files / 960,000 lines (release build)
| | Before | After |
|---|---|---|
| Semantic search (480,240 chunks) | 138 ms | **7 ms** (about 19x faster) |
| Repo map | 20 ms | 18 ms |
| Incremental reindex | 15 ms | 13 ms |
| Reopen from disk | 998 ms | 872 ms |
| First index | 5.7 s | 5.4 s (within noise) |

Two causes for the semantic-search gain: (1) fat LTO plus one codegen unit roughly halved it on their own (138 to 69 ms),
and (2) the search no longer builds and fully sorts a list of every chunk's score. Each thread now keeps only its best k and
the sets are merged. The dot product also uses eight independent accumulators so the compiler can vectorise it; a plain float
`.sum()` must add in order, which blocks SIMD. Tests prove the unrolled dot product matches the naive one at every length and
that the bounded top-k equals the start of the full ranking.

### Warm open of a 120,000-file repo (profiled, then fixed)
The build now records where its time goes (`BuildStats.phases`), so this was measured rather than guessed. Profile of the old
path: opening from SQLite 999 ms = row read 302 + JSON decode 239 + vector conversion 71 + inserting into the in-memory index 368;
warm build 809 ms = import graph 394 + directory walk 175 + old Merkle tree 110 + new Merkle tree and diff 88.

| | Before | After |
|---|---|---|
| Reopen from SQLite | 999 ms | 662 ms (-34%) |
| Warm build (nothing changed) | 809 ms | 225 ms (-72%) |
| **Total until "ready"** | **1,808 ms** | **887 ms (-51%)** |
| Import graph + Merkle root | inside the build | about 410 ms, built after "ready" |

What changed: (1) rows are still read one by one from SQLite, but JSON and vector decoding now run on every core, 4,096 rows
at a time so the extra memory stays small, with the in-memory maps sized once; (2) when nothing needed hashing and the walk found
exactly the files already known, the Merkle tree cannot have changed, so it is neither rebuilt nor diffed (the root is computed the
first time something asks for it, or by `warm()`); (3) the import graph is built right after the app announces "ready" instead of
inside the build, so it never delays that signal (the first repo map is still instant). A test covers unchanged, added, edited,
deleted and "reopened from disk then unchanged", including that the Merkle root is non-empty, changes with the files, and
matches after a restart. Timings on this machine drift by up to about 30% with background load, so quote ratios, not absolutes.

### Smaller fixes
- The UI polled localStorage every second, forever, to notice a settings change. It now listens for a change event.

### Time from pressing Enter to the model request (what every message costs)
Measured in the real window with a mock model, using `mark()` timestamps (`src/lib/trace.ts`, free unless a test turns it on):

| | ms |
|---|---|
| Any message once the agent process is running | **31-37** |
| First message, first-ever launch of the executable | 310-390 |
| First message when the process had to be launched again | 59-86 |
| First message when the input was focused first (pre-warm) | **52** |

The timeline of a cold first message showed the cost is not in our code: context assembly is about 20 ms, the model request leaves
4 ms after that, and almost everything else is waiting for the runtime process to boot. The standalone executable takes about 21 ms
to answer once the OS has run it before, but 275+ ms the very first time (the operating system reading and scanning a 100 MB file it
has never run). A user pays that once per install or update, not per session. Two changes hide the rest: absolute `.exe` paths are
now launched directly instead of through `cmd.exe` (one process fewer per child, tested), and the shared agent process is started
when the user focuses the agent input, so it is already running by the time they have typed. An unused pre-started process is
released after a minute. The warm path (31-37 ms, mostly context assembly) has a regression budget in `latency.spec.ts`.

### Trimming the Monaco editor engine
Measured first (esbuild metafile of the engine): the core (`base`, `editor/common`, `editor/browser`, `platform`) is about
2.25 MB, 58% of it, and cannot be removed; optional editor contributions are about 0.7 MB; the JSON/HTML/CSS/TypeScript language
services are 136 KB. Forge-Code registers one Monaco provider (ghost-text completions) and takes diagnostics from real language
servers, so every feature that needs providers the app never registers (go to definition, rename, code actions, signature help,
colour picker, formatting, semantic tokens, inlay hints, code lens, the diff editor) does nothing today, and the TypeScript, HTML
and CSS language services could never run (their workers are not provided).

`src/lib/monaco-features.ts` now imports only what the app uses instead of `import "monaco-editor"`. Result in the real build:
the engine chunk 3,334 -> 3,135 KB (-6%, gzip 858 -> 807 KB), its CSS 133 -> 120 KB, everything shipped 5,126 -> 4,827 KB.

| | Before | After |
|---|---|---|
| Monaco chunk | 3,334 KB | 3,135 KB |
| Everything shipped | 5,126 KB | 4,827 KB |
| Memory | no measurable change | |

The ceiling is low because most of the engine is the core. I could not measure a memory difference beyond run-to-run noise, so
the benefit is a smaller parse and download (about 200 KB), not a smaller footprint. Behaviour is protected by end-to-end tests:
syntax colouring for TypeScript, JavaScript, Python, CSS, HTML, JSON and Rust (and plain text staying uncoloured, so the check
means something), the editor's find widget, and its F1 palette including our "Edit selection with AI" action; the existing suites
cover ghost-text completions, diagnostics, keyboard-only use and accessibility.
Maintenance note: the import paths are tied to the pinned Monaco 0.52.2. A path that no longer exists fails the build loudly; an
upgrade should re-derive the list from the engine's own `editor.all` entry rather than patching it.

### One agent process for every thread
Each agent thread used to start its own `forge-runtime` process. They now share one: every line on the wire carries a session id,
the process creates a runtime per id, and it is started on demand and released when the last thread closes.

| | Before | After |
|---|---|---|
| Memory, 3 threads | 97 MB (3 processes) | 33 MB (1 process), -66% |
| Processes, 2 threads running | 2 | 1 |

Sharing a process meant its failure modes had to be handled, and tests (against real child processes and the real window)
cover each: sessions stay isolated and a slow one does not hold up a fast one; closing one thread aborts only its own in-flight
work; if the process crashes every pending run fails at once instead of hanging, and the next message starts a fresh process
and carries the conversation over; the process is released after the last thread closes.

Two real bugs surfaced on the way and are fixed: closing a thread did not cancel its in-flight model request (the host kept
streaming, and spending tokens, after the thread was gone), and a page reload orphaned every child process (the agent runtime,
MCP and ACP servers, background commands) until the app exited, because the JavaScript that tracked them was discarded. Child
processes are now stopped when the page starts loading.

## Tried, measured, and removed (so nobody repeats them)
- **Parallel directory walk** (`ignore`'s parallel walker) for the warm index build: no measurable gain (707 ms vs 765 ms,
  noise). On this machine the warm build is not bound by the walk. Reverted to keep the code simple.
- **Batching streamed text to one update per animation frame.** Hypothesis: one React render per token is wasteful. Measured:
  with a burst React already coalesces (14 DOM updates for 800 tokens); with tokens paced at the real timer resolution (about
  one per frame) a frame batcher coalesced nothing (800 pushes, 794 flushes); and the main-thread cost per streamed token only
  grows mildly with conversation length (1.6 ms with an empty conversation, 2.2 ms after 60 exchanges, 2.6 ms after 120). Not worth
  the code. The streaming correctness test remains.

- **SQLite memory-mapped reads** (`PRAGMA mmap_size`) made reopening roughly 15-20% faster, but SQLite documents that a mapped database
  file being truncated underneath the process can crash it. For a gain that only shows at 100,000+ files, an editor crash if someone
  clears the index folder is not worth it. Not adopted.

## Measured costs worth knowing
- One idle agent-runtime process (one per agent thread): about 33 MB.
- Real embedding model (nomic-embed-text via Ollama): batching 16 chunks per request is 1.7x faster than one request each.

## Ideas not done (with the reason)
