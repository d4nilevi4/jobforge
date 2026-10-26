# Contributing

Use Node >=22.13 and install a Chromium-family browser for PDF tests. Clone the repository, set `CHROME_BIN` if auto-detection cannot find the executable, and run `npm start`. No dependency installation or build step is needed. First startup prints the owner token once; use the UI at `http://127.0.0.1:8787`.

Read [SPEC](docs/SPEC.md) before changing behavior. Keep code in ES modules with 2-space indentation, single quotes, semicolons, and small functions. All code, docs, tests, and messages are English. Use fictional Alex Example data, alex@example.com, and example.com URLs in fixtures.

Zero npm dependencies is a project invariant: use only `node:` built-ins. Never run `npm install` or add a library. Chromium is the only external runtime program; templates and UI need no build tool.

Use `node:test` and `node:assert/strict`. Run your focused files while developing, e.g. `node --test tests/guide.test.js tests/openapi.test.js`; run `npm test` before merging when working against a complete tree. Tests use temporary data directories and a real server on port 0. PDF tests visibly skip when Chrome is unavailable; verify real rendering when changing templates/rendering. Do not substitute mocked transport for required HTTP integration checks.

Database migrations are forward-only, additive where possible, and never delete user data or edit an already released migration. Every migration needs a previous-version database fixture with sample rows and assertions that data survives. Document format changes need pure upgrade chains, schema/example changes, and eager migration of stored documents. See the [worked upgrade checklist](docs/upgrading.md). Record every migration/API addition in CHANGELOG; keep the guide and OpenAPI synchronized. Breaking HTTP changes require a new API major.

Use short imperative commit subjects such as `docs: describe application retries` or `fix: preserve profile revisions`. Keep each change focused; pull requests should explain the resulting behavior, compatibility/migration impact, and exact tests run. Include preview evidence for template/UI changes. Report code/SPEC disagreements explicitly and resolve them in the same change when authorized.
