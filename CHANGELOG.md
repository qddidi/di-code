# Changelog

## [0.1.1] - 2026-08-16

### Added

- npm package README files for all public workspaces, with installation, usage, configuration, and GitHub support links.
- npm repository, homepage, and issue-tracker metadata for all public workspaces.

### Changed

- Release dry-run now requires every package tarball to include its README and derives the installed CLI version from package metadata.

## [0.1.0] - 2026-08-16

### Added

- Versioned JSONL RPC protocol with validated request, response, and event envelopes.
- Public `@di-code/coding-agent/rpc` client/server SDK and `di-code-rpc` executable.
- `@di-code/orchestrator` process supervisor with cancellation, crash propagation, bounded stderr diagnostics, and explicit lifecycle states.
- Reproducible five-package release dry-run with tarball inspection, outside-repository installation, CLI conversation smoke, and orchestrator RPC smoke.
- CI quality gates for static checks, build, deterministic tests, production dependency audit, and release dry-run.
