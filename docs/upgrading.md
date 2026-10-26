# Operating and upgrading JobForge

Use Node >=22.13 and a Chromium-family browser. `DATA_DIR` defaults to `./data`; the database is `DATA_DIR/jobforge.db`. `node server/cli.js doctor` reports Node, directory, schema, and Chrome status. Default HTTP binding is `127.0.0.1:8787`; change `HOST` and `PORT` deliberately. Check `GET /api/v1/version` after any deployment.

## Before updating

Read [CHANGELOG](../CHANGELOG.md), including every migration, document-version change, new endpoint/field, template version change, and operator action between your current and target releases. Save the current release identifier and a backup outside the instance's writable volume. Database backups include token hashes and profile data; restrict their access.

```sh
npm run backup
node server/cli.js export --out jobforge-export.json
```

Set the same `DATA_DIR` for the CLI and server. Manual backups are consistent SQLite snapshots named `DATA_DIR/backups/jobforge-manual-<timestamp>.db` (made with `VACUUM INTO`, safe while the server is running). Export is optional portability insurance; it excludes tokens and derived PDFs. Database snapshots retain tokens. Copies of PDFs are useful when exact historical rendering must be retained.

## Startup and automatic migrations

Stop the service, update to the intended release (`git pull` for a source deployment, or build/pull the intended Docker image), and restart with the same data directory/volume. Do not remove the Compose named volume.

Startup opens SQLite in WAL mode, enables foreign keys, reads `server/migrations/NNN_name.sql` in numeric order, and checks `meta.schema_version`. A newer database than the code supports is refused; no implicit downgrade occurs. Before pending migrations on an existing versioned database, the runner makes one consistent snapshot at `DATA_DIR/backups/jobforge-v<from>-<timestamp>.db` and prints its path. A fresh version-zero database does not get this automatic backup. Each migration has its own transaction; if a later migration fails, earlier successful migrations remain applied and the failing one rolls back. Preserve the printed snapshot before retrying.

If no token rows exist, startup prints one owner token once and stores only its SHA-256 hash. Save that secret. Chrome availability is reported by `/api/v1/version`; missing Chrome leaves non-rendering endpoints usable but PDF work fails. In Docker, `JOBFORGE_DOCKER=1` reaches the renderer and enables Chrome `--no-sandbox` and `--disable-dev-shm-usage`.

Documents carry their own `schema_version`, independent of the database version. Incoming and read documents pass through pure upgrade chains; writes save upgraded JSON. Missing document versions are treated as 1. Unsupported future document versions fail with instructions to update the server, rather than stripping fields. A release that bumps document formats must also supply an eager database migration for stored rows. Current profile, track, resume, and cover formats are all version 1.

After restarting, check app/API/schema versions and `chrome.found`, read the profile and tracks, inspect existing application PDFs, and dry-run a representative application. A health check only proves the version endpoint responds; it does not prove Chrome can render. Do not approve or send test applications.

## Rollback

Stop all server and CLI processes using the data directory first. Restore the pre-upgrade snapshot and deploy the previous code/image together: older code refuses a newer database. Restoring a backup loses writes made after that snapshot; preserve the failed-upgrade directory so they can be examined and recovered deliberately.

For a source deployment, set the variables to your actual saved values before running these example commands:

```sh
JOBFORGE_DATA_DIR=/path/to/data
JOBFORGE_BACKUP=/path/to/saved/jobforge-v1-timestamp.db
JOBFORGE_PREVIOUS_VERSION='your-saved-release-tag-or-commit'
# The service must already be stopped. Keep the entire original directory,
# including WAL/SHM files and derived PDFs, out of the restored location.
mv "$JOBFORGE_DATA_DIR" "${JOBFORGE_DATA_DIR}.before-rollback"
mkdir -p "$JOBFORGE_DATA_DIR"
cp "$JOBFORGE_BACKUP" "$JOBFORGE_DATA_DIR/jobforge.db"
git checkout "$JOBFORGE_PREVIOUS_VERSION"
DATA_DIR="$JOBFORGE_DATA_DIR" node server/cli.js doctor
DATA_DIR="$JOBFORGE_DATA_DIR" npm start
```

Replace the example paths and release identifier with the saved values. Use a backup path outside the moved directory. Restore directory/file ownership for the service account. Do not restore over live SQLite or leave an unrelated `jobforge.db-wal` / `jobforge.db-shm` beside the restored file. For Docker, stop Compose, restore the snapshot into the named volume with the `node` user's ownership, and rebuild/select the previous release image before starting it.

PDFs in `DATA_DIR/files/<id>/` are derived and not part of database backups. Restore matching saved PDFs when available, or rerender editable records using the previous release's templates. The public rerender endpoint refuses `sent`, `interview`, `offer`, and `rejected`; preserve their original PDFs separately when historical artifacts matter.

## Move between instances

Use admin tokens on both instances. The target must have no profile, profile revisions, tracks, custom templates, applications, or events; initial owner token rows are allowed. Keep its owner token: source tokens are not exported/imported.

```sh
curl --fail-with-body -sS -H "Authorization: Bearer $SOURCE_TOKEN" \
  "$SOURCE_URL/api/v1/export" -o jobforge-export.json
curl --fail-with-body -sS -X POST -H "Authorization: Bearer $TARGET_TOKEN" \
  -H 'Content-Type: application/json' --data-binary @jobforge-export.json \
  "$TARGET_URL/api/v1/import"
# For exports larger than the HTTP 2 MB body limit, run on the target host:
DATA_DIR=/path/to/fresh-target-data node server/cli.js import --file jobforge-export.json
```

Bundle version 1 contains `bundle_version`, `exported_at`, `app_version`, `schema_version`, `profile`, `profile_revisions`, `tracks` (id-to-document object), `templates` (custom metadata and all source versions), `applications`, and `events`. Built-ins ship with code; files and tokens are excluded. Import upgrades documents and restores rows transactionally, then attempts PDF regeneration. Inspect `imported`, `rendered`, and every `render_errors` entry: HTTP success does not imply all PDFs were regenerated. Missing Chrome or unavailable historical built-in versions can leave PDFs absent. Import refuses unknown bundle versions; upgrade the target server rather than editing the bundle version. CLI import has no HTTP body cap.

## Compatibility promises and current limits

`/api/v1` evolves additively: new optional request fields, response fields, and endpoints. Agents must ignore unknown response fields. Breaking changes belong in `/api/v2`, with v1 retained for at least one minor release. App version is in OpenAPI `info.version`; `/version` reports app, API, and database schema versions. UI files ship with the same release as the server.

Applications store template references such as `classic@1` and retain their PDFs until explicitly changed. Custom templates retain all source versions. Rerender defaults to the current template, or uses `?version=N` for an available version. Built-ins currently load only the version on disk, so old built-in source is not automatically archived and an old pinned version may be unavailable for HTML or import rendering. Keep prior releases and historical PDFs if required.

Unknown top-level profile/track/resume/cover fields and unknown profile identity fields are rejected. Nested entries are generally permissive and `extra` remains free. Template context uses `paragraphs` and `identity.links` (see [templates](templates.md)). Approval checks document presence, not an independent content-freshness hash. The public rerender restrictions mean a database backup alone cannot restore every historical PDF through that endpoint; keep those files separately when required.

## For contributors: add a migration or document upgrade

- Add the next unique `NNN_name.sql`; never rewrite shipped migrations or reduce the schema version. Prefer nullable columns/new tables; never delete user data.
- Add a test building the previous schema with sample rows, then run the real migration runner and assert rows, version, and the pre-migration backup survive. Cover failure/rollback and newer-database refusal where relevant.
- For a document change, add a pure N-to-N+1 transform in `server/upgrade.js` with `registerUpgrade(kind, N, transform)` in ascending order; update schemas and eager storage migration. Cover the profile, track base, application resume/cover, and revisions affected by the change. Never mutate the input or downgrade a future version.
- Update examples, OpenAPI, guide/operator instructions, and CHANGELOG with the exact migration number, compatibility effects, and recovery steps. Add only optional v1 request fields; use a new API major for breaking changes.

Worked example (hypothetical, not shipped): add an optional private `summary_note` column to applications with `002_application_summary_note.sql` containing `ALTER TABLE applications ADD COLUMN summary_note TEXT;`. A test creates schema 001, inserts a fictional application, closes/reopens it through the runner, and confirms the row is unchanged, the new column is null, schema is 2, and the version-1 backup contains the original row. No document bump is needed for that SQL-only change.

For a separate hypothetical document-v2 addition, register `registerUpgrade('content', 1, doc => ({ ...doc, new_optional_field: '' }))`, extend the content schema, and migrate every stored content document and embedded track base through the same transform. Test version-1 HTTP input upgrading to v2, repeated reads, and refusal of future versions. CHANGELOG must distinguish the database migration number from the document version; never copy these illustrative changes into a release without implementing and testing the full chain.
