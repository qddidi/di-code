# @di-code/coding-agent

`@di-code/coding-agent` 是 di-code 的终端 AI 编码代理，提供以下命令：

- `di-code`：TUI 交互模式及单次、JSON 输出模式；
- `di-code web`：本地浏览器 WebUI；
- `di-code-webui`：供自定义客户端使用的 HTTP/SSE WebUI 传输层；
- `di-code-rpc`：供 Node.js 宿主程序管理 Agent 的 JSONL RPC 入口。

助手消息可以包含 Provider 返回的图片内容。WebUI 会把图片和文本一起渲染在助手聊天气泡中，并通过 Session/RPC transcript 持久化；插件可注册支持 `image` 输出的 Provider 以接入生图模型。

需要 Node.js `>=22.19.0`。已发布版本可直接安装：

```powershell
npm install -g @di-code/coding-agent
```

## WebUI 启动与设置

### 本地浏览器 WebUI

```powershell
di-code web
```

命令会启动只绑定本机回环地址的 Web server，并输出浏览器地址。可用 `--port` 指定端口，或用 `--workspace <path>` 添加已信任的工作区：

```powershell
di-code web --port 4312 --workspace D:\projects\another-workspace
```

打开页面后，在 **Settings** 中选择 Provider、模型并完成 API key 配置。没有可用 Provider 时，WebUI 会先使用离线 Faux runtime，配置完成后再发起真实请求。浏览器只接收脱敏配置和不透明 ID，不会获得 API key。

WebUI 的 Provider/模型选择是当前 workspace 的默认运行时；切换时会同步同一 Host 中已加载的 Session，之后打开的 Session 也会沿用该选择。

从仓库源码启动：

```powershell
npm install --ignore-scripts
npm run build
npm run dev -- web
```

完整的 WebUI 路由、开发代理、工作区授权和安全限制，见 [WebUI 使用指南](https://github.com/qddidi/di-code/tree/master/docs/webui/使用指南.md)。

### HTTP/SSE WebUI 传输层

`di-code-webui` 面向嵌入式或自定义客户端，启动时必须提供至少 32 个字符的 token：

```powershell
$env:DI_CODE_PROVIDER = "faux"
$env:DI_CODE_WEBUI_PORT = "8787"
$env:DI_CODE_WEBUI_TOKEN = "replace-with-a-random-token-of-at-least-32-characters"
di-code-webui
```

默认只绑定 `127.0.0.1`。远程访问还需要显式设置 `DI_CODE_WEBUI_ALLOW_REMOTE=1` 并配置可信 Origin。客户端认证方式、SSE 恢复和完整环境变量见 [WebUI 使用指南](https://github.com/qddidi/di-code/tree/master/docs/webui/使用指南.md)。

## TUI 启动与向导配置

### 启动交互式 TUI

安装后直接运行：

```powershell
di-code
```

也可以显式指定交互模式：

```powershell
di-code --interactive
```

从仓库源码运行：

```powershell
npm run dev
# 或
npm run dev -- --interactive
```

交互模式中可使用 `/plan` 进入 Plan Mode，`/plan <message>` 会先启用模式并提交该需求，`/plan off` 退出。命令会显示在 `/` 补全和 `/help` 列表中，不会把命令本身作为用户消息发送。

## 多 Session 与并发运行时

需要在一个工作区管理多个会话时，使用根入口导出的 `WorkspaceCoordinator`。它按 `principal + workspace` 隔离 `SessionRuntime`；每个 runtime 独占 Agent、JSONL 锁、事件订阅和 MCP 连接。通过 `createSession()`/`openSession()` 加载会话，再用 `startPrompt(sessionId, ...)`、`startRetry()` 或 `startCompact()` 启动运行；返回的 `RunHandle` 同时提供 `context`（`sessionId`、`runId`、`requestId`）、运行状态和结果 Promise。

同一 Session 只能有一个未结束的 primary run，重复 prompt 会抛出 `SessionHostError`（`BUSY`）；不同 Session 可以并行。`steer()`、`cancel()` 和 `getOperation()` 必须使用目标 `RunContext`/`runId`，不要用另一个 Session 的标识。协调器 `dispose()` 会取消未结束运行并释放所有 runtime；调用方仍应在宿主关闭时等待它完成。

### 首次 Provider 向导

在真实 TTY 中启动，且没有 `DI_CODE_PROVIDER`、默认 Provider 或唯一已配置 Provider 时，会自动打开向导。向导依次让你：

1. 选择 Provider（选择 `Faux (offline)` 可离线试用）；
2. 选择模型；
3. 输入 API key（隐藏显示）；
4. 对 `Custom` Provider 填写 API 协议、Base URL 和模型 ID。

向导会把选择保存到用户级 `~/.di-code/settings.json`，下次启动自动复用。交互模式中可用 `/login` 重新打开向导。非交互的 `--print`、JSON 和 CI 运行不会启动向导，应提前设置环境变量或 settings；Provider、模型和 `settings.json` 字段说明见 [CLI 与配置](https://github.com/qddidi/di-code/tree/master/docs/用户指南/CLI与配置.md)。

## 完整文档

README 只保留最短启动路径，其他功能请按主题阅读 GitHub `docs`：

- [文档索引](https://github.com/qddidi/di-code/tree/master/docs)
- [快速开始](https://github.com/qddidi/di-code/tree/master/docs/用户指南/快速开始.md)
- [CLI 与配置](https://github.com/qddidi/di-code/tree/master/docs/用户指南/CLI与配置.md)
- [会话、Skills 与图片](https://github.com/qddidi/di-code/tree/master/docs/用户指南/会话与Skills.md)
- [MCP 使用指南](https://github.com/qddidi/di-code/tree/master/docs/用户指南/MCP.md)
- [WebUI 自定义 UI](https://github.com/qddidi/di-code/tree/master/docs/webui/自定义UI.md)
- [自定义 Web 前端开发](https://github.com/qddidi/di-code/tree/master/docs/webui/自定义前端.md)
- [TUI 使用指南](https://github.com/qddidi/di-code/tree/master/docs/tui/使用指南.md)
- [插件使用指南](https://github.com/qddidi/di-code/tree/master/docs/插件使用指南.md)
- [开发教程](https://github.com/qddidi/di-code/tree/master/docs/开发教程.md)
- [运行时与 RPC 架构](https://github.com/qddidi/di-code/tree/master/docs/架构/运行时与RPC.md)
# User interaction

RPC/WebUI hosts expose versioned `interaction_request` events and accept `respond_interaction` replies. Requests correlate `requestId` and optional `toolCallId`; duplicate replies are idempotent, and unavailable channels fail fast. Legacy tool approval remains deny-by-default without a negotiated UI channel.
