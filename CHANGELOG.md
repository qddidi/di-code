# Changelog

## [0.1.0] - 2026-08-16

### Added

- Versioned JSONL RPC protocol with validated request, response, and event envelopes.
- Public `@di-code/coding-agent/rpc` client/server SDK and `di-code-rpc` executable.
- `@di-code/orchestrator` process supervisor with cancellation, crash propagation, bounded stderr diagnostics, and explicit lifecycle states.
- Reproducible five-package release dry-run with tarball inspection, outside-repository installation, CLI conversation smoke, and orchestrator RPC smoke.
- CI quality gates for static checks, build, deterministic tests, production dependency audit, and release dry-run.
