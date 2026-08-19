---
name: di-code-doc-standards
description: Use when writing, moving, reviewing, or auditing di-code documentation; decide where README content, the Chinese development tutorial, plugin guide, API details, CLI behavior, and architecture rationale belong.
---

# di-code Documentation Standards

Documentation is part of the public contract. Read the owning code and tests before editing prose. Keep one authoritative home for each fact and link to it from shorter documents.

## Choose the document

- **Root `README.md`:** installation, quick start, supported providers, configuration, CLI modes, security overview, architecture overview, and user-observable behavior.
- **`packages/<package>/README.md`:** package consumers, public exports, setup, semantics, failure behavior, extension points, and package-specific examples.
- **`docs/开发教程.md`:** contributor workflow, source layout, implementation patterns, testing strategy, and how to extend the system.
- **`docs/插件使用指南.md`:** plugin manifest, loading/trust, tool and command APIs, lifecycle events, permissions, and plugin author security responsibilities.
- **JSDoc near public exports:** parameters, return distinctions, throws/rejections, ownership, cancellation, side effects, and durable or wire-format obligations.
- **Inline comments:** only non-obvious invariants, lifecycle ordering, security constraints, or rationale that cannot live in a linked design document.

Do not move package API detail into the root README merely to make one page longer. Do not add a new documentation hierarchy when an existing owner can hold the fact. Generated `dist/` files are never documentation sources.

## Writing requirements

Document present behavior, exact names, defaults, limitations, error conditions, and observable verification. Keep paragraphs focused and examples runnable from the current repository. Update README, JSDoc, tests, and CLI help together when a public contract changes.

For architecture changes, record the decision and alternatives in a durable project document before repeating the rationale in multiple package READMEs. For plugin, Session, RPC, or Provider changes, explicitly document versioning, compatibility, cancellation, and security consequences.

## Review workflow

1. Identify the owning surface and read its implementation.
2. Search for existing documentation of the same fact before adding prose.
3. Check every command, package name, environment variable, file path, and JSON field against code or tests.
4. Remove obsolete instructions and stale examples rather than layering corrections on top.
5. Run `npm run check`, `git diff --check`, and behavior tests when wording is model-visible, CLI-visible, or part of an API contract.

Reject change narration, copied implementation walkthroughs, unsupported promises, vague security claims, and documentation that describes tests as proof without stating the observable behavior.
