# @di-code/plugin-sdk

`@di-code/plugin-sdk` 是第三方 `di-code` 插件的稳定公开入口。它重导出 `@di-code/plugin-runtime`/`@di-code/plugin-loader` 的根 API，并提供 Session、Agent hook、事件、projection、交互和策略契约；插件不得导入任何包的 `src`、`dist` 或未声明 subpath。

最小插件可以只导出 `setup(api)`。`api.registerCommand()` 注册宿主 `HostCommandRegistry`（是否有入口调用取决于 Composition），`api.registerTool()` 注册 Agent 工具，`api.registerProvider()` 注册 Provider（需要宿主提供对应 registry），`api.on()` 监听运行时事件。宿主命令不会自动进入交互 slash 菜单或 RPC `run_command`。命令、工具和事件监听的 disposer 会绑定当前 Fiber 并在卸载时清理；当前 Provider registry 没有移除接口。`api.registerWeb()` 只保留兼容形状，不发布 Web contribution，WebUI 扩展必须使用 manifest 的 `diCode.web`。

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

发布 package 推荐以 ESM `exports["."]` 声明入口；旧版 `package.json.diCode.plugins` 仅用于兼容。完整 manifest、Composition、trust、capability 和 lifecycle 规则见仓库 [`docs/插件使用指南.md`](../../docs/插件使用指南.md)。

Web UI 扩展使用 `WebManifest`、`WebContribution` 和 `WebSlotId`。贡献通过宿主 `WebSlotRegistry` 按 owner 管理，`dispose` 幂等；`componentKey` 是宿主白名单键，不是 URL、HTML 或 JavaScript。插件只能提供声明式只读数据；Workspace trust 控制是否聚合贡献，组件白名单和运行时 capability 由宿主检查。

Session 级 UI 使用 `createSessionExtensionRegistry()`。插件 scope 可通过 `registerBadge()` 和 `registerUi()` 动态添加徽章、控制、审阅面板或输入占位符；返回的 disposer、scope dispose 和 HMR 卸载都会移除贡献。宿主通过 `SessionExtensionFacade` 向 SessionHost/RPC 提供只读快照，RPC 以 `extension:ui` projection 推送；`componentKey` 仍必须由宿主白名单解析。当前 WebUI 的静态 slot 贡献使用 manifest 的 `diCode.web`，不会直接执行插件 UI 代码。

本包根入口导出 `SessionPluginFactory`、`SessionPluginScope` 和 `createSessionPluginFactory`。factory 为每个 session ID 创建独立 scope；scope 提供 opaque ID、`AbortSignal`、不可变 capabilities、`hooks`、typed `events`/`projections` registry、动态 prompt sections、`appendEvent()` 和可选 `UserInteraction`，不暴露 `Agent`、`AgentSession`、`SessionManager`、文件句柄或 transport。`appendEvent()` 由宿主绑定到当前 Session 的串行持久化队列；无持久化宿主时会明确失败。重复 session ID 会以 `PluginLifecycleError`（`DUPLICATE`）拒绝；初始化失败会回滚已注册的 disposer；scope 与 factory 的 `dispose()` 都幂等，并在释放时 abort signal。factory 卸载会清理所有已创建 scope，适用于 Composition/Fiber 卸载和 HMR 重载。宿主将 scope hooks、events 和 projections 接入单一 Session/Agent，并执行迁移、校验和回放。完整的插件 manifest、Composition、trust 和版本规则见仓库 [`docs/插件使用指南.md`](../../docs/插件使用指南.md)。

根入口还导出 `AGENT_HOOK_API_VERSION`、`AgentHookRegistration`、`AgentHookObserver` 和 `AgentHookModifier`。这些 facade 对应宿主单一 Agent loop 的版本 1 生命周期阶段：`request_prepare`、`pre_step`、`request_accept`、`tool_execute_before`、`step_complete`、`turn_complete`、`failed`、`cancelled`。观察型 hook 只读取数据；修改型 hook 仅能在 `pre_step` 通过返回新的 `AgentRequestAssembly` 或结构化 decision 影响请求。hook 接收 `AbortSignal`，可声明 `timeoutMs` 与 `onError`，但不能取得 Agent、Provider、transport 或循环控制权。

Session scope 还提供 `promptSections`。插件通过 `register({ name, order, owner, generate })` 注册动态 system prompt section；名称必须唯一，顺序相同时按注册顺序排列，空结果跳过，生成异常和取消会终止当前请求。每次 Provider request 都读取新的 Agent/Session 快照，返回的 disposer 在插件或 Session 卸载时移除贡献。旧的 `systemPrompt` 仍由宿主作为最低层前缀保留。

Typed Session event 使用 `createSessionEventRegistry()` 注册 `namespace`、`eventName`、`schemaVersion`、`validate` 和可选 `migrate`；事件由宿主 `SessionManager.appendEvent()` 串行追加，payload 上限为 256 KiB，并继承文件锁和 `AbortSignal` 取消语义。`createSessionProjectionRegistry()` 的 `replay()` 只接受完整事件日志并返回版本化状态，适合恢复、fork、compaction 后和冷读；未知事件或迁移失败通过 `diagnostics()` 暴露，不会被静默丢弃。事件不得包含凭据、完整请求体或敏感用户内容。

Session policy facade 使用版本化 `ToolPolicyMode`/`ToolPolicySnapshot`。宿主在每次工具 `execute` 前调用 `SessionToolPolicy.authorize()`，catalog 不因模式变化而隐藏；策略可以读取当前 projection 和 plugin state。`read_only` 的 mutation tool 拒绝、取消、超时和重复切换具有明确错误码，切换事件由宿主持久化，恢复/fork 不依赖内存镜像。
# UserInteraction

`@di-code/plugin-sdk` exports `createUserInteraction` and `UserInteraction` for provider-neutral user prompts. Requests support `question`, `questions`, `choice`, and `approval`, optional choices/free text, `intent`, `requestId`/`toolCallId`, timeout, and `AbortSignal`. Results are structured (`approved`, `value`, `values`, `feedback`) and contain no UI transport credentials. Duplicate request IDs share one pending result; duplicate answers are idempotent. Without a provider the facade rejects with `INTERACTION_UNAVAILABLE`, and disposal cancels pending work.

Hosts can use `createFakeInteractionProvider` in tests. RPC hosts negotiate the `interaction_request` event and answer with `respond_interaction`; legacy `tool_approval`/`approve_tool` remains supported with deny-by-default when no UI channel exists.
# Plan Mode integration

The standalone `@di-code/plan-mode` package consumes the SDK's versioned prompt, Session event, tool-policy, projection, and `UserInteraction` contracts. Hosts provide a `PlanModeAdapter`; plugins must call the host `SessionManager.appendEvent()` through that adapter and must not access Session JSONL directly. See `docs/插件/Plan Mode迁移指南.md` for the integration contract.
