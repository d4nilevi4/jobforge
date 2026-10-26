# JobForge specification (v1)

This document is the contract for the code. When code and spec disagree, fix one of them in the same commit.

## 1. What it is

JobForge is a self-hosted workspace for job applications that AI agents prepare and a human reviews.

- The **human** writes an "About me" profile (or has an agent fill it in), keeps a few resume variants, and approves applications.
- The **agent** reads the profile and the resume variants, finds vacancies by whatever means it has, writes a tailored resume and cover letter, and files them over a REST API.
- The **server** stores everything, checks the facts against the profile, renders PDFs, and shows the queue in a small web UI.

Non-goals: no LLM inside the server, no job-board integrations, no sending applications, no multi-tenant hosting. One instance serves one person.

## 2. Principles

1. Zero npm dependencies. Node >= 22.13 (`node:sqlite`, `node:test`, `node:http`). The only external program is a Chromium-family browser, used to print PDFs.
2. Facts live in one place (the profile). Everything else is derived from it and checked against it.
3. The API is the product. The UI is a client of the same API, with no private endpoints.
4. Errors teach. Every rejection says what is wrong, where (JSON path) and how to fix it, so an agent can repair its own request.
5. Upgrades must never lose data. See section 10.
6. Plain and boring beats clever.

## 3. Concepts

```
Profile (all facts, one per instance)
   |
   +-- Tracks (resume variants: "Unity developer", "Go backend", "Technical director")
          each = positioning notes + base resume content + default templates
              |
              +-- Applications (one per vacancy: vacancy + tailored resume + cover letter + status)

Templates (layout): HTML files that render the standard resume/cover content to PDF.
```

- **Profile**: every true fact about the person. Experience, projects, education, skills, things they must never be said to have done (`do_not_claim`), writing rules.
- **Track**: one resume variant. The same person can be a Unity developer, a Go developer and a technical director; each track selects and orders the facts differently. `when_to_use` tells an agent when to pick it.
- **Template**: pure layout. Resume content is template-independent, so switching a template only re-renders.
- **Application**: one vacancy plus the documents prepared for it.

## 4. Repository layout

```
server/
  index.js            entry: config, db, migrations, http server
  cli.js              token | backup | seed-demo | export | import | doctor
  config.js           env parsing (PORT, HOST, DATA_DIR, CHROME_BIN)
  http.js             tiny router, JSON helpers, error type, body size limit
  db.js               node:sqlite open, migration runner, pre-migration backup
  migrations/         NNN_name.sql, forward-only
  auth.js             tokens, scopes
  validate.js         minimal JSON Schema subset validator (no deps)
  upgrade.js          document upgrade chains (profile, track, content)
  guard.js            fact checking (pure functions)
  render/
    engine.js         logic-less template engine
    pdf.js            Chrome -> PDF, page counting
    labels.js         section labels per language
  routes/             one file per resource: profile, tracks, templates, applications, tokens, misc
ui/                   index.html, app.js, styles.css (vanilla, no build)
templates/builtin/    one folder per built-in template: template.html, meta.json, sample.json
schema/               profile.schema.json, track.schema.json, content.schema.json, application.schema.json, openapi.json
docs/                 SPEC.md, agent-guide.md, templates.md, upgrading.md
skills/               jobforge-apply/SKILL.md, agents/tailor.md
examples/             profile.example.json (fictional candidate)
tests/                node:test files, tests/helpers.js
```

## 5. Data model (SQLite, file `DATA_DIR/jobforge.db`)

Documents (profile, track, content) are stored as JSON text with a `schema_version` inside. Everything queryable gets its own column.

```
meta(key TEXT PRIMARY KEY, value TEXT)                   -- 'schema_version', 'created_at'
tokens(id INTEGER PK, name, scopes TEXT(json array), hash TEXT UNIQUE, created_at, last_used_at, revoked_at)
profile(id INTEGER PK CHECK(id=1), doc TEXT, updated_at)
profile_revisions(id INTEGER PK, doc TEXT, created_at, token_id)
tracks(id TEXT PK, doc TEXT, created_at, updated_at)     -- id is a slug: "unity-developer"
templates(id TEXT PK, kind TEXT CHECK(kind IN ('resume','cover')), current_version INTEGER, created_at, updated_at)   -- custom templates only
template_versions(template_id, version INTEGER, meta TEXT, source TEXT, created_at, PRIMARY KEY(template_id, version))
applications(
  id INTEGER PK, status TEXT, verdict TEXT, score REAL,
  vacancy_url TEXT, vacancy_url_norm TEXT, vacancy_source TEXT, company TEXT, company_norm TEXT,
  title TEXT, location TEXT, language TEXT, vacancy_text TEXT,
  track_id TEXT, resume_template TEXT, cover_template TEXT,   -- "id@version"
  resume_content TEXT, cover_content TEXT, notes TEXT,
  warnings TEXT(json), pages_resume INTEGER, pages_cover INTEGER,
  profile_revision_id INTEGER, created_at, updated_at, created_by_token_id)
CREATE UNIQUE INDEX applications_url ON applications(vacancy_url_norm) WHERE vacancy_url_norm != ''
application_events(id INTEGER PK, application_id, status, note, token_id, at)
```

Files: `DATA_DIR/files/<application_id>/resume.pdf`, `cover.pdf`. Everything in files is derived and can be re-rendered, so backups only need the database.

Built-in templates live on disk in `templates/builtin/` and are read-only. Custom templates live in the database. Ids: built-in `classic`, `compact`, `letter`; custom `custom-<slug>`. The API treats both alike (`builtin: true|false`).

## 6. Documents

### 6.1 Profile (`schema/profile.schema.json`, `schema_version: 1`)

```jsonc
{
  "schema_version": 1,
  "identity": {
    "name": "Alex Example",
    "name_localized": { "ru": "Алекс Пример" },        // optional, per language code
    "email": "alex@example.com", "phone": "", "location": "Porto, Portugal",
    "links": [{ "label": "GitHub", "url": "https://github.com/alex" }],
    "availability": { "en": "Remote, UTC+0", "ru": "Удалённо, UTC+0" }   // optional, per language
  },
  "about": "Free text for agents: goals, preferences, what to avoid, tone.",
  "experience": [
    { "id": "acme", "company": "Acme", "title": "Engineer", "dates": "2021 - 2024", "location": "",
      "bullets": ["Built X for Y, cutting Z by 40%."] }
  ],
  "projects": [{ "id": "tool", "title": "Tool", "tech": "Go, SQLite", "link": "", "link_label": "", "bullets": [] }],
  "education": [{ "institution": "University", "degree": "BSc", "years": "2010 - 2014" }],
  "skills": [{ "key": "languages", "label": "Languages", "label_localized": { "ru": "Языки" }, "items": ["Go", "C#"] }],
  "familiar": [{ "item": "Kubernetes", "qualifier": "coursework" }],      // may only appear with the qualifier
  "languages": [{ "name": "English", "level": "B2" }],
  "do_not_claim": [{ "text": "Never claim team lead experience", "patterns": ["\\bteam lead\\b"] }],
  "rules": {
    "forbid_patterns": [{ "pattern": "—", "message": "No long dashes" }],
    "cover_max_words": 160,
    "notes": "Free text rules for agents."
  }
}
```

Every write that changes the profile adds a row to `profile_revisions`. `GET /profile/revisions?limit=200&offset=0` lists them as a bare array for UI compatibility, with the total in the `X-Total-Count` header; the default limit is 200 and the maximum is 1000. The UI can show a diff and restore one.

### 6.2 Standard content (`schema/content.schema.json`, `schema_version: 1`)

Resume content is the same shape for every template:

```jsonc
{
  "schema_version": 1,
  "language": "en",
  "headline": "Unity Developer",
  "summary": "Two or three sentences.",
  "experience": [{ "company": "Acme", "title": "Engineer", "dates": "2021 - 2024", "location": "", "bullets": ["..."] }],
  "projects": [{ "title": "Tool", "tech": "Go, SQLite", "link": "", "link_label": "", "bullets": ["..."] }],
  "skills": [{ "label": "Languages", "items": "Go, C#" }],
  "education": [{ "institution": "University", "degree": "BSc", "years": "2010 - 2014" }],
  "extra": { }                                   // free slot for custom templates only; never guarded
}
```

Name, email, phone, links and availability are NOT part of the content. The server takes them from the profile at render time, so an agent cannot alter contact details.

Cover content: `{ "schema_version": 1, "language": "en", "text": "Paragraphs separated by blank lines." }`. Header and signature come from the profile.

### 6.3 Track

```jsonc
{
  "schema_version": 1,
  "name": "Unity developer",
  "when_to_use": "Vacancies for Unity/C# game or tooling roles. Not for backend-only roles.",
  "language": "en",
  "resume_template": "classic",
  "cover_template": "letter",
  "base": { /* standard resume content */ },
  "base_cover": "optional starting cover letter text",
  "notes": "Free text for agents: what to emphasise or drop for this variant."
}
```

`base` is validated by the guard against the profile, exactly like an application.

### 6.4 Template

`meta.json`:

```jsonc
{
  "id": "classic", "name": "Classic one-page", "kind": "resume", "version": 1,
  "description": "Single column, ATS-safe, one page.",
  "paper": "letter",              // letter | a4
  "max_pages": 1,
  "languages": ["en", "ru"],      // languages the labels cover
  "labels": { "en": { "summary": "Summary", "experience": "Experience", "projects": "Projects", "skills": "Skills", "education": "Education" },
              "ru": { "summary": "О себе", "experience": "Опыт", "projects": "Проекты", "skills": "Навыки", "education": "Образование" } }
}
```

`template.html` is a complete HTML document using the template syntax of section 8. `sample.json` is a render context used for previews.

## 7. HTTP API (`/api/v1`)

JSON in and out. `Authorization: Bearer <token>` on everything except `GET /version`. Errors:

```json
{ "error": { "code": "validation_failed", "message": "Resume failed the fact check.",
             "details": [{ "path": "resume.experience[1].company", "code": "unknown_employer", "message": "\"Foo Inc\" is not in the profile. Known: Acme." }] } }
```

Codes: `bad_request` 400, `unauthorized` 401, `forbidden` 403, `not_found` 404, `conflict` 409, `payload_too_large` 413, `validation_failed` 422, `render_failed` 422 (details include page overflow), `internal` 500. Request body limit 2 MB.

### Scopes and presets

Scopes: `read`, `write:applications`, `write:tracks`, `write:templates`, `write:profile`, `approve`, `admin`.

Presets: `agent` = read + write:applications + write:tracks + write:templates. `setup` = `agent` + write:profile (for onboarding, when the agent fills the profile from the user's CV). `owner` = everything (the UI uses it). Only `approve` may set `approved`, `sent`, `interview`, `offer`, `rejected`.

### Endpoints

| Method | Path | Scope | Purpose |
|---|---|---|---|
| GET | /version | none | `{name, version, api, schema_version, chrome: {found, path, version}}` |
| GET | /guide | read | Markdown guide for agents (served from `docs/agent-guide.md`) |
| GET | /openapi.json | read | OpenAPI document |
| GET/POST | /tokens | admin | list / create (`{name, preset|scopes}`); the secret is returned once |
| DELETE | /tokens/:id | admin | revoke |
| GET | /profile | read | profile document + `{revision_id, updated_at}` |
| PUT | /profile | write:profile | replace (validated, upgraded, revision added) |
| PATCH | /profile | write:profile | JSON merge patch (RFC 7396) |
| GET | /profile/schema | read | JSON Schema |
| GET | /profile/revisions | read | list; `GET /profile/revisions/:id` for the document |
| GET | /tracks, /tracks/:id | read | resume variants |
| PUT | /tracks/:id | write:tracks | create or replace; id is a slug; guard runs on `base` |
| DELETE | /tracks/:id | write:tracks | |
| GET | /templates?kind= | read | list (built-in and custom) |
| GET | /templates/:id | read | meta, source, sample, content schema |
| PUT | /templates/:id | write:templates | create/replace a custom template (`custom-` prefix required); bumps version |
| POST | /templates/:id/fork | write:templates | copy to `custom-<slug>` |
| DELETE | /templates/:id | write:templates | custom only; refused while applications use it |
| POST | /templates/:id/preview | read | body `{content?, lang?}` (sample if omitted) -> `application/pdf` |
| POST | /check | write:applications | dry run of POST /applications; saves nothing |
| POST | /applications | write:applications | create (see 7.1) |
| GET | /applications | read | list; filters `status`, `track`, `q`, `company`, `verdict`; `limit`, `offset` |
| GET | /applications/:id | read | full record with `same_company` (earlier applications to the same company) |
| PUT | /applications/:id | write:applications | replace content while status is `draft` or `needs_review` |
| POST | /applications/:id/status | write:applications / approve | `{status, note}` (see 7.2) |
| POST | /applications/:id/rerender | write:applications | render again (e.g. after a template change) |
| GET | /applications/:id/files/:name | read | `resume.pdf`, `cover.pdf`, `cover.txt`, `vacancy.md`, `resume.html` |
| DELETE | /applications/:id | approve | |
| GET | /export | admin | JSON bundle of everything except files |
| POST | /import | admin | restore a bundle into an empty database |

### 7.1 POST /applications and POST /check

```jsonc
{
  "vacancy": { "url": "https://...", "source": "hirify|linkedin|manual|...", "title": "", "company": "", "location": "", "language": "en", "text": "full vacancy text" },
  "verdict": "apply|maybe|skip",          // optional, agent's own assessment
  "score": 0.0,                           // optional, 0..1
  "track_id": "unity-developer",          // optional but recommended
  "resume": { "template": "classic", "content": { /* standard content */ } },   // omitted when verdict is skip
  "cover": { "template": "letter", "content": { "text": "..." } },              // optional
  "notes": "Angle, gaps, questions for the recruiter. Markdown."
}
```

Server steps: validate shape -> upgrade documents -> fact check (guard) -> render PDFs -> check page limits -> store. Result `201`: the application record with `warnings`, `pages`, and file URLs. Fact errors or page overflow return `422` and store nothing. Warnings do not block; they are stored and shown.

Duplicates: the same normalised vacancy URL returns `409` with `details[0].existing_id`. The agent may `PUT` that record instead. A different vacancy at a company that already has applications succeeds; `same_company` on the record and in the UI lets the human decide.

`verdict: "skip"` stores the vacancy and notes with status `skipped` and no documents.

### 7.2 Statuses

Agents may move `draft` -> `needs_review` | `skipped`, `needs_review` -> `draft` | `skipped`, and `skipped` -> `draft`; no other agent transitions are allowed, while a token with `approve` may move any record to any status (and also needs `write:applications` to set `draft`, `needs_review`, or `skipped`). Agents may only set `draft`, `needs_review`, `skipped`. Each change appends to `application_events`. Approving requires both PDFs present and rendered from the current content.

## 8. Template syntax (`server/render/engine.js`)

Logic-less, Mustache-like, HTML-escaped by default:

- `{{path.to.value}}` escaped; `{{{path}}}` raw; `{{.}}` current item.
- `{{#each list}} ... {{/each}}` with `{{@index}}`, `{{@first}}`, `{{@last}}`.
- `{{#if path}} ... {{else}} ... {{/if}}`; falsy = missing, empty string, empty array, false, 0.
- `{{labels.experience}}` section labels for the render language (fallback: `en`).
- `{{> name}}` partials are NOT supported. Unknown paths render empty and never throw.

Render context: `{ identity, lang, labels, paper, resume: <content>, cover: <content> }` where `identity` is the profile identity with localized name and availability already resolved for `lang`, and `links` is a flat list.

## 9. PDF rendering (`server/render/pdf.js`)

- Find Chrome: `CHROME_BIN`, then well-known macOS/Linux/Windows paths, then `google-chrome`, `chromium`, `chromium-browser`, `microsoft-edge` on PATH.
- Command: `<chrome> --headless=new --disable-gpu --no-sandbox(only when running as root or in Docker) --no-pdf-header-footer --print-to-pdf=<out> file://<tmp.html>` with a unique `--user-data-dir` in a temp dir, 30 s timeout.
- Page count: read `/Type /Pages ... /Count N` from the PDF bytes (latin1). If missing, fall back to counting `/Type /Page` objects.
- Each template sets `@page { size: Letter|A4; margin: ... }` itself.
- If Chrome is missing: `GET /version` reports `chrome.found=false`; anything that needs a PDF returns `render_failed` with install instructions; the rest of the API still works.

## 10. Upgrades and compatibility

Goals: updating JobForge by `git pull` (or a new Docker tag) and restarting must keep all data and keep existing agents working.

**Database.** `server/migrations/NNN_name.sql`, applied in order inside one transaction each, recorded in `meta.schema_version`. Forward-only. Before applying any pending migration the runner copies the database to `DATA_DIR/backups/jobforge-v<from>-<timestamp>.db` and prints it. A database newer than the code is refused with a clear message (never downgrade silently). Rules for migration authors: additive changes first (new nullable columns, new tables); no data deletion; every migration ships with a test that builds a database at the previous version (a fixture or the previous migrations) with sample rows and checks the rows after upgrading.

**Documents.** Every stored JSON document has `schema_version`. `server/upgrade.js` holds chains `upgradeProfile(doc)`, `upgradeTrack(doc)`, `upgradeContent(doc)`: pure functions from version N to N+1. The API upgrades any incoming document (so older agents sending version 1 keep working) and upgrades stored documents on read; stored rows are rewritten lazily on the next write, plus eagerly by a migration when a version bump ships. Unknown extra fields are rejected only in `identity` and the top level; free text and `extra` are never rejected.

**HTTP API.** Everything is under `/api/v1`. Within v1 only additive changes: new optional request fields, new response fields, new endpoints. Clients must ignore unknown response fields. Breaking changes go to `/api/v2`, with `/api/v1` kept for at least one minor release. `GET /version` reports `api` and `schema_version`; `schema/openapi.json` has `info.version`.

**Templates.** Built-in templates are versioned (`meta.version`). A new release may ship a new built-in version; applications store `resume_template: "classic@1"` and keep their rendered PDFs, so nothing changes under existing applications. `rerender` uses the template's current version unless `?version=` is given. Custom templates keep every version in `template_versions`.

**UI.** Served by the same server, so UI and API always match. The UI reads `/version` and shows a banner if the server is older than expected.

**Backups and moves.** `npm run backup` copies the database; `GET /export` and `POST /import` move data between instances and versions through a documented bundle (`{bundle_version, profile, tracks, templates, applications, events}`).

`docs/upgrading.md` describes the above for operators; `CHANGELOG.md` records every migration and every API addition.

## 11. Fact check (`server/guard.js`)

Pure function: `check({ content, cover, profile, template }) -> { errors: [], warnings: [] }`, every item `{ path, code, message }`.

Errors (block the write):

- `unknown_employer`: `experience[].company` not in `profile.experience[].company` (case-insensitive).
- `date_mismatch`: dates differ from the profile entry for that company.
- `unknown_project`: project title not in profile projects.
- `unknown_skill`: a skill item not in profile skills (token-level comparison with the loose matching of the legacy tool: exact, or substring when both are at least 4 characters, `Phrase (a, b)` allowed when the phrase and every item are known).
- `unknown_skill_group`: label not among profile skill groups (labels and localized labels both accepted).
- `unknown_education`: education entry not in profile.
- `familiar_unqualified`: an item from `profile.familiar` appears in headline, summary, bullets, tech lines or the cover letter without its qualifier (whole-word match; the qualifier may also be expressed in the content language, e.g. "coursework" or "university" and their Russian equivalents).
- `do_not_claim`: any `do_not_claim[].patterns` regex matches any text of the content or the cover.
- `forbidden_pattern`: any `rules.forbid_patterns[].pattern` matches.
- `cover_too_long`: more words than `rules.cover_max_words`.

Warnings (stored, shown, not blocking):

- `wrong_language`: Cyrillic letters in English content or the opposite (more than a few words).
- `number_not_in_profile`: a number with 2+ digits in a bullet that appears nowhere in the profile text.
- `code_line_counts`: bullets that mention lines of code.
- `bullet_too_long`: a bullet over 300 characters.

Regex patterns from the profile are compiled with a try/catch; an invalid pattern becomes a `profile_rule_invalid` warning, never a crash. Matching uses the `iu` flags.

## 12. Auth and deployment

- First start with no tokens: create an `owner` token, print it once to the console, store only its SHA-256.
- `npm run token -- --name codex --preset agent` prints a new token.
- Default bind `127.0.0.1:8787`. `HOST=0.0.0.0` is allowed; a token is always required.
- The UI shows a token prompt, stores the owner token in `localStorage`, and sends it as a Bearer header.
- Dockerfile: `node:24-slim` plus Chromium; volume `/data`; `CHROME_BIN` preset; `--no-sandbox` enabled by the server when `JOBFORGE_DOCKER=1`.

## 13. UI

Practical and plain: system fonts, one accent colour, light and dark via `prefers-color-scheme`, no animation beyond focus states, no icon fonts, no framework, no build step. Works at 1280 px and on a phone.

Screens:

1. **Applications**: table (title, company, track, verdict, status, updated), status tabs with counts, search, a "same company" badge, a duplicate badge. Row click opens the detail.
2. **Application detail**: vacancy (link, source, text, collapsible), side-by-side PDF viewers for resume and cover (an `<iframe>`), copy-cover-text button, warnings, notes, status buttons (only legal transitions), history list.
3. **About me**: forms for identity, about, rules; row editors for experience, projects, education, skills, familiar, do-not-claim; a JSON tab with the raw document; revision list with restore. A "Fill with an agent" box shows a ready prompt and a one-click `setup` token.
4. **Resumes** (tracks): list and editor (name, when to use, templates, language, JSON editor for `base` with a "Check against profile" button and a live PDF preview).
5. **Templates**: list with previews, fork, edit source in a textarea with "Preview", delete for custom ones.
6. **Settings**: tokens (create, revoke), Chrome status, version, export button, link to the agent guide.

## 14. Testing

- `node --test tests/`. Every route has at least one happy-path and one failure test, run against a real server on port 0 with a temp `DATA_DIR`.
- PDF tests are skipped with a visible message when Chrome is not found.
- Migration test: build database at each historical version, upgrade, assert rows.
- Guard: table-driven tests, one case per code.
- A smoke script `tests/e2e.md` describes the manual agent walkthrough (section 15 of the README).
