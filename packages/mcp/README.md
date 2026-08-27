# @di-code/mcp

`@di-code/mcp` 是 di-code 使用的 MCP 客户端生命周期包。它基于 MCP SDK `1.30.0` 实现，支持本地 `stdio` 和远程 Streamable HTTP 两种传输方式。

项目主页：[github.com/qddidi/di-code](https://github.com/qddidi/di-code)

该包负责连接初始化、分页的 `tools/list`、`resources/list`、`resources/read`、`prompts/list`、`prompts/get`、进度传播、列表和资源通知、有界超时、取消传播以及幂等清理。stdio Server 的默认连接初始化超时为 30 秒（适配 `npx` 等冷启动），工具和能力列表请求默认超时为 30 秒；宿主可通过 `connectTimeoutMs`/`callTimeoutMs` 为单个 Server 调整。它不实现 Agent 循环，也不做工具授权决策。宿主在构造 manager 之前必须校验项目配置和信任关系。

在默认 composition 中，MCP 配置、client 和 tools 分别由 `@di-code/coding-agent/mcp-config-entry`、`mcp-client-entry` 和 `mcp-tools-entry` 装配；它们只把可用 MCP tools 贡献给既有 ToolRegistry，不创建第二个 Agent loop。

```ts
import { McpManager } from "@di-code/mcp";

const manager = new McpManager();
const { servers } = await manager.connect([
	{ id: "project-tools", transport: { type: "stdio", command: "node", args: ["server.mjs"] } },
	{ id: "company-api", transport: { type: "streamable-http", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer ${COMPANY_MCP_TOKEN}" } } },
]);

try {
	await servers[0]?.client.callTool("status", {});
} finally {
	await manager.close();
}
```

资源和提示词是显式能力。`McpClient.listResources()` 和 `listPrompts()` 会遍历服务器的每一页；`readResource()` 和 `getPrompt()` 绝不会自动把内容注入模型上下文。通过 `client.on(...)` 注册事件监听器，可以接收 `resources_changed`、`prompts_changed`、`tools_changed` 和 `resource_updated` 通知。请求方法接受 `AbortSignal`，或带 `onProgress`、`timeoutMs` 和 `maxTotalTimeoutMs` 的 `McpRequestOptions`。

`McpManager.reconnect(serverId)` 会重建单个失败的传输并刷新其能力。重连是显式操作，不会重试任意请求，也不会静默改变工具授权。

`McpManagerOptions` 从 `@di-code/mcp` 根入口导出，可用于注入 `createClient` 或观察 `onServerConnectionStatus`；manager 的所有连接仍必须由创建它的宿主关闭。

`McpError` 区分连接、认证、协议、超时、取消、工具和客户端已关闭等失败类型。服务器输出是不可信数据；诊断信息会脱敏并截断到 4 KiB。

Streamable HTTP 的 URL 必须是绝对的 `http` 或 `https` 地址。请求头应在宿主配置中使用环境变量引用；该包不会持久化或记录这些请求头。

OAuth 和 URL elicitation 目前被宿主刻意保持未启用状态。
