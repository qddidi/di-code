# 运行时与 RPC 架构

## Composition 启动

CLI、Web、RPC 和 interactive 都从 Root Context 开始，由 Composition Loader 装配 namespace entries。默认层顺序：

```text
base -> mode -> ~/.di-code/composition.yml -> <work-root>/.di-code/composition.yml -> --composition
```

项目层要求 trust；受管 enabled plugin 会追加到 Loader。Loader 为每个 entry 创建 owner Fiber，按依赖拓扑加载；失败时 required entry 终止并回滚，optional entry 记录 skipped。dispose 按 owner 释放 contribution、监听器和外部资源。

## Agent loop

CLI/RPC/Web 都调用同一个 `AgentSession`/`@di-code/agent` loop。一次 prompt 串行经历：追加 user message、调用 `Provider.stream()`、发布 message/tool 事件、校验工具参数、执行工具、追加 tool result，再请求下一轮，直到 stop reason。Provider 不执行工具，CLI/TUI/Web 不实现第二套循环。AbortSignal 会传播到 Provider、工具、MCP 和子进程。

## SessionHost

`SessionHost` 按 principal 和真实 workspace 隔离 actor，集中拥有 Session、MCP、工具快照、事件订阅和 requestId 操作表。Session factory 在创建时固定 immutable tool snapshot；之后禁用的工具不会被会话补回。`dispose()` 幂等，先取消活跃操作，再释放 listener、锁、MCP 和子 Context。

## RPC JSONL

RPC 每条记录保留 `version: 1`。请求：

```json
{ "version": 1, "kind": "request", "id": "p1", "method": "prompt", "params": { "message": "检查测试" } }
```

响应通过 `id` 关联；流事件是 `kind: "event"`，通过 `requestId` 关联 operation，并可带单调 `sequence`。客户端先 `get_capabilities` 协商事件；旧客户端继续收到兼容的 Agent event。可用方法包括 prompt/steer/retry/cancel、Session/tree/transcript、compact/usage、资源快照、product/trust、`list_commands`/`run_command` 和 `resume_events`。

`run_command` 只能执行当前 composition 已注册且由 `list_commands` 返回的命令；不能通过 RPC 运行任意 shell。请求 schema、ID、错误 code 和结果都严格验证，未知或非法记录不会静默接受。

## SSE 恢复

WebUI `/events` 在 ready 中返回 resume token；客户端记录 `Last-Event-ID`。Dispatcher 保留有界环形事件缓冲，断线后通过 `resume_events` 重放可用 sequence。缓冲溢出发送 `snapshot_required`，客户端必须重新读取状态快照，而不是重放 prompt。每个 client 和全局 SSE 连接数、队列长度和请求速率均有上限。

## Orchestrator

`@di-code/orchestrator` 只启动并监督 `di-code-rpc`，等待 get_state 握手后暴露 prompt、cancel、operation、Session 和事件方法。子进程退出会把 pending request 以 `PROCESS_EXIT` 拒绝并保留最多 16 KiB stderr；不会自动重启或重放请求。stop 先 SIGTERM，默认五秒后 SIGKILL。

## 安全边界

信任控制项目 Composition、Skill 和 MCP 的 import eligibility，不是权限沙箱。插件、MCP Server、模型输出和项目文件都不可信。凭据只在服务端环境/settings 解析，脱敏后才进入诊断或 Web snapshot；任何新增协议、配置或用户可见行为都必须同步 validator、测试和文档。
