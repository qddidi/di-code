# @di-code/plugin-runtime

Provider-neutral runtime primitives for the pluggable runtime. This package owns `Context`, `Fiber`, service keys, lifecycle statuses, runtime events, capabilities, configuration schemas, and owner-aware service records. It has no dependency on `coding-agent` or product implementations.

`createRootContext()` creates a root scope. `context.child({ isolate: true })` creates a session-style scope that cannot see parent services; a normal child inherits parent services without copying them. `context.set()` and `context.plugin()` register services against the current owner Fiber. A pending async `apply` keeps its services private until it resolves successfully, and any apply failure removes all of its contributions.

`Fiber.dispose()` aborts its signal, waits for an in-flight apply, runs disposers in reverse registration order, and aggregates cleanup errors. Disposal is idempotent. Registrations made after a Fiber starts unloading are rejected. `ServiceRegistry` records retain the owning Fiber and only expose committed records through `getEntry()` and `snapshot()`.

The package is intentionally limited to runtime behavior and fake plugin/service composition. It does not connect CLI, Agent, Provider, file tools, or product implementations. Plugins should import these types and factories from the package root.

Stage 3 adds a typed asynchronous `EventBus<E>`. Handlers run in descending `priority` order with stable registration order; non-critical failures are reported and isolated, while a failed `critical` handler stops the gate and rejects the dispatch. A handler can be bounded by `timeoutMs`, receives an `AbortSignal`, and can be automatically unsubscribed with an option signal. `dispose()` rejects later registration and emission.

`DiagnosticSink`, `createDiagnosticSink`, `PluginLogger`, and `redactSensitiveText` provide diagnostics with `token`, `secret`, `authorization`, and `api_key` values redacted before delivery. `CapabilityView` requires both a trusted project and a plugin-declared capability. `createFakeCapabilityView` is available for deterministic tests; these APIs do not expose Node `fs`, `spawn`, or `process`.
