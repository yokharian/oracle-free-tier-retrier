# Development and releases

```bash
npm install
npm run typecheck
npm run build
npm test
```

The source is split by responsibility:

- `src/index.ts` — CLI shell: prompts, rendering, argument handling, entry point.
- `src/core.ts` — OCI client, planning, networking, retry engine, and run orchestration.
- `src/types.ts` — shared types and YAML schemas.
- `src/utils.ts` — small pure helpers.

Publishing is automated. A `v*.*.*` tag runs the test matrix (Windows, macOS, Linux × Node 22 and 24, plus a Node 24 dist smoke) and publishes to npm through Trusted Publishing (OIDC), with provenance. The same tag — and every push to `master` — builds the multi-arch Docker image (`linux/amd64`, `linux/arm64`) and pushes it to GHCR.

The Node floor is a security requirement: Node 22.23.4, 24.22.1, and 26.12.1 are the first releases patched for CVE-2026-111497, a high-severity Brotli decoder flaw. Node 20 is end-of-life and has no patched release.
