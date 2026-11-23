# Automation: headless runs, schedules, CI

## Headless
`forge-code ask "question"` answers; `forge-code run "task"` proposes diffs (add `--apply` to write, `--allow "npm test"` to permit commands, `--max-cost`, `--max-steps`, `--json`). Exit codes: 0 done, 1 error, 2 stopped at a limit. Model settings come from `FORGE_PROVIDER`, `FORGE_BASE_URL`, `FORGE_MODEL`, `FORGE_API_KEY`.

## Schedules
`.forge/schedule.json` lists jobs (`name`, `cron`, `prompt`, `command` ask|run, `apply`, `allow`, `maxCost`, `maxSteps`, `model`, `provider`, `baseUrl`, `enabled`). A `run` job only proposes unless `"apply": true`.

    forge-code schedule list | run-due [--at T] [--window N] | run <name> | watch

Results go to `.forge/schedule/runs/<job>-<yyyymmdd-hhmm>.json`. `watch` keeps running; otherwise call `run-due` every minute from cron/Task Scheduler, or use `--window N` behind a coarser trigger.

## CI
See `examples/github-actions.yml`. GitLab or any pipeline: build the CLI the same way and run the same command with the variables set as masked CI secrets.

## Status
Verified by tests: cron parsing/DST, job runner with a scripted model, the bundled CLI as a process against a mock server. **Not verified:** a real GitHub Actions run, real hosted models.

## Serve
`forge-code serve` (set `FORGE_SERVE_TOKEN`, 16+ chars) exposes read-only `POST /ask {"prompt": "..."}` with a bearer token on 127.0.0.1. It is the base a chat bridge would call; no Slack/Telegram/Linear adapter exists yet.
