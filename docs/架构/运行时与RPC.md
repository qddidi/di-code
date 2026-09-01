# 运行时与 RPC 架构

## Composition 启动

CLI、Web、RPC 和 interactive 都从 Root Context 开始，由 Composition Loader 装配 namespace entries。默认层顺序：

```text
base -> mode -> ~/.di-code/composition.yml -> <work-root>/.di-code/composition.yml -> --composition
```

项目层要求 trust；受管 enabled plugin 会追加到 Loader。Loader 为每个 entry 创建 owner Fiber，按依赖拓扑加载；失败时 required entry 终止并回滚，optional entry 记录 skipped。dispose 按 owner 释放 contribution、监听器和外部资源。

## Agent loop

CLI/RPC/Web 都调用同一个 `AgentSession`/`@di-code/agent` loop。一次 prompt 串行经历：追加 user message、调用 `Provider.stream()`、发布 message/tool 事件、校验工具参数、执行工具、追加 tool result，再请求下一轮，直到 stop reason。Provider 不执行工具，CLI/TUI/Web 不实现第二套循环。AbortSignal 会传播到 Provider、工具、MCP 和子进程。

Agent loop 的生命周期 hook 使用 `apiVersion: 1`，按注册顺序串行运行 `request_prepare`、`pre_step`、`request_accept`、`tool_execute_before`、`step_complete`、`turn_complete`、`failed` 和 `cancelled`。观察型 hook 只能读取事件；修改型 hook 只允许在 `pre_step` 返回新的只读 request assembly/decision，不能通过共享对象修改请求。每个 hook 接收 `AbortSignal`，可声明超时和 `ignore`/`fail` 错误策略；监听器 disposer 幂等，失败会保持 Agent 的终态收敛。

## WorkspaceCoordinator 与 SessionRuntime

`WorkspaceCoordinator` 按 principal 和真实 workspace 管理多个 `SessionRuntime`。每个 runtime 独占自己的 `AgentSession`、JSONL 锁、事件订阅和 MCP 连接；MCP client 未证明可并发共享，因此固定采用 runtime 独占连接。运行通过不可变 `RunContext`（`sessionId`、`runId`、`requestId`）归属。同一 session 同时只允许一个 primary run，第二个 prompt 返回 `BUSY`；不同 session 可并行。协调器 `dispose()` 幂等并释放所有 runtime 资源。

## RPC JSONL

RPC 每条记录保留 `version: 1`。请求：

```json
{ "version": 1, "kind": "request", "id": "p1", "method": "prompt", "params": { "sessionId": "s1", "message": "检查测试" } }
```

响应通过 `id` 关联；流事件是 `kind: "event"`，运行事件必须携带 `sessionId` 与 `runId`，通过 `requestId` 关联 operation，并可带单调 `sequence`。新的多会话客户端应为所有 session-scoped 请求显式携带 `sessionId`，`steer`、`cancel`、`get_operation`、审批和 interaction 还应携带目标 `runId`；为兼容旧版直连 `RpcSession` 客户端，省略的归属字段仅在该 transport 的唯一 active session 上补齐，WebUI/SessionHost 仍拒绝显式错误的 session 归属。

`run_command` 只能执行当前 composition 已注册且由 `list_commands` 返回的命令；不能通过 RPC 运行任意 shell。请求 schema、ID、错误 code 和结果都严格验证，未知或非法记录不会静默接受。

## SSE 恢复

WebUI `/events` 在 ready 中返回 resume token；客户端记录 `Last-Event-ID`。Dispatcher 保留有界环形事件缓冲，断线后通过 `resume_events` 重放可用 sequence。缓冲溢出发送 `snapshot_required`，客户端必须重新读取状态快照，而不是重放 prompt。每个 client 和全局 SSE 连接数、队列长度和请求速率均有上限。

## Orchestrator

`@di-code/orchestrator` 只启动并监督 `di-code-rpc`，等待 get_state 握手后暴露 prompt、cancel、operation、Session 和事件方法。子进程退出会把 pending request 以 `PROCESS_EXIT` 拒绝并保留最多 16 KiB stderr；不会自动重启或重放请求。stop 先 SIGTERM，默认五秒后 SIGKILL。

## 安全边界

信任控制项目 Composition、Skill 和 MCP 的 import eligibility，不是权限沙箱。插件、MCP Server、模型输出和项目文件都不可信。凭据只在服务端环境/settings 解析，脱敏后才进入诊断或 Web snapshot；任何新增协议、配置或用户可见行为都必须同步 validator、测试和文档。
### Typed Session projection

RPC capability negotiation advertises the `projection` event type. The dispatcher only emits versioned projection records after a client explicitly negotiates that capability; legacy clients therefore receive no unknown projection payload. Projection events participate in the existing sequence buffer and `resume_events` flow, including `snapshot_required` when the replay window has expired. Before publishing to RPC/SSE, projections must be JSON-like, at most 256 KiB, and contain no local path or credential-shaped keys; callers receive a redacted diagnostic rather than browser-visible data.
Tool execution errors preserve host policy codes such as `POLICY_DENIED`, `POLICY_CANCELLED`, `POLICY_TIMEOUT`, and `POLICY_DISPOSED` in structured tool-result details; RPC/JSON consumers must not infer authorization from prompt text or catalog membership.
# UserInteraction 通道

RPC v1 可协商 `interaction_request` 事件，并用 `respond_interaction` 返回结构化回答；请求与 `requestId`/`toolCallId` 关联，重复回答不会改变第一次结果。断线、取消、超时和 dispatcher dispose 会结束 pending；未协商 UI 时通用交互返回 `INTERACTION_UNAVAILABLE`，工具审批保持拒绝安全默认。TUI、WebUI 和插件 SDK 只共享 facade 类型，不暴露 transport token、cookie、key 或 Session 内部对象。
