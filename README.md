# di-code

`di-code` 是一个以终端为主要界面的 TypeScript AI 编码代理。它将模型 Provider、Agent 工具循环、编码工具、会话管理和 ANSI 终端 UI 拆分为可独立构建与测试的 npm workspace 包。

当前默认接入 OpenAI Responses API，支持流式文本、推理摘要、工具调用，以及面向脚本与交互使用的多种 CLI 输出模式。

## 功能

- OpenAI Responses API 流式适配，包含文本、推理、工具调用和用量信息。
- Provider 无关的消息、模型、工具与事件协议。
- Agent 工具循环：模型请求工具后，执行工具并将结果回传给模型，直至任务结束。
- 内置 `read`、`write`、`edit`、`bash` 编码工具。
- 全屏交互终端 UI：多行编辑、补全、Markdown、工具状态、取消、重试、模型和主题选择。
- `print`、`json`、`interactive` 三种 CLI 模式。
- 可选 JSONL 会话持久化、并发追加保护和上下文压缩能力。
- 扩展 API，可注册命令、只读工具及 Agent 生命周期事件处理器。

## 架构

```text
packages/
  ai/             Provider 无关的 AI 类型、事件流和 OpenAI 适配器
  agent/          Agent 状态管理与工具调用循环
  coding-agent/   CLI、编码工具、会话、交互模式和扩展运行时
  tui/            自研 ANSI 终端 UI 组件库
```

运行时调用链：

```text
CLI / Interactive UI
        |
   AgentSession
        |
      Agent
        |
Provider.stream() <----> OpenAI Responses API
        |
  tool_use 时依次执行 read / write / edit / bash
        |
  tool_result 回传模型，继续下一轮
```

各包职责如下：

| 包 | 说明 |
| --- | --- |
| `@di-code/ai` | `Model`、`Provider`、消息、工具 Schema、流式事件定义；实现 OpenAI Responses API 与 Faux 测试 Provider。 |
| `@di-code/agent` | 管理完整对话历史和模型上下文，执行模型-工具循环，并向订阅者按序发布事件。 |
| `@di-code/coding-agent` | 可执行产品层，提供 CLI、文件与命令工具、会话存储、上下文压缩、交互界面和扩展契约。 |
| `@di-code/tui` | ANSI 终端渲染、增量重绘、光标、焦点、Overlay、编辑器、Markdown、补全等基础组件。 |

## 环境要求

- Node.js `>= 22.19.0`
- npm
- OpenAI API Key，或使用 `faux` Provider 做确定性本地验证

安装依赖：

```powershell
npm install
```

## 配置

从 `.env.example` 创建本地 `.env`，并填入所选 Provider 的凭据：

```dotenv
DI_CODE_PROVIDER=custom-openai
DI_CODE_MODEL=custom-model
CUSTOM_OPENAI_API_KEY=<your-custom-openai-api-key>
```

配置文件使用 Pi 风格的 `providers` 映射。Provider 的 `api` 当前必须是 `openai-responses`；`baseUrl` 放在 Provider 级别时由其模型继承，模型也可以单独覆盖。模型字段遵循 Pi 的默认值：`name` 默认等于 `id`，`input` 默认是 `["text"]`，`reasoning` 默认是 `false`，`contextWindow` 默认是 `128000`，`maxTokens` 默认是 `16384`。

项目根目录的 `.di-code/settings.json` 保存 Provider 和模型元数据：

```json
{
  "providers": {
    "custom-openai": {
      "baseUrl": "https://api.example.com/v1",
      "api": "openai-responses",
      "apiKey": "$CUSTOM_OPENAI_API_KEY",
      "models": [
        { "id": "custom-model", "maxTokens": 16384 }
      ]
    }
  }
}
```

`apiKey` 推荐使用 `$ENV_VAR` 或 `${ENV_VAR}` 引用，不要把真实凭据写入 JSON。`DI_CODE_PROVIDER` 和 `DI_CODE_MODEL` 只负责选择已配置的 Provider 和模型；只配置一个 Provider 时可以省略 `DI_CODE_PROVIDER`，只配置一个模型时可以省略 `DI_CODE_MODEL`。显式设置 `DI_CODE_PROVIDER=faux` 可运行无网络的确定性 Provider。

`cost.input`、`cost.output`、`cost.cacheRead`、`cost.cacheWrite` 的单位是美元/百万 token。自定义模型目录只属于对应 Provider，不会自动成为另一个 Provider 的模型。

使用无网络的测试 Provider：

```dotenv
DI_CODE_PROVIDER=faux
```

## 使用

根目录开发模式会读取 `.env`，并直接运行 TypeScript 源码：

```powershell
npm run dev
```

无参数时会启动交互模式。也可以传入提示词：

```powershell
npm run dev -- "解释当前项目的架构"
```

### CLI 模式

```text
Usage: di-code [options] <prompt>

Options:
  -p, --print        Print only the final assistant text (default)
  --mode <mode>      Output mode: print, json, or interactive
  --interactive      Start interactive terminal mode
  --continue, -c     Continue the most recently modified session
  --session <path>   Create or resume a JSONL session (relative to the work root)
  -h, --help         Show help
  -v, --version      Show version
```

只输出最终文本，适合 shell 脚本：

```powershell
npm run dev -- --print "列出这个仓库的主要模块"
```

输出逐行 JSON 事件，适合其他程序集成：

```powershell
npm run dev -- --mode json "检查测试状态"
```

显式启动交互模式：

```powershell
npm run dev -- --interactive
```

默认启动会在 `.di-code/sessions/` 中创建独立的 JSONL 会话。使用 `--continue`（或 `-c`）恢复最近修改的会话；没有历史会话时会新建。使用 `--session` 可以创建或恢复指定路径的会话：

```powershell
npm run dev -- --continue --interactive
```

```powershell
npm run dev -- --session .di-code/sessions/review.jsonl --interactive
```

构建后可执行程序为 `di-code`：

```powershell
npm run build
node --env-file-if-exists=.env packages/coding-agent/dist/entry.js --help
```

## 交互模式

交互模式提供流式对话、工具执行状态、文件路径和斜杠命令补全。常用命令包括：

| 命令 | 作用 |
| --- | --- |
| `/help` | 显示可用交互命令。 |
| `/clear` | 清除当前界面中可见的消息，不删除会话数据。 |
| `/model` | 打开模型选择器。 |
| `/session` | 打开会话选择器。 |
| `/theme` | 切换深色或浅色终端主题。 |
| `/settings` | 配置上下文压缩。 |
| `/compact` | 立即压缩当前持久化会话的旧上下文。 |
| `/usage` | 查看请求数、token、费用和当前上下文占用。 |
| `/retry` | 重试最后一次失败或取消的提示。 |

`Esc` 会取消当前模型请求或工具执行；提示在执行期间提交会进入队列。

## 内置工具与安全边界

| 工具 | 功能 | 默认限制 |
| --- | --- | --- |
| `read` | 读取工作根目录内的 UTF-8 文本文件。 | 最多 2,000 行、50 KiB；支持 `offset` 与 `limit`。 |
| `write` | 创建或完全覆盖工作根目录内的 UTF-8 文件。 | 自动创建父目录。 |
| `edit` | 对文件进行一次唯一的精确文本替换。 | 未找到或匹配多处时拒绝写入；保留 BOM 与换行风格。 |
| `bash` | 在工作根目录运行本地命令。 | 默认 30 秒，最大 5 分钟；stdout/stderr 各最多 50 KiB。 |

文件工具会限制路径在 `allowedRoot` 内，并拒绝二进制文件。`bash` 在 Windows 上使用 PowerShell，其他平台使用 `/bin/sh`；它以工作目录作为 `cwd`，但不是操作系统级沙箱。使用真实 Provider 前，应只在信任的项目目录中运行。

## 会话与扩展

会话模块使用带版本和父记录链的 JSONL 格式，支持锁文件保护、损坏诊断、并发修改检测和上下文摘要压缩。`SessionManager` 与 `AgentSession` 可作为 SDK 使用。

扩展运行时可发现受信任项目中的以下目录：

```text
.di-code/extensions/
.pi/extensions/
```

扩展默认导出一个 factory 函数，可注册命令、只读工具和事件监听器。扩展加载器会在未授予项目可信状态时跳过项目扩展。

默认 CLI 会创建或恢复磁盘会话；上下文压缩依赖持久化会话，并会保留完整 JSONL 历史。扩展运行时已实现并有测试覆盖，但默认 CLI 启动链尚未自动加载项目扩展。

## 开发

```powershell
npm run build   # 依次构建全部 workspace
npm run check   # Biome 检查与 TypeScript 类型检查
npm test        # 运行全部 workspace 测试
npm run dev     # 从源码运行 coding-agent
```

每个包也可单独执行构建或测试：

```powershell
npm run test --workspace @di-code/ai
npm run build --workspace @di-code/coding-agent
```

## 测试说明

测试覆盖 Provider 请求和流解析、工具参数验证、Agent 循环、文件和命令工具、会话并发与压缩、CLI、扩展契约及虚拟终端渲染。

OpenAI smoke 测试会在对应环境变量启用时访问真实 API，因此可能受到网络、配额或模型响应时间影响。日常离线测试可使用 `DI_CODE_PROVIDER=faux`。

## 许可证

本项目采用 [MIT License](LICENSE)。
