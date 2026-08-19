---
name: di-code-code-review
description: Use when reviewing a di-code pull request, branch, or substantial change; inspect correctness, public interfaces, Agent Loop behavior, Provider mapping, tool security, Session durability, RPC protocols, plugins, TUI integration, and asynchronous lifecycle cleanup.
---

# Reviewing di-code Changes

This skill is review guidance, not a mechanical checklist. Read the root `AGENTS.md`, the affected package README, public entry points, tests, and surrounding implementation. Prioritize defects, regressions, security issues, lifecycle races, and missing evidence over style preferences.

## Review order

1. Establish the actual diff and affected package boundaries with `git diff --name-status` and `git diff --stat`.
2. Trace every changed public type or method to its callers, implementations, tests, and documentation.
3. Follow failure, cancellation, teardown, and disposal paths, not only the happy path.
4. Check that the tests exercise the real entry path when the change involves CLI, plugins, subprocesses, built output, or RPC.
5. Run focused checks from `di-code-pre-push-checks` when review evidence is missing or stale.

## High-risk surfaces

- **Agent Loop:** verify one owner controls turns, tool calls, results, cancellation, retries, and termination. Look for duplicate loops, stale state after abort, unbounded recursion, tool results attached to the wrong request, or errors that silently become assistant text.
- **Provider adapters:** verify request fields, streaming event ordering, tool-call assembly, usage, reasoning, images, HTTP errors, timeouts, and provider-specific quirks are normalized at the `ai` boundary rather than leaking into `agent`.
- **Tools:** treat model arguments and plugin input as untrusted. Check absolute path resolution, project-root and symlink escapes, command injection, cwd, timeout, output limits, encoding, overwrite semantics, and AbortSignal propagation.
- **Session:** treat JSONL fields and ordering as durable data. Check atomic or coordinated writes, concurrent append behavior, resume/continue semantics, malformed records, context compaction, version changes, and whether model-visible state can be reconstructed.
- **RPC and orchestrator:** verify `version`, request `id`, event `requestId`, JSONL framing, stdout/stderr separation, concurrent requests, cancel races, process exit, stderr truncation, and error propagation through both client and server.
- **Plugins:** check manifest and entry validation, trust behavior, registration collisions, tool naming, handler isolation, cleanup, and the fact that declared permissions are audit metadata rather than a Node sandbox.
- **TUI and CLI:** check terminal width, ANSI state, input cancellation, non-TTY behavior, print/JSON/interactive mode differences, and stable model- or user-visible strings.

## Common review failures

Flag abstractions with no production consumer, public methods added for one internal caller, duplicated representations of the same state, speculative configuration knobs, silent compatibility fallbacks, swallowed exceptions, and tests that only restate implementation details. Prefer a maintained dependency or Node builtin only when it removes real implementation and test surface without relocating the same complexity.

## Findings

Report each finding with severity, exact file and line, impact, and a concrete reproduction or reasoning path. Lead with actionable defects; separate open questions from findings. If no issue is found, state that clearly and name residual test gaps or unverified external-provider behavior. Do not report a missing check when the relevant check already passed.
