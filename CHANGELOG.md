# Changelog

All notable changes are recorded here in [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) style. Entries describe migrations, API additions, and operator actions explicitly.

## [Unreleased]

- Fix application PDF locking, file/database consistency, document validation and profile provenance; make bundle transfers consistent and demo seeding non-destructive with usable owner credentials.

### Added

- First release: self-hosted, single-person job application workspace using Node built-ins and SQLite, with no npm dependencies.
- Profile editing and revisions; reusable resume tracks; guarded resume/cover content and writing rules; dry-run checks and factual warnings.
- Built-in classic, compact, modern, and letter layouts; versioned custom templates, forks, PDF and HTML previews; Chrome PDF rendering and page limits.
- Application filing, URL deduplication, same-company context, filtering, review statuses/events, rerendering, and downloadable documents.
- Bearer tokens with agent/setup/owner presets, scoped writes, initial owner provisioning, CLI diagnostics, backups, demo seed, and export/import.
- Web UI for human review, profile/track/template editing, tokens, and settings.
- Agent guide and OpenAPI served at `GET /api/v1/guide` and `GET /api/v1/openapi.json`; Claude Code skill and single-vacancy subagent instructions.
- Docker/Compose deployment with Chromium, Latin/Cyrillic fonts, non-root service, health check, and Node 22.13/24 CI.
- Initial database migration `001_init.sql`: database schema version 1; profile, track, resume, and cover document schema version 1; HTTP API v1. Future upgrades must preserve data with pre-migration backups and tested forward upgrades.
