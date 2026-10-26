# AGENTS.md

Guidance for coding agents working on the JobForge repository itself. (If you are an agent that wants to *use* a running JobForge instance to file applications, read [docs/agent-guide.md](docs/agent-guide.md) instead.)

## What this project is

A self-hosted workspace: AI agents file tailored resumes and cover letters over a REST API, a human reviews them in a small web UI. The contract is [docs/SPEC.md](docs/SPEC.md). When code and spec disagree, fix one of them in the same change.

## Ground rules

- Node >= 22.13, ES modules, **zero npm dependencies**. Only `node:` built-ins. Do not run `npm install` and do not add a `dependencies` block.
- The only external program is a Chromium-family browser, used for PDFs. Everything else must work without it (tests skip PDF checks when Chrome is missing).
- Plain and boring beats clever. No speculative features, no config for values that never change.
- Code style: 2-space indent, single quotes, semicolons, small focused functions. Comments only where the reason is not obvious.
- All code, comments, tests, commit messages and docs are in English.
- No personal data in the repository, tests or fixtures. The example person is "Alex Example" (alex@example.com, example.com).
- Error messages are written for AI agents: say what is wrong, where (JSON path) and how to fix it.

## Layout

See section 4 of the spec. In short: `server/` (HTTP, db, guard, render, routes, services), `ui/` (vanilla JS, no build), `templates/builtin/`, `schema/`, `docs/`, `skills/`, `examples/`, `tests/`.

## Tests

```bash
npm test                      # whole suite
node --test tests/guard.test.js   # one file
```

Tests use `node:test` and `node:assert/strict`, run real servers on port 0 with a temporary `DATA_DIR`, and inject a fake PDF renderer through `startServer({ deps })` when Chrome is not the point of the test.

## Changing stored data (read before touching the database or documents)

Upgrades must never lose data. See section 10 of the spec and [docs/upgrading.md](docs/upgrading.md).

- Database changes: add a new `server/migrations/NNN_name.sql`. Never edit an applied migration. Additive first, no data deletion, plus a test that upgrades a populated database.
- Document shape changes (profile, track, content, cover): bump the version in `server/upgrade.js`, add a pure `N -> N+1` upgrade function and a test; keep accepting older versions on input.
- HTTP API: additive changes only inside `/api/v1`.
- Every user-visible change goes into `CHANGELOG.md`.

## Commits

Small, focused commits with an imperative English subject line and a short body that says why. Do not commit secrets, `data/`, or `tmp/`.
