# @di-code/plugin-runtime

`@di-code/plugin-runtime` owns the host-neutral plugin contract for di-code. It has no filesystem discovery, project trust persistence, CLI parsing, Session storage, TUI rendering, or child-process launcher; those are supplied by a product host such as `@di-code/coding-agent`.

## Runtime contract

The package exports `PLUGIN_API_VERSION` (`1`), manifest validation, `PluginHost`, `PluginScope`, `PluginApi`, contribution types, diagnostics, and the Agent adapters `getContextProvider()` and `getToolMiddleware()`.

Each `PluginHost.load(pluginId, factory)` runs the factory against a private staging registry. Tools, commands, prompt sections, middleware, frontends, restricted UI contributions, subagent providers, projections, and event handlers become visible only after validation succeeds. A successful load returns an active scope. Every registration returns a `Disposable`; scope disposal is idempotent, runs disposers in reverse registration order, continues after individual failures, and reports cleanup failures as an `AggregateError`.

`PluginHost.snapshot()` returns a copy of the current contributions. `getContextProvider()` resolves prompt sections, tool definitions, and middleware immediately before each model request, so a completed tool call uses the request's original snapshot and later requests see new contributions. Prompt sections are sorted by `(order, pluginId, id)`; a rendering failure rejects that request and records a diagnostic. The returned middleware chain follows registration order.

Tool names must use `<plugin-id>__<tool-name>`. Command names are checked against host-reserved names and existing contributions. Manifest permissions are declarations for trust and audit, not a Node.js sandbox.

Migration note: the runtime package does not load the retired `.di-code/extensions/` directory or adapt the retired `ExtensionAPI`/`ExtensionHost`; those names are retained here only to document the removed compatibility baseline.

The package root exports the host-neutral `InteractiveFrontend`, `PluginInteractiveFrontend`, `PluginFrontendController`, and `PluginTerminalFrontendHost` contracts. A replaceable frontend must declare the core capabilities `multiline-input`, `streaming`, `tool-status`, `cancel`, `retry`, `commands`, `model-selection`, `session-selection`, and `compaction`; the coding-agent host rejects incomplete declarations before creating the frontend. A selected frontend receives terminal ownership from its host; `start()` resolves only after it releases that terminal, and `dispose()` is awaited during host cleanup. It does not receive Provider, Agent internals, Session storage, or process stdio.

Normal plugins may instead register `PluginInteractivePanel` data and `PluginToolDetailRenderer` functions. The active frontend receives copies through `PluginFrontendController.ui` and chooses whether to render them. Panels cannot claim input, write ANSI, or rearrange host layout; result renderers are pure formatters for completed tool results.

## Subagent contract

Plugins may register a `SubagentProvider`, but the host owns the request and the Agent loop. `SubagentStartRequest` fixes the parent Session, working directory, selected model, visible tools/plugins, depth, timeout, and maximum result bytes. A provider returns a `SubagentRun` with `wait()`, `sendMessage()`, and idempotent `cancel()`; it must distinguish `completed`, `failed`, and `cancelled` and must not create a second orchestration loop outside the host. The host validates the provider id and parent Session, and wraps provider runs so timeout, cancellation, result-size and credential-redaction limits still apply when a provider does not enforce them itself.

The coding-agent host supplies an in-process provider and the model tools `subagent`, `subagent_list`, `send_message`, `wait`, and `interrupt`. Depth and concurrency are bounded, results are UTF-8 truncated and diagnostic text is credential-redacted. Providers are not a sandbox: filesystem, process, network, and further delegation remain subject to the child Session's explicit tool policy.

## Dynamic plugin protocol

The runtime also owns the in-memory dynamic plugin protocol. `DynamicPluginRuntime.define()` creates an immutable `Package` containing the source hash, declared capabilities, runtime version, and bounded execution limits; it does not execute source, write files, install packages, or start a child process. `startRun()` creates an `ActiveRun` in `starting` state. A host broker may transition it to `active`, `stopping`, `stopped`, or `failed`; terminal transitions and repeated `stop()`/`fail()` calls are idempotent.

`plugin_define`, `plugin_run`, and `plugin_stop` use versioned JSONL records (`version: 1`, request `id`, method, and validated params). A running child may additionally emit `capability_register` and `capability_revoke` records for tool, prompt, middleware, and event contributions. Tool records must use the plugin namespace (`<plugin-id>__<tool-name>`) and an object JSON schema. `parseDynamicPluginCapabilityJsonl()` and `stringifyDynamicPluginCapabilityJsonl()` enforce protocol version, ownership fields, capability kind, schema size, and the shared line limit; duplicate registrations and undeclared capabilities are rejected by the host run registry. Approval, subprocess lifecycle, timeouts, cancellation, and capability enforcement belong to a product host such as `@di-code/coding-agent`. Stopping or failing a run clears all registered capabilities. The child process is not an OS sandbox.

The coding-agent broker bridges registered capabilities into Agent request snapshots. Tool execution, prompt rendering, middleware `next()`, and event handlers use versioned `invoke`/`invoke_result` records with correlated `invokeId` values; middleware host callbacks use `middleware_next`/`middleware_next_result`. The host sends only `DynamicPluginContext` (`cwd`, mode, project trust, and model), and sends `cancel` when the caller's `AbortSignal` is aborted. Invocation results are validated by the host before entering the Agent loop.

源码、示例和问题反馈：<https://github.com/qddidi/di-code>
