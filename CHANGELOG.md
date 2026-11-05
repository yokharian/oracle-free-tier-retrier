# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Restored the product requirements as `docs/prd.md` and refreshed them for the current architecture.

### Changed

- Split the CLI shell (`src/index.ts`) from the deployment engine (`src/core.ts`), centralized shared types in `src/types.ts`, and moved small helpers to `src/utils.ts`.
- Removed redundant section-divider comments and deduplicated the empty-network fallback in the run state helpers.
- Rewrote the README around the npx path, moved Docker to the end, and extracted the CLI, configuration, and development references into `docs/`.

## [0.6.0] - 2026-11-04

### Added

- Persist discovered Availability Domains in `state.availability_domains`.
- Report the Availability Domains in use and the reason an AD was skipped.
- Warn when a region exposes a single Availability Domain, since retries repeat there.
- Add `--delay` as the primary retry-interval flag; `--interval-seconds` remains an alias.

### Changed

- Retry cycles now start at the highest-numbered Availability Domain (AD-3 → AD-2 → AD-1).

## [0.5.3] - 2026-11-01

### Changed

- Version bump and TypeScript type fixes.

## [0.5.2] - 2026-11-01

### Added

- Interactive OCI configuration setup.

### Changed

- Defaults and attempt logs now live under `~/.oci`.
- Capacity retries iterate every Availability Domain.
- Bun was removed from the development workflow.

## [0.5.1] - 2026-10-25

### Added

- Docker image publishing to GHCR, Compose setup, and SSH key generation.
- Dependabot coverage for npm and GitHub Actions.

### Fixed

- OCI service errors are classified by error shape, so duplicate SDK copies do not hide status and code information.

### Security

- Require Node.js 22.23.4+, 24.22.1+, or 26.12.1+, the first releases patched for CVE-2026-111497.

## [0.5.0] - 2026-10-19

### Changed

- Migrated the OCI client to the official TypeScript SDK.
- Split the source into `index.ts`, `types.ts`, and `utils.ts`.

## [0.3.2] - 2026-10-18

### Fixed

- Strip null fields from security-list update bodies.
- Correct core API paths to the 20160918 version.

## [0.3.0] - 2026-10-18

### Added

- VCN discovery retries another compartment when authorization fails.

## [0.2.1] - 2026-10-18

### Fixed

- Read the CLI version from `package.json`.

## [0.2.0] - 2026-10-18

### Added

- Initial public release: deploy an OCI VM and retry capacity failures.
