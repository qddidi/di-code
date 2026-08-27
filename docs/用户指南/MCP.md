# MCP 使用指南

## 支持范围

`@di-code/mcp` 支持 MCP `stdio` 和 Streamable HTTP transport，以及分页的 `tools/list`、`resources/list`、`resources/read`、`prompts/list`、`prompts/get`、进度、变更通知、超时和取消。OAuth、URL elicitation、SSE fallback 和自动安装 Server 当前未启用。

stdio Server 初始化默认最多等待 30 秒；工具和能力列表请求默认最多等待 30 秒。使用 `npx` 的 Server 首次下载或冷启动可能较慢，WebUI 的“重新连接”会重新执行初始化并受此上限约束。

MCP tool 会加入现有 Agent ToolRegistry，名称为 `mcp__<server-id>__<tool-name>`；不会创建第二套 Agent loop。resources/prompts 只有显式调用才会读取，不会自动注入上下文。

## 配置命令

stdio Server：

```powershell
di-code mcp add repo-tools -- node .\server.mjs
di-code mcp add --scope user github -- npx -y @example/github-mcp
```

HTTP Server：

```powershell
di-code mcp add --transport http --scope project company https://mcp.example.com/mcp
```

管理：

```powershell
di-code mcp list
di-code mcp get repo-tools
di-code mcp remove repo-tools
```

scope 默认是 `local`，文件为 `<work-root>/.di-code/mcp.local.json`；`project` 为 `<work-root>/.mcp.json`；`user` 为 `~/.di-code/mcp.json`。生效优先级为 local > project > user，配置按 Server ID 整体覆盖。命令不会下载或安装 Server，list/get 会脱敏凭据。

## 配置格式与环境变量

```json
{
  "servers": {
    "company": {
      "transport": {
        "type": "streamable-http",
        "url": "https://mcp.example.com/mcp",
        "headers": { "Authorization": "Bearer ${COMPANY_MCP_TOKEN}" }
      }
    }
  }
}
```

Server ID 只能使用小写字母、数字、`-`、`_`。stdio 的 `command` 与 `args` 作为结构化参数执行，不经过 shell；HTTP URL 必须是绝对 `http`/`https` 地址。`${ENV_VAR}` 缺失时错误只显示变量名。

## 信任与故障排查

项目配置只有在 `--trust-project` 或 Web/RPC 产品信任状态为 true 时加载。未信任项目的 Server 不会启动；用户级 Server 仍可用。单个 Server 连接失败只禁用该 Server，不影响内置工具。interactive 会显示 loading/ok/error 诊断，错误会脱敏并截断。

`McpManager.reconnect(serverId)` 是显式重连，会刷新能力，不会自动重试任意工具调用。Session 结束时宿主必须关闭 manager；插件或嵌入式宿主也必须负责释放其创建的连接。

MCP Server 是外部进程/服务，不是权限沙箱。连接前审查来源、命令、网络地址和它暴露的工具。
