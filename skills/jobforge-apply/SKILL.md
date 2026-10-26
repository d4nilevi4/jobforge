---
name: jobforge-apply
description: Use when asked to set up a JobForge profile or prepare and file job applications on a supplied JobForge instance using its base URL and token.
---

Use the supplied instance origin as `BASE_URL` and Bearer secret as `TOKEN`. You need HTTP access; obtain vacancy text using your available tools when only a URL is supplied.

First fetch and read the full live guide at `{BASE_URL}/api/v1/guide`:

```sh
curl --fail-with-body -sS -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/v1/guide"
```

Follow that guide as the workflow and schema reference. Do not duplicate its rules from memory.

1. Read profile and track summaries. If the profile is empty, use setup mode only with the required profile-write permission; otherwise report the missing scope to the human.
2. For each vacancy, read its full text, choose apply/maybe/skip, and select the most specific matching track.
3. Tailor verified facts, draft the cover, and record score, angle, gaps, and recruiter questions in notes. For skip, omit documents.
4. Dry-run, repair all errors, inspect warnings, and file one application. Reconcile duplicate URLs with the existing record; never overwrite another worker's work.
5. Flag uncertainty with needs_review when appropriate. Return the application id, verdict, score, and main gaps.

Never invent facts, approve, send, or expose the token. The human reviews and acts next. For delegated runs, use `skills/agents/tailor.md` with exactly one vacancy per worker and exclusive ownership of its record.
