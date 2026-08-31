# @di-code/plugin-sdk

## Stage 3 runtime and Web bridge

`SessionRuntimeManager` keeps each live Session's abort root and resources independent from the selected view. `DurableTaskStore` appends versioned JSONL records; `replayTaskRecords()` rebuilds the last complete sequence and marks tasks without a unique terminal record as `needs_reconciliation` without replaying side effects.

`WebBundleBridge` implements protocol-v1 hello/ready/action messaging with exact origin, source, instance and nonce checks, bounded structured-clone payloads, snapshots, sequence events and `snapshot_required`. Browser bundles receive only host projections and registered actions; they do not receive Node objects, credentials or internal transports.

## Stage 2 runtime context

`createExtensionContext()` creates the host-bound `ExtensionContext` used by ordinary plugins. The context is frozen for the call lifetime and carries the current `session` plus `files`, `subprocess`, `network`, `subagents`, `ui`, `settings`, `diagnostics`, `sessions`, `providers`, and `jobs` facades. An unavailable current session rejects with `SESSION_UNAVAILABLE`; unavailable optional hosts use their documented stable error code. Advanced facades accept explicit target IDs and remain responsible for host permission and resource checks.

`InMemorySubagentService` is a deterministic host implementation for tests and small integrations. Tasks expose `result`, ordered `events`, FIFO `followup()`, and isolated `cancel()`. `reconcileTask()` only accepts `needs_reconciliation` tasks: `resume` requires confirmation that unknown external work has stopped and returns to `waiting`, while `complete` and `cancel` are idempotent terminal decisions. An optional `TaskStore` persists versioned task records and de-duplicates sequence numbers.

`@di-code/plugin-sdk` 是第三方 di-code 扩展的唯一公开入口。新插件使用默认导出的 `setup(api)`，并通过 `api.on`、`registerCommand`、`registerTool`、`registerProvider` 和 `registerWeb` 注册能力；每个注册方法返回幂等 disposer，`api.ctx.signal` 会在卸载时自动 abort。插件不得导入任何包的 `src`、`dist` 或未声明 subpath。

插件也可直接注册 `registerSubagent()` 和 `registerTuiOverlay()`；宿主负责 child task、取消和 overlay 生命周期。`ctx.providers.request()`、`ctx.subprocess.run()` 与 `ctx.jobs.start()` 均由宿主管理，统一支持 `AbortSignal`、超时/输出限制和结构化失败。插件示例无需处理 owner token、wire protocol 或重复 `dispose()`。

自由扩展路线的阶段 0 契约集中在 `freedom-stage0-contracts.ts`，并从本包根入口导出 `ExtensionAPI`、`ExtensionContext`、普通/高级服务、稳定错误码、任务状态、Session 记录和 Web bridge v1 类型。该文件只冻结公共形状，运行时接线由后续阶段完成；旧 namespace facade、owner/capability API 与 `componentKey` 贡献按 [`自由扩展阶段0-真实基线与契约记录.md`](../../docs-vibecoding/plugin-freedom/自由扩展阶段0-真实基线与契约记录.md) 的删除清单迁移。

```powershell
npm install @di-code/plugin-sdk
```

```ts
import { createServiceKey, type PluginDefinition } from "@di-code/plugin-sdk";

export const greetingKey = createServiceKey<string>("acme.greeting");
export const apiVersion = 1 as const;
export const name = "acme.greeting";
export const version = "1.0.0";
export const apply: PluginDefinition["apply"] = (context) => {
	context.set(greetingKey, "hello");
};
```

发布 package 必须以 ESM `exports` 声明该 entry，并在 `package.json.diCode.plugins` 中只列出它。manifest 需要 `apiVersion`、精确 `version`、`packageIntegrity`（宿主计算的 `sha256-*`）和 permissions；Loader 在 import 前完成来源、完整性和 trust 预检，预检失败不会执行入口。完整 Composition、trust、来源 pin 和 lifecycle 规则见 [`docs/插件使用指南.md`](../../docs/插件使用指南.md)。

Web UI 扩展使用 `registerWeb()` 登记 bundle 入口、SRI 和允许的 slot；浏览器只通过当前版本 iframe bridge 获取 projection/action，不接触 Node 对象、Cookie 或凭据。

TUI 扩展使用 `registerTuiOverlay()`；宿主保存 overlay、focus 和 resize 生命周期，插件只提供渲染函数。

本包根入口导出 `SessionPluginFactory`、`SessionPluginScope` 和 `createSessionPluginFactory`。factory 为每个 session ID 创建独立 scope；scope 提供 opaque ID、`AbortSignal`、不可变 capabilities、`hooks`、typed `events`/`projections` registry、动态 prompt sections、`appendEvent()` 和可选 `UserInteraction`，不暴露 `Agent`、`AgentSession`、`SessionManager`、文件句柄或 transport。`appendEvent()` 由宿主绑定到当前 Session 的串行持久化队列；无持久化宿主时会明确失败。重复 session ID 会以 `PluginLifecycleError`（`DUPLICATE`）拒绝；初始化失败会回滚已注册的 disposer；scope 与 factory 的 `dispose()` 都幂等，并在释放时 abort signal。factory 卸载会清理所有已创建 scope，适用于 Composition/Fiber 卸载。宿主将 scope hooks、events 和 projections 接入单一 Session/Agent，并执行迁移、校验和回放。其余阶段 0契约类型与版本语义见 [`docs-vibecoding/plugin/阶段0-公开契约草案.md`](../../docs-vibecoding/plugin/阶段0-公开契约草案.md)。

根入口还导出 `AGENT_HOOK_API_VERSION`、`AgentHookRegistration`、`AgentHookObserver` 和 `AgentHookModifier`。这些 facade 对应宿主单一 Agent loop 的版本 1 生命周期阶段：`request_prepare`、`pre_step`、`request_accept`、`tool_execute_before`、`step_complete`、`turn_complete`、`failed`、`cancelled`。观察型 hook 只读取数据；修改型 hook 仅能在 `pre_step` 通过返回新的 `AgentRequestAssembly` 或结构化 decision 影响请求。hook 接收 `AbortSignal`，可声明 `timeoutMs` 与 `onError`，但不能取得 Agent、Provider、transport 或循环控制权。

Session scope 还提供 `promptSections`。插件通过 `register({ name, order, owner, generate })` 注册动态 system prompt section；名称必须唯一，顺序相同时按注册顺序排列，空结果跳过，生成异常和取消会终止当前请求。每次 Provider request 都读取新的 Agent/Session 快照，返回的 disposer 在插件或 Session 卸载时移除贡献。旧的 `systemPrompt` 仍由宿主作为最低层前缀保留。

Typed Session event 使用 `createSessionEventRegistry()` 注册 `namespace`、`eventName`、`schemaVersion`、`validate` 和可选 `migrate`；事件由宿主 `SessionManager.appendEvent()` 串行追加，payload 上限为 256 KiB，并继承文件锁和 `AbortSignal` 取消语义。`createSessionProjectionRegistry()` 的 `replay()` 只接受完整事件日志并返回版本化状态，适合恢复、fork、compaction 后和冷读；未知事件或迁移失败通过 `diagnostics()` 暴露，不会被静默丢弃。事件不得包含凭据、完整请求体或敏感用户内容。

Session policy facade 使用版本化 `ToolPolicyMode`/`ToolPolicySnapshot`。宿主在每次工具 `execute` 前调用 `SessionToolPolicy.authorize()`，catalog 不因模式变化而隐藏；策略可以读取当前 projection 和 plugin state。`read_only` 的 mutation tool 拒绝、取消、超时和重复切换具有明确错误码，切换事件由宿主持久化，恢复/fork 不依赖内存镜像。
# UserInteraction

`@di-code/plugin-sdk` exports `createUserInteraction` and `UserInteraction` for provider-neutral user prompts. Requests support `question`, `questions`, `choice`, and `approval`, optional choices/free text, `intent`, `requestId`/`toolCallId`, timeout, and `AbortSignal`. Results are structured (`approved`, `value`, `values`, `feedback`) and contain no UI transport credentials. Duplicate request IDs share one pending result; duplicate answers are idempotent. Without a provider the facade rejects with `INTERACTION_UNAVAILABLE`, and disposal cancels pending work.

Hosts can use `createFakeInteractionProvider` in tests. RPC hosts negotiate the `interaction_request` event and answer with `respond_interaction`; legacy `tool_approval`/`approve_tool` remains supported with deny-by-default when no UI channel exists.
# Plan Mode integration

The standalone `@di-code/plan-mode` package consumes the SDK's versioned prompt, Session event, tool-policy, projection, and `UserInteraction` contracts. Hosts provide a `PlanModeAdapter`; plugins must call the host `SessionManager.appendEvent()` through that adapter and must not access Session JSONL directly. See `docs/插件/Plan Mode迁移指南.md` for the integration contract.
