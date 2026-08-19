---
name: di-code-find-simplifications
description: Use when auditing di-code for non-obvious simplifications; find dead APIs, duplicated state, speculative configuration, unnecessary package boundaries, hand-rolled utilities, overbuilt lifecycle machinery, and compatibility code without current consumers.
---

# Finding di-code Simplifications

This skill produces evidence-backed cleanup candidates, not a list of things that look complicated. Read `AGENTS.md`, package READMEs, architecture sections, tests, and public entry points before proposing removal or consolidation.

## Strong candidates

- A public method, event, config field, helper, package, or test fixture has no production consumer.
- Two representations mirror the same Provider, Agent, Session, RPC, or UI fact without independent ownership.
- A package or abstraction exists only to support tests, a demo, or one internal caller and adds dependency or release cost.
- A compatibility path, fallback, defensive copy, or lifecycle flag protects an obsolete format or unreachable state.
- Hand-written parsing, framing, retry, glob, diff, or validation code duplicates a suitable Node builtin or maintained dependency, and the replacement deletes more code and tests than it adds.

Do not call intentional Provider adapters, Agent/tool boundaries, Session durability, RPC framing, or TUI separation redundant without tracing their distinct consumers and failure guarantees.

## Investigation

Use `rg` to search exact symbols, event names, config keys, package names, wire strings, and both method call forms. Classify references as production, tests, docs, examples, scripts, generated files, or ambiguous. Read dynamic loader/config paths because static search can miss them. Use `npm run check` and existing tests as evidence, not as a substitute for understanding ownership.

For async code, map each state flag, promise, disposer, cancellation path, and callback to an owner and transition. Preserve machinery that protects publication ordering, rollback, callback containment, process ownership, or dispose-to-quiescence. For a dependency swap, inspect maintenance, compatibility, transitive cost, and residual glue before proposing it.

## Output and scope

For each candidate, state the exact surface, current consumers, deletion or consolidation, behavior sacrificed, risks, and acceptance evidence. Reject a candidate when a production caller exists, a durable or wire contract survives, an existing design decision owns it, or the cleanup would only relocate complexity. Tiny local cleanups belong in code or a focused TODO, not a broad architecture proposal.

Do not edit code solely because a candidate was found unless the user requested implementation. When implementation is requested, add or update regression tests, documentation, and package boundaries together; run the smallest relevant checks and `git diff --check`.
