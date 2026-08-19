---
name: di-code-api-and-interface-design
description: Use when designing or changing di-code public APIs, TypeScript interfaces, npm workspace boundaries, Provider protocols, Agent events, plugin contracts, Session formats, RPC records, or TUI component interfaces.
---

# di-code API and Interface Design

Design interfaces that are stable, explicit, difficult to misuse, and aligned with the package ownership model. This skill applies before implementation when a change crosses a package, process, persistence, model, plugin, or user-visible boundary.

## Identify the interface owner

- `@di-code/ai` owns Provider-independent messages, models, tools, schemas, stream events, and Provider normalization.
- `@di-code/agent` owns Agent state, turns, tool execution orchestration, cancellation, and Agent events.
- `@di-code/coding-agent` owns CLI behavior, built-in tools, plugins, Session persistence, modes, and RPC assembly.
- `@di-code/orchestrator` owns process supervision through the public RPC client; it must not depend on coding-agent internals.
- `@di-code/tui` owns ANSI rendering, input, layout, components, and terminal interaction primitives; it must not depend on Provider or product-layer logic.

Before adding a method, event, option, or package, name its owner, production consumer, lifecycle, and failure behavior. Prefer a private capability passed to one internal consumer over expanding a generic public service for a single caller.

## Contract first

Define the TypeScript contract and observable semantics before implementation. Document:

- accepted inputs, defaults, output variants, and whether values are borrowed or owned;
- errors, rejection behavior, cancellation, timeouts, retries, and cleanup;
- event ordering, concurrency, idempotency, and terminal states;
- persistence or wire-format fields, versioning, compatibility, and unknown-value handling;
- model-visible or user-visible text, tool descriptions, and result rendering.

Keep public exports at package root entry points. Do not make consumers import another package's `src` or `dist` internals. Update types, JSDoc, tests, README, and protocol documentation in the same change through `di-code-doc-sync`.

## Boundary validation

Validate untrusted data at actual boundaries:

- Provider HTTP responses and streamed chunks;
- model-generated tool calls and JSON arguments;
- environment variables and `.di-code/settings.json`;
- Session JSONL records and files;
- JSONL RPC input/output and subprocess messages;
- plugin manifests and dynamically loaded entry points;
- filesystem paths, URLs, shell commands, and process output.

After a value passes the parser or boundary validator, trust the TypeScript contract at typed same-process calls. Do not add defensive runtime validation solely for values that the static interface already guarantees. Do not treat a JSON schema as sufficient validation for path, URL, command, security, or business constraints.

## Protocol and type patterns

- Use discriminated unions for messages, stream events, Agent events, RPC records, tool results, and lifecycle states. Closed unions must handle every case; extensible unions need a documented unknown-value path.
- Separate caller input from produced output. Inputs should not pretend to contain generated IDs, timestamps, usage, normalized fields, or server-owned state.
- Brand opaque cross-boundary identifiers such as Session ID, Request ID, Tool Call ID, and process or plugin IDs; do not use interchangeable bare strings when confusion is possible.
- Keep registration APIs explicit and return a disposer when a contribution can be removed. Define duplicate registration and teardown behavior.
- Prefer additive protocol evolution. New optional fields may be compatible; changing field meaning, removing fields, changing event order, or changing durable record structure requires an explicit version or migration decision.
- Keep errors predictable within each boundary. Distinguish invalid input, provider failure, cancellation, timeout, process failure, persistence failure, and user-visible tool failure rather than converting all failures to generic text.

## Agent and Provider interfaces

The Agent owns the model-tool loop. A Provider supplies normalized stream events; it must not start another Agent loop or encode coding-agent-specific policy. Tool execution belongs to the Agent or its declared tool owner, with validated arguments, cancellation propagation, bounded results, and a clear result-to-request association.

When changing a Provider or Agent interface, trace both directions: request construction into the external API, stream parsing back into normalized events, event delivery to consumers, tool results into the next turn, and final output into CLI, Session, plugin, and RPC projections. Preserve ordering and terminal-event guarantees across success, error, and cancellation paths.

## Session and RPC interfaces

Treat Session JSONL and RPC JSONL as durable or wire contracts, not internal object dumps. Specify record discriminants, required fields, version values, request/event correlation, append ordering, recovery behavior, framing, stdout/stderr ownership, and behavior for malformed or unknown records.

Changes to Agent events, Session records, or RPC fields must update all projections: persistence, resume, compaction, CLI modes, RPC server/client, orchestrator, SDK examples, tests, and documentation. Do not silently drop a field or accept an old format without an explicit compatibility policy.

## Plugin and TUI interfaces

Plugin APIs must define manifest validation, trust and loading behavior, registration names, schema validation, `AbortSignal` use, handler error isolation, disposal, and model-visible tool or command semantics. Declared permissions are metadata for validation and audit, not a Node.js sandbox.

TUI component APIs must keep layout and terminal state explicit. Define dimensions, focus, keyboard events, cancellation, ANSI output, and non-TTY behavior. Keep components reusable by passing data and callbacks; do not make TUI components own Provider calls, Agent turns, or Session persistence.

## Compatibility decisions

Before changing an existing interface, search all production consumers, tests, examples, docs, dynamic loader paths, and wire strings with `rg`. Classify the change as additive, behavior-compatible, versioned, migrated, or intentionally breaking. Do not add compatibility shims by default while the project has no consumer promise; when a shim is required, document its removal condition and test both paths.

Prefer one canonical representation and one active version. Do not maintain parallel APIs or duplicate event/state representations unless each has a distinct owner and consumer-visible purpose.

## Verification

For an interface change, run the focused owning workspace tests and `npm run check`. Add adjacent package tests when the contract crosses packages. Run `npm run build` for public exports, package manifests, built entry points, or RPC/subprocess paths. Use `npm run release:dry-run` when package metadata or published API surfaces change.

Review the resulting JSDoc, README, CLI help, diagnostics, model-visible tool descriptions, Session records, and RPC transcripts. Finish with `git diff --check` and report actual checks, remaining compatibility risks, and deliberately unchanged consumers.
