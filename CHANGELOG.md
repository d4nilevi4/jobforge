# Changelog

All notable changes are recorded here in [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) style. Entries describe migrations, API additions, and operator actions explicitly.

## [Unreleased]

## [0.1.0] - 2026-10-26

First release: a self-hosted, single-person job application workspace built on Node built-ins and SQLite, with no npm dependencies.

### Added

- Profile editing with revisions, reusable resume variants (tracks), guarded resume and cover content, writing rules, dry-run checks and factual warnings.
- Built-in classic, compact, modern and letter templates; versioned custom templates, forks, HTML and PDF previews; Chrome PDF rendering with page limits.
- Application filing, URL deduplication, same-company context, filtering, review statuses with history, rerendering and downloadable documents. PDFs and database rows change together.
- Bearer tokens with agent, setup and owner presets, scoped writes, initial owner provisioning, CLI diagnostics, backups, a non-destructive demo seed, and export/import.
- Web UI for review, profile, resume variants, templates, tokens and settings.
- Agent guide and OpenAPI document at `GET /api/v1/guide` and `GET /api/v1/openapi.json`; a Claude Code skill and a single-vacancy sub-agent definition.
- Docker and Compose deployment with Chromium, Latin and Cyrillic fonts, a non-root service and a health check; CI on Node 22.13 and 24.
- Initial database migration `001_init.sql` (database schema version 1); profile, track, resume and cover document schema version 1; HTTP API v1. Future upgrades must preserve data with pre-migration backups and tested forward upgrades.

[Unreleased]: https://github.com/d4nilevi4/jobforge/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/d4nilevi4/jobforge/releases/tag/v0.1.0
