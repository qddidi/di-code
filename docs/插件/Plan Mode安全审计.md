# Plan Mode 安全审计

- 计划事件仅包含布尔 `active` 字段，未写入 Provider key、Authorization、路径或完整请求体。
- `write`、`edit`、`bash` 在 Agent tool execute 边界由 policy 拒绝；prompt section 不是安全边界。
- 审阅计划要求非空 Markdown 且首行存在 `#` 标题，完整文本通过结构化 UserInteraction 传递。
- 交互取消、超时、无 UI channel 和插件 dispose 均不会退出计划状态。
- RPC projection 沿用 v1 capability negotiation、大小上限和敏感字段过滤；插件不向浏览器暴露 transport token。
