# Applying skills and roles automatically

Question: can Forge-Code apply the right roles and skills for the task at hand, and does that improve the AI?

**Short answer.** Skills: yes, and it measurably helps small local models. Personas ("act as a senior security engineer"): no, the evidence says it does not reliably help, so nothing switches persona automatically.

## What the research says

Read for this work (abstract pages only, not the full papers):

- **Personas do not reliably improve accuracy.** Zheng et al., *When "A Helpful Assistant" Is Not Really Helpful* (EMNLP Findings 2024, arXiv 2311.10054): 162 roles, 4 model families, 2,410 factual questions. Adding a persona to the system prompt did not improve performance over no persona, and choosing the best persona per question automatically did no better than random choice.
- **Role-play can help reasoning.** Kong et al., *Better Zero-Shot Reasoning with Role-Play Prompting* (NAACL 2024, arXiv 2308.07702): a staged role-play prompt beat plain zero-shot on most of 12 reasoning benchmarks (for example AQuA 53.5% to 63.8% with ChatGPT). That is a designed prompt for reasoning problems, not an automatic persona router.
- **Retrieving the right documentation helps tool use.** Gorilla (arXiv 2305.15334): a retriever over API documentation reduced hallucinated API calls. This supports putting the relevant instructions in front of the model rather than hoping it recalls them.

A web search was not available during this work, so this is a small set of papers, not a survey.

## What Forge-Code does

- **Skills are applied automatically** (`matchSkills` in `packages/context-store/src/skillMatch.ts`). A cheap lexical match, with no model call, compares the request with each skill's name and description. A skill is applied only when at least two distinct words match, weighted by how rare each word is across the skills; at most two skills are applied, and each is cut at 4,000 characters. Their instructions go into the system prompt as "House rules". Every other skill stays in the index for the model to load with `use_skill`. The CLI prints which skill it applied; `--no-auto-skills` and the Settings checkbox turn it off.
- **Roles stay explicit.** Specialists (`.forge/agents`) are chosen by the coordinator or by you, not switched on by a classifier, because the research above gives no reason to expect an automatic persona choice to beat chance. What does change by task already: read-only tools for questions, a model tier chosen by triage, and checks after edits.

## Measurements

**Matching quality** (offline, `packages/context-store/test/skillMatch.test.ts`): 36 labelled requests over 8 skills, including near misses such as "release the lock" and "enter the coding contest". Precision 95%, recall 91%, exactly right 33 of 36. The author wrote both the skills and the requests, so expect real repositories to do worse. Known misses: a request that never uses the skill's vocabulary ("backfill the new column" for a migration skill), and a coincidental two-word overlap ("team convention" matched the commit-style skill). An earlier version let one word from a skill's name count by itself; it scored 87% precision and falsely applied "release the lock" to the release skill, so that shortcut was removed.

**Does it change what a model does?** (live, `scripts/eval-auto-skills.mjs`): `qwen2.5-coder:7b` via Ollama, 4 skills that each encode a house convention the model cannot guess (a test folder name, a commit trailer, an error-response shape, a tag format), 12 requests, 5 repeats, so 60 runs per condition. A run passes if the answer contains the convention.

| Condition | Followed the convention |
|---|---|
| No skills present | 0 of 60 |
| Skills listed, model must call `use_skill` itself | 3 of 60 (first wording) and 5 of 60 (second wording); it called the tool in only 5 to 6 of 60 runs |
| Skills applied automatically | 31 of 60 (first wording), 32 of 60 (second wording) |

On three unrelated requests, nothing was applied. Rewording the section as "House rules... instructions to apply, not tools to call" made no measurable difference (31 vs 32). The reason it was tried: in one run the model answered with a JSON "tool call" named after the skill instead of the commit message.

**Limits of this evidence.**
- One small model. A stronger model may call `use_skill` far more often, which would shrink the benefit; this was not tested. The extra cost when it is not needed is a few thousand characters of context.
- The conventions are artificial and the check is a string match: it shows the instructions are followed more often, not that the code is better.
- About half of the auto runs still did not follow the convention. The most affected skill was the test-file one (3 to 4 of 15).
- The cost of a wrong match was measured only as matching precision, not as answer quality.
- Not run against hosted models.
