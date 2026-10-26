# API overview

JobForge serves a REST API at `/api/v1` and its review UI at `/`. It stores one person's profile, resume variants (tracks), templates, and one application per vacancy. Agents file drafts; a human reviews, approves, and sends externally.

Read the [agent guide](agent-guide.md) for the setup/application workflow, factual constraints, complete curl example, and error repairs. On a running server, fetch `/api/v1/guide` with a Bearer token to get examples containing that request's origin. The [OpenAPI 3.1 document](../schema/openapi.json), also available at `/api/v1/openapi.json`, describes every registered route, its scope, and request/response shapes. Its relative server URL is `/api/v1`.

```sh
BASE_URL=http://127.0.0.1:8787
curl -sS "$BASE_URL/api/v1/version"
curl -sS -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/v1/guide"
curl -sS -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/v1/openapi.json"
```

JSON is used except for guide, previews, and application files. Send `Authorization: Bearer <token>` for every API endpoint except `/version`. Preset `agent` grants read and application/track/template writes; `setup` additionally grants profile writes; `owner` has all scopes. Missing scopes produce a 403 naming the required scope. Only the human should exercise approval/admin powers.

| Resource | Main operations |
| --- | --- |
| `/profile` | Read, replace, merge patch; `/schema` and `/revisions` support setup and history. |
| `/tracks` | List/get reusable variants; PUT/DELETE by slug. |
| `/templates` | List/get built-ins and custom layouts; fork, version custom HTML, preview PDF/HTML. |
| `/check` | Dry-run an application, including fact checks and PDF page limits; saves nothing. |
| `/applications` | Create/list, get/replace editable records, status history, rerender, and retrieve files. |
| `/tokens` | Admin token creation/list/revocation; secrets returned once. |
| `/export`, `/import` | Admin portability bundle; import requires an empty instance. |

Errors use `{error:{code,message,details:[{path,code,message,...}]}}`. Read details for repairs; validation/render failures use 422, normalized vacancy URL duplicates use 409, and missing/invalid tokens use 401. Successful creation usually returns 201; responses may add fields within v1. Ignore unknown response fields. Requests are limited to 2 MB; there is no batch endpoint or Idempotency-Key support. Use the vacancy URL and returned id to reconcile retries.

Profile, track, resume, and cover document formats currently use `schema_version: 1`. Identity comes from the profile at render time. Resume skills use a string of items per group; profile skills use arrays. The guard checks structured facts and writing rules, but agents must verify all claims themselves. `verdict: "skip"` records a decision with no documents.

See [templates](templates.md) for layout authoring and [upgrading](upgrading.md) for backups, migration behavior, portability, rollback, and known compatibility limits.
