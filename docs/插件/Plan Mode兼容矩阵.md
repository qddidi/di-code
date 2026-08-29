# Plan Mode 兼容矩阵

| 入口/场景 | 支持 | 说明 |
| --- | --- | --- |
| TUI `/plan`、审阅 | 支持 | 使用现有 command registry 和 UserInteraction channel |
| WebUI projection、审阅 | 支持 | 需要协商 `projection` 与 `interaction_request` |
| RPC v1 | 支持 | 未协商扩展事件不会发送给旧客户端 |
| Session 重启/恢复/fork | 支持 | 从 `plan/mode` 事件重放 |
| compaction | 支持 | 计划状态不依赖消息上下文 |
| 断线 | 支持 | projection 进入既有 sequence/resume 缓冲 |
| 插件卸载 | 支持 | disposer 移除 prompt section，pending 选择丢弃 |
| 无 UI channel | 受限 | `exit_plan_mode` 返回明确不可用错误，计划状态保持不变 |
