# @di-code/coding-agent

`@di-code/coding-agent` 是 di-code 的终端 AI 编码代理，提供以下命令：

- `di-code`：TUI 交互模式及单次、JSON 输出模式；
- `di-code web`：本地浏览器 WebUI；
- `di-code-webui`：供自定义客户端使用的 HTTP/SSE WebUI 传输层；
- `di-code-rpc`：供 Node.js 宿主程序管理 Agent 的 JSONL RPC 入口。

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
- [TUI 使用指南](https://github.com/qddidi/di-code/tree/master/docs/tui/使用指南.md)
- [插件使用指南](https://github.com/qddidi/di-code/tree/master/docs/插件使用指南.md)
- [开发教程](https://github.com/qddidi/di-code/tree/master/docs/开发教程.md)
- [运行时与 RPC 架构](https://github.com/qddidi/di-code/tree/master/docs/架构/运行时与RPC.md)
