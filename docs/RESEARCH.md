# Forge-Code: competitive research and roadmap

Researched 2026-11-22 from each product's own README or docs (links at the bottom). **Limits:** these are vendor
descriptions, not independent reviews or user-complaint data; web search was unavailable in the session that produced
this. Treat "what users dislike" as hypotheses to validate, not findings.

## The landscape

| Product | Shape | What it leads with |
|---|---|---|
| Cursor | Desktop IDE + CLI | Agents you hand tasks to, a "Mission Control" view of many agents, shadow workspaces, semantic codebase index |
| Windsurf (now "Devin Desktop") | Desktop IDE | Moved from its own Cascade agent to "Devin Local" plus any ACP agent; plans/todo lists, queued messages, workflows |
| Zed | Native editor | Speed; Agent Panel; **external agents over ACP**; Threads Sidebar with parallel agents across projects/worktrees; edit prediction; inline assistant |
| Kiro | IDE + CLI + cloud | **Specs** (requirements, design, tasks), steering files, **hooks**, "powers", checkpoints and rewind, local command sandbox, ACP |
| Cline | VS Code, JetBrains, CLI, desktop, SDK | Open source, human-in-the-loop approval, scheduled routines, SDK for building agents |
| Aider | Terminal | Git-native pair programming, architect/ask modes, voice, lint-and-test loop, broadest model support |
| Continue | VS Code/JetBrains/CLI | Repository is now archived and read-only (final 2.0.0): the open-source IDE-extension slot is thinning |

## Where the market is converging
1. **ACP is becoming the standard seam.** Zed, Kiro and Windsurf/Devin all host external agents over the Agent Client
   Protocol. Forge-Code already speaks ACP, and (since this research) captures an external agent's edits as reviewable
   proposals, which none of the pages above claim to do.
2. **Parallelism is the new headline.** Zed's Threads Sidebar and Cursor's Mission Control both organise many agents at once.
3. **Specs/plans before code** (Kiro specs, Windsurf plans, Forge-Code plan files).
4. **Hooks and steering** to make agents follow team rules (Kiro, Forge-Code `.forge/hooks.json` and AGENTS.md).
5. **Sandboxing** is appearing (Kiro "local command sandbox"); Forge-Code already ships an OS-level sandbox with no network.

## Where Forge-Code is already ahead (verified in this repo)
- **Review-first by default**: per-hunk accept/reject, reasons per hunk, conflict check against the developer's own edits,
  persisted across restarts. Applies to the built-in agent *and* external ACP agents.
- **Provable privacy**: local-only mode refuses non-loopback requests; a network log shows every outbound request;
  API keys live in the OS credential store; optional local embeddings that refuse non-local servers.
- **Safety stack**: Windows AppContainer sandbox, prompt-injection quarantine, secret redaction before anything leaves,
  audit log, permission gate with a deny list.
- **Verification that cannot be gamed**: structured test/lint/type errors fed back to the agent, plus a guard that flags
  weakened tests.
- **Own-process agent loop** with a worker fallback, and a repo index that holds 120k files (first index ~6 s, warm grep ~10 ms).

## Gaps, ranked by user value and fit
| # | Gap | Who has it | Why it matters | Effort |
|---|---|---|---|---|
| 1 | **Inline edit** (select code, describe the change, get a diff to review) | Cursor, Zed | Daily-use feature; the review model makes ours safer than "apply instantly" | small, builds on existing pieces |
| 2 | **Parallel threads** (several agents at once, each with its own history) | Zed, Cursor | The 2026 headline feature | medium |
| 3 | **Git worktree per agent** so parallel agents cannot collide | Zed | Makes #2 safe | medium |
| 4 | **Skills / custom agents** as files in the repo | Kiro, Zed | Shareable team workflows | medium |
| 5 | **Edit prediction** (ghost-text completion) | Cursor, Zed | Table stakes for an editor, but needs a fast low-latency model | large, model-dependent |
| 6 | **Headless CLI** for CI and scripts (the runtime already runs as its own process) | Cline, Aider, Kiro | Opens CI use | medium |
| 7 | **Scheduled routines** | Cline, Windsurf | Automation | medium |
| 8 | Voice | Aider, Kiro | Niche | skip |

## Recommended positioning
"The AI editor you can trust with your code": every change reviewable, nothing leaves the machine unless you can see
it, any agent welcome. Compete on trust and control rather than raw autocomplete. Build #1 now, then #2 and #3 together.

## Sources
- Cursor: https://cursor.com/features
- Zed AI overview: https://zed.dev/docs/ai/overview
- Kiro specs: https://kiro.dev/docs/specs/
- Cline: https://github.com/cline/cline
- Continue: https://github.com/continuedev/continue
- Aider: https://aider.chat/docs/
- Windsurf/Devin Desktop Cascade (legacy): https://docs.windsurf.com/windsurf/cascade/cascade
