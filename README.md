# di-code

`di-code` 是一个以终端为主的 TypeScript AI Coding Agent。它提供持续对话、文件和命令工具、会话恢复、插件、MCP、JSON 输出、RPC，以及本地 WebUI。

支持内建 `openai`、`anthropic`、`deepseek`、`kimi`、`zhipu` 和离线 `faux` Provider，也可以在 settings 中配置自定义 Provider。模型请求、工具循环和会话在 CLI、TUI、WebUI 与 RPC 入口之间共享。

## 快速开始

需要 Node.js `>=22.19.0` 和 npm。

### 使用已发布版本

```powershell
npm install -g @di-code/coding-agent
di-code
```

首次在真实终端运行时，向导会让你选择 Provider、模型并输入 API key。选择 `Faux (offline)` 可以不联网体验。

### 从源码运行

```powershell
npm install --ignore-scripts
npm run dev
```

不访问网络时，可验证一次完整的 CLI 链路：

```powershell
$env:DI_CODE_PROVIDER = "faux"
npm run dev -- --print "用一句话介绍这个项目"
```

完成 Provider 配置后，可以发送一次真实请求：

```powershell
npm run dev -- --print "检查当前项目的主要模块"
```

Provider、模型、环境变量、settings 和 CLI 参数见 [CLI 与配置](docs/用户指南/CLI与配置.md)。完整安装和第一次对话流程见 [快速开始](docs/用户指南/快速开始.md)。

## WebUI 使用

本地浏览器 WebUI：

```powershell
di-code web
```

命令会启动只绑定本机回环地址的 Web server，并输出浏览器地址。可用 `--port` 指定端口，或用 `--workspace <path>` 添加已信任的工作区：

```powershell
di-code web --port 4312 --workspace D:\projects\another-workspace
```

从仓库源码启动：

```powershell
npm run build
npm run dev -- web
```

打开页面后，在 Settings 中配置 Provider。浏览器只接收脱敏配置和不透明 ID，不会获得 API key。需要嵌入自定义客户端时，使用 `di-code-webui` HTTP/SSE 入口；它要求至少 32 个字符的 token：

```powershell
$env:DI_CODE_PROVIDER = "faux"
$env:DI_CODE_WEBUI_TOKEN = "replace-with-a-random-token-of-at-least-32-characters"
di-code-webui
```

完整路由、开发代理、工作区授权、SSE 恢复和安全限制见 [WebUI 使用指南](docs/webui/使用指南.md)。需要替换前端时，参阅 [自定义 WebUI](docs/webui/自定义UI.md) 和 [自定义前端开发](docs/webui/自定义前端.md)。

## TUI 使用

安装后直接运行交互式终端：

```powershell
di-code
```

也可以显式指定交互模式，或从源码启动：

```powershell
di-code --interactive
npm run dev -- --interactive
```

交互模式支持持续对话、工具状态、取消、重试、模型和设置选择。首次配置可通过 `/login` 重新打开 Provider 向导。

如果要在其他 Node.js 程序中嵌入 ANSI 组件，安装 `@di-code/tui`：

```powershell
npm install @di-code/tui
```

组件生命周期、键位、虚拟终端测试和自定义 Host 见 [TUI 使用指南](docs/tui/使用指南.md)。

## 其他入口

| 入口 | 用途 |
| --- | --- |
| `di-code --print "..."` | 单次请求，输出最终文本 |
| `di-code --mode json "..."` | 输出版本化 JSONL 事件 |
| `di-code-rpc` | 供其他 Node.js 宿主通过 JSONL RPC 管理 Agent |
| `di-code-webui` | 供自定义客户端使用的 HTTP/SSE WebUI 传输层 |

## 文档

- [文档索引](docs/README.md)
- [快速开始](docs/用户指南/快速开始.md)
- [CLI 与配置](docs/用户指南/CLI与配置.md)
- [会话、Skills 与图片](docs/用户指南/会话与Skills.md)
- [MCP 使用指南](docs/用户指南/MCP.md)
- [WebUI 使用指南](docs/webui/使用指南.md)
- [TUI 使用指南](docs/tui/使用指南.md)
- [插件使用指南](docs/插件使用指南.md)
- [开发教程](docs/开发教程.md)
- [运行时与 RPC 架构](docs/架构/运行时与RPC.md)

## 开发

```powershell
npm run check
npm test
npm run build
```

各 workspace 也可以单独构建或测试，例如：

```powershell
npm run test --workspace @di-code/coding-agent
npm run build --workspace @di-code/coding-agent
```

## 许可证

本项目采用 [MIT License](LICENSE)。
