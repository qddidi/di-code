---
name: di-code-doc-sync
description: Use when adding, changing, or removing di-code behavior, public APIs, CLI options, Provider configuration, plugins, Session, RPC, or user-visible output; check and update the owning documentation in the same change, while skipping purely internal or formatting-only changes.
---

# di-code Documentation Sync

Use this skill after understanding a feature or behavior change and before considering the change complete. The goal is to keep documented contracts, examples, and user-visible wording aligned with the implementation without adding documentation for changes that consumers cannot observe.

## Decide whether documentation is affected

Documentation is required when a change affects any of these surfaces:

- CLI commands, flags, modes, help text, output formats, diagnostics, or interactive behavior.
- Provider IDs, models, endpoints, environment variables, settings fields, request semantics, or error behavior.
- Public exports, package APIs, plugin manifest fields, tool schemas, slash commands, lifecycle events, or extension contracts.
- Session JSONL fields, persistence, resume/continue behavior, compaction, compatibility, or RPC version and record fields.
- File tools, bash behavior, trust, permissions, path limits, cancellation, security guarantees, or operational prerequisites.
- Model-visible prompts, tool descriptions, result formats, or user-visible TUI behavior.

Documentation is normally not required for private refactors, test-only changes, formatting, build-only changes, or implementation changes whose observable contract is unchanged. State that conclusion in the final change summary when no documentation update is needed.

## Find the owning document

- Root `README.md`: installation, quick start, supported providers, configuration, CLI, security overview, architecture overview, and user behavior.
- `packages/<package>/README.md`: package consumers, public exports, package-specific configuration, semantics, failures, extension points, and examples.
- `docs/开发教程.md`: contributor workflow, source layout, implementation patterns, testing strategy, and extending the system.
- `docs/插件使用指南.md`: plugin manifest, loading and trust, tools, commands, lifecycle events, permissions, and plugin security responsibilities.
- Public source declarations: JSDoc for parameters, returns, errors, ownership, cancellation, side effects, persistence, and wire-format obligations.
- CLI and runtime source: help text, diagnostics, prompts, and tool descriptions when their wording is itself the contract.

Keep each fact in one authoritative home. Link from overview documents to package or guide details instead of duplicating long explanations. Never edit `dist/` or other generated output as the documentation source.

## Synchronize the change

1. Read the changed implementation, tests, package README, and existing root or guide documentation before writing new prose.
2. Search for affected names, commands, environment variables, configuration keys, JSON fields, error messages, and examples with `rg`.
3. Update the owning README, guide, JSDoc, help text, or diagnostic in the same change as the behavior. Remove stale alternatives and examples rather than appending contradictory corrections.
4. Keep exact package names, flags, environment variables, JSON fields, and code identifiers in backticks. Document defaults, limits, failure behavior, cancellation, compatibility, and security consequences when callers rely on them.
5. Update tests when documentation describes model-visible, CLI-visible, protocol-visible, or otherwise observable wording. Do not claim a feature is supported unless the real entry path and implementation support it.
6. Check inbound links and nearby docs for stale names or conflicting instructions.

## Verification

Run the smallest relevant evidence:

```powershell
npm run check
git diff --check
```

For package or behavior changes, also run the owning workspace tests. For CLI, RPC, plugin, Session, Provider, or build-entry changes, use the corresponding real or subprocess tests when available. For release-facing changes, run `npm run build` and `npm run release:dry-run` as required by `di-code-pre-push-checks`.

## Report

Report which documentation owners were updated, which stale references were removed, and which documentation surfaces were intentionally unchanged. If no docs were needed, name the changed behavior and explain why it is not consumer-visible. Report only checks actually run.
