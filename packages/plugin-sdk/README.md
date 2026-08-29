# @di-code/plugin-sdk

`@di-code/plugin-sdk` 是第三方 `di-code` namespace plugin 的稳定公开入口。它只重导出 `@di-code/plugin-runtime` 与 `@di-code/plugin-loader` 的根 API；插件不得导入任何包的 `src`、`dist` 或未声明 subpath。

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

发布 package 必须以 ESM `exports` 声明该 entry，并在 `package.json.diCode.plugins` 中只列出它。Loader 拒绝 default export、缺失的 `name`/`apply`、不兼容 API version 和 package root 外的 export target。完整 manifest、Composition、trust、capability 和 lifecycle 规则见仓库 [`docs/插件使用指南.md`](../../docs/插件使用指南.md)。

Web UI 扩展使用 `WebManifest`、`WebContribution` 和 `WebSlotId`。贡献通过宿主 `WebSlotRegistry` 按 owner 管理，`dispose` 幂等；`componentKey` 是宿主白名单键，不是 URL、HTML 或 JavaScript。插件只能提供声明式只读数据，所需 capability 和 Workspace trust 由宿主检查。

本包根入口导出 `SessionPluginFactory`、`SessionPluginScope` 和 `createSessionPluginFactory`。factory 为每个 session ID 创建独立 scope；scope 只提供 opaque ID、`AbortSignal`、不可变 capabilities 和 disposer 注册，不暴露 `Agent`、`AgentSession`、`SessionManager`、文件句柄或 transport。重复 session ID 会以 `PluginLifecycleError`（`DUPLICATE`）拒绝；初始化失败会回滚已注册的 disposer；scope 与 factory 的 `dispose()` 都幂等，并在释放时 abort signal。factory 卸载会清理所有已创建 scope，适用于 Composition/Fiber 卸载和 HMR 重载。其余阶段 0契约类型与版本语义见 [`docs-vibecoding/plugin/阶段0-公开契约草案.md`](../../docs-vibecoding/plugin/阶段0-公开契约草案.md)。

根入口还导出 `AGENT_HOOK_API_VERSION`、`AgentHookRegistration`、`AgentHookObserver` 和 `AgentHookModifier`。这些 facade 对应宿主单一 Agent loop 的版本 1 生命周期阶段：`request_prepare`、`pre_step`、`request_accept`、`tool_execute_before`、`step_complete`、`turn_complete`、`failed`、`cancelled`。观察型 hook 只读取数据；修改型 hook 仅能在 `pre_step` 通过返回新的 `AgentRequestAssembly` 或结构化 decision 影响请求。hook 接收 `AbortSignal`，可声明 `timeoutMs` 与 `onError`，但不能取得 Agent、Provider、transport 或循环控制权。

Session scope 还提供 `promptSections`。插件通过 `register({ name, order, owner, generate })` 注册动态 system prompt section；名称必须唯一，顺序相同时按注册顺序排列，空结果跳过，生成异常和取消会终止当前请求。每次 Provider request 都读取新的 Agent/Session 快照，返回的 disposer 在插件或 Session 卸载时移除贡献。旧的 `systemPrompt` 仍由宿主作为最低层前缀保留。

Typed Session event 使用 `createSessionEventRegistry()` 注册 `namespace`、`eventName`、`schemaVersion`、`validate` 和可选 `migrate`；事件由宿主 `SessionManager.appendEvent()` 串行追加，payload 上限为 256 KiB，并继承文件锁和 `AbortSignal` 取消语义。`createSessionProjectionRegistry()` 的 `replay()` 只接受完整事件日志并返回版本化状态，适合恢复、fork、compaction 后和冷读；未知事件或迁移失败通过 `diagnostics()` 暴露，不会被静默丢弃。事件不得包含凭据、完整请求体或敏感用户内容。

Session policy facade 使用版本化 `ToolPolicyMode`/`ToolPolicySnapshot`。宿主在每次工具 `execute` 前调用 `SessionToolPolicy.authorize()`，catalog 不因模式变化而隐藏；策略可以读取当前 projection 和 plugin state。`read_only` 的 mutation tool 拒绝、取消、超时和重复切换具有明确错误码，切换事件由宿主持久化，恢复/fork 不依赖内存镜像。
# UserInteraction

`@di-code/plugin-sdk` exports `createUserInteraction` and `UserInteraction` for provider-neutral user prompts. Requests support `question`, `questions`, `choice`, and `approval`, optional choices/free text, `intent`, `requestId`/`toolCallId`, timeout, and `AbortSignal`. Results are structured (`approved`, `value`, `values`, `feedback`) and contain no UI transport credentials. Duplicate request IDs share one pending result; duplicate answers are idempotent. Without a provider the facade rejects with `INTERACTION_UNAVAILABLE`, and disposal cancels pending work.

Hosts can use `createFakeInteractionProvider` in tests. RPC hosts negotiate the `interaction_request` event and answer with `respond_interaction`; legacy `tool_approval`/`approve_tool` remains supported with deny-by-default when no UI channel exists.
# Plan Mode integration

The standalone `@di-code/plan-mode` package consumes the SDK's versioned prompt, Session event, tool-policy, projection, and `UserInteraction` contracts. Hosts provide a `PlanModeAdapter`; plugins must call the host `SessionManager.appendEvent()` through that adapter and must not access Session JSONL directly. See `docs/插件/Plan Mode迁移指南.md` for the integration contract.
