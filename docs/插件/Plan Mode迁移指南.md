# Plan Mode 迁移指南

把旧的内置计划逻辑迁移到 `@di-code/plan-mode` 时，使用 `createPlanModePlugin({ section })` 创建插件，并为每个 Session 提供 `PlanModeAdapter`。适配器的 `appendEvent` 必须调用 `SessionManager.appendEvent()`，不得直接写 JSONL；`events` 应返回当前分支事件，用于恢复、fork 和 compaction 后重放。

将控制器的 `promptSections` 注册到 AgentSession 的动态 section registry，将 `createExitTool()` 加入稳定工具目录，并用 `createPlanToolPolicy()` 包裹宿主 policy。命令入口调用 `controller.command(args, steer)`，不要把 `/plan` 转成普通用户消息。

客户端使用 `projectPlanMode()` 的 `{ active, pending }` 投影；RPC/SSE 通过既有 `projection` capability 传输，旧客户端继续忽略未协商事件。审阅交互使用 `intent: "plan-review"`，只接受 `Approve`、`Keep planning` 或取消三种结果。
