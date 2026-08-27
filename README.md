# di-code

`di-code` 是一个以终端为主要界面的 TypeScript AI Coding Agent（编码代理）。它把模型适配、Agent 工具循环、编码工具、会话、插件和 ANSI 终端 UI 拆分为可独立构建、测试和发布的 npm workspace 包。

它支持 OpenAI、Anthropic、DeepSeek、Kimi、智谱和自定义Provider，以及流式文本、推理、工具调用、持久化会话、交互终端、JSON 输出和 JSONL RPC。
## 快速体验

```powershell
npm install -g @di-code/coding-agent
```
然后执行

```powershell
di-code
```
完成向导即可体验

## 快速开始

以下命令从源码启动。首次在真实交互终端运行时，可以在向导中选择 Provider、模型，并临时输入 API Key；密钥不会写入磁盘。

```powershell
npm install --ignore-scripts
npm run dev
```

如果只想先验证 CLI 链路而不访问网络，可使用内置 Faux Provider：

```powershell
$env:DI_CODE_PROVIDER = "faux"
npm run dev -- --print "用一句话介绍这个项目"
```

源码默认 profile 通过 Loader 组合 runtime、Provider/model registry、CLI command/mode/renderer registry、Agent loop、Session/MCP 上下文和 `interactive`/`print`/`json` entries。命令帮助来自 registry，JSON mode 输出版本化事件。

要使用真实 Provider，请在项目根目录创建未提交的 `.env`，再运行：

```powershell
npm run dev -- --print "检查当前项目的主要模块"
```

详见下方的[配置](#配置)、[使用](#使用)和[内置工具与安全边界](#内置工具与安全边界)。

## 功能

- OpenAI Responses API 与 DeepSeek、智谱 GLM 等 OpenAI Chat Completions 兼容 API 流式适配，包含文本、推理、工具调用和用量信息。
- Provider 无关的消息、模型、工具与事件协议。
- Agent 工具循环：模型请求工具后，执行工具并将结果回传给模型，直至任务结束。
- 内置 `read`、`write`、`edit`、`glob`、`grep`、`bash` 编码工具。
- 全屏交互终端 UI：多行编辑、补全、Markdown、工具状态、取消、重试、模型和主题选择。
- `print`、`json`、`interactive` 三种 CLI 模式。
- 可选 JSONL 会话持久化、并发追加保护和上下文压缩能力。
- 可组合的 namespace plugin 运行时：Provider、Agent、工具、Session、CLI/TUI、RPC、MCP 与 Skills 都通过 Composition entry 装配；默认体验只是内建 composition。
- 受项目 trust 保护的 MCP `stdio` / Streamable HTTP Server tools，可接入现有 Agent 工具循环，并提供 `di-code mcp add/list/get/remove` 配置命令。
- 版本化 JSONL RPC，可从其他进程并发查询状态、提交或取消提示，并关联流式事件。
- 本地优先的 `di-code web` 同源 Web 应用，以及供嵌入式客户端使用的 `di-code-webui` HTTP/SSE 入口；两者都复用 RPC Dispatcher、SessionHost 和既有 Agent loop。
- Web 配置中心读取同一份脱敏 settings 快照，支持 onboarding、General、Models、locale、thinking 和权限默认值；环境变量托管凭据只读显示，浏览器不能覆盖完整 settings JSON。WebUI 会跟随 `locale` 即时切换内置界面文案，语言选项显示为“中文”。
- Web 设置中心还提供 Skills 目录、MCP Server 诊断与可取消重连、受管 Plugins 清单、浏览器本地 Agent Presets、Workspace Trust 影响范围和快捷键说明；插件启停与配置变更均通过窄 RPC，凭据不会进入浏览器或 preset。
- Web 插件扩展通过公开、版本化的声明式 slot 合约接入；宿主白名单映射 `app.sidebar`、`session.tree`、`conversation.node`、`conversation.tool` 和 `settings.panel`，不向浏览器暴露插件代码、命令 registry 或完整 RPC dispatcher。
- 独立 orchestrator 包，通过公开 RPC SDK 监督 Coding Agent 子进程，不依赖其内部实现。

## 架构

```text
packages/
  ai/             Provider 无关的 AI 类型、事件流和 OpenAI/Chat Completions 适配器
  agent/          Agent 状态管理与工具调用循环
  plugin-runtime/ Context、Fiber、服务、事件、能力与贡献所有权
  plugin-loader/  namespace plugin、package manifest 与声明式 Composition Loader
  plugin-sdk/     第三方插件唯一的公开 SDK 根入口
  builtins/       Provider、工具、Session、CLI、TUI 和 RPC 的内建 namespace entries
  coding-agent/   CLI/bootstrap、默认 composition、MCP、受管插件与产品会话
  mcp/            MCP stdio / Streamable HTTP 客户端生命周期
  skills/         独立的 SKILL.md 解析、发现、目录和调用展开包
  orchestrator/   通过公开 RPC SDK 管理 Coding Agent 子进程生命周期
  tui/            自研 ANSI 终端 UI 组件库
```

运行时调用链：

```text
CLI / RPC / Interactive UI
        |
Root Context -> Composition Loader -> enabled namespace entries
        |                  |
        |             Provider / Tool / Session / Mode registries
        |                  |
        +------------> AgentSession -> @di-code/agent loop -> Provider.stream()
                                       |                  |
                                       +-- tool_result ---+
```

各包职责如下：

| 包 | 说明 |
| --- | --- |
| `@di-code/ai` | `Model`、`Provider`、消息、工具 Schema、流式事件定义；实现 OpenAI、Anthropic、DeepSeek、智谱 GLM 与 Faux 测试 Provider。 |
| `@di-code/agent` | 管理完整对话历史和模型上下文，执行模型-工具循环，并向订阅者按序发布事件。 |
| `@di-code/plugin-runtime` | Provider 无关的 `Context`、`Fiber`、服务、生命周期、事件、能力与 owner-aware contribution 基元。 |
| `@di-code/plugin-loader` | 校验 namespace export 与 package `diCode` manifest，合并/加载 Composition，并管理 trust 和受管安装。 |
| `@di-code/plugin-sdk` | 第三方插件的稳定公开入口；只重导出 runtime 和 loader 的根 API。 |
| `@di-code/builtins` | 内建 Provider、工具、Session、模式、TUI 与 RPC namespace plugin entries。 |
| `@di-code/coding-agent` | 可执行产品层，选择默认 composition，提供 CLI、产品会话、MCP 与受管插件管理。 |
| `@di-code/mcp` | Provider 无关的 MCP Client、stdio / Streamable HTTP transport、tools/list、tools/call 和生命周期错误分类。 |
| `@di-code/skills` | Provider 无关的 SKILL.md YAML frontmatter 解析、受限读取、递归发现、冲突目录和 `/skill:` 参数展开；不执行 Skill 内容。 |
| `@di-code/orchestrator` | 监督 `di-code-rpc` 子进程，传播取消和崩溃，并保留有上限的 stderr 诊断。 |
| `@di-code/tui` | ANSI 终端渲染、增量重绘、光标、焦点、Overlay、编辑器、Markdown、补全等基础组件。 |

## 环境要求

- Node.js `>= 22.19.0`
- npm
- OpenAI、Anthropic、DeepSeek 或智谱 API Key，或使用 `faux` Provider 做确定性本地验证

安装依赖：

```powershell
npm install --ignore-scripts
```

## 配置

di-code 支持三种配置方式。先根据使用场景选择一种，不需要同时配置所有文件。

| 场景 | 配置方式 | 是否交互 |
| --- | --- | --- |
| 第一次在终端使用 | 直接运行 `npm run dev` | 是，选择 Provider、模型并隐藏输入 API key |
| 日常固定使用或脚本调用 | 在项目根目录创建 `.env`，或设置系统环境变量 | 否 |
| 自定义网关、私有端点或自定义模型 | 创建 `.di-code/settings.json`，凭据仍放环境变量 | 否 |

### 默认启动：不创建任何配置文件

在真实交互终端中运行：

```powershell
npm run dev
```

当以下条件同时满足时，di-code 会启动首次配置向导：

- CLI 处于 `interactive` 模式；
- stdin 和 stdout 都是 TTY；
- 没有设置 `DI_CODE_PROVIDER`；
- 没有显式 Provider 选择（`DI_CODE_PROVIDER`、`defaultProvider` 或唯一的已配置 Provider）。

向导依次选择 Provider 和模型。选择 OpenAI、Anthropic、DeepSeek 或 Zhipu AI 且环境中没有对应 API key 时，会进入隐藏输入；选择 `Faux (offline)` 不需要凭据。选择 `Custom` 时还会依次输入 API 协议、Base URL、隐藏 API key 和模型 ID，并将配置保存为用户级固定 `custom` Provider。向导输入的 key 仅写入用户级 `~/.di-code/settings.json`，不会写入 `.env`、项目 settings、Session 或日志。

`.di-code/settings.json` 不存在、文件为空或只有空白字符时，都按“没有 settings 配置”处理。非空文件必须是合法 JSON。

`--print`、`--mode json`、脚本、CI 或 non-TTY 环境不会启动向导，也不会等待输入；这些场景必须通过环境变量或 `settings.json` 明确选择 Provider。

### 使用 `.env` 或系统环境变量

根目录的 `npm run dev` 使用 Node.js 的 `--env-file-if-exists=.env` 读取 `.env`。也可以在 PowerShell、CI 或操作系统中设置同名环境变量。

运行时支持以下环境变量：

| 变量 | 作用 | 是否必需 |
| --- | --- | --- |
| `DI_CODE_PROVIDER` | 选择 Provider ID：`openai`、`anthropic`、`deepseek`、`kimi`、`zhipu`、`faux` 或 settings 中的自定义 ID | 非交互模式必需；settings 只有一个 Provider 时可省略 |
| `DI_CODE_MODEL` | 选择所选 Provider 的模型 ID | 可选；OpenAI/Anthropic/Zhipu 使用内建默认模型，其他 Provider 使用模型列表首项 |
| `DI_CODE_LOCALE` | 选择内置 CLI 和交互终端文案语言：`en` 或 `zh-CN` | 可选；优先于用户全局 settings 中的 `locale` |
| `OPENAI_API_KEY` | OpenAI 凭据 | 使用 OpenAI 时必需，向导临时输入除外 |
| `OPENAI_BASE_URL` | 覆盖内建 OpenAI endpoint | 可选，默认 `https://api.openai.com/v1` |
| `ANTHROPIC_API_KEY` | Anthropic 凭据 | 使用 Anthropic 时必需，向导临时输入除外 |
| `ANTHROPIC_BASE_URL` | 覆盖内建 Anthropic endpoint | 可选，默认 `https://api.anthropic.com` |
| `DEEPSEEK_API_KEY` | DeepSeek 凭据 | 使用 DeepSeek 时必需，向导临时输入除外 |
| `DEEPSEEK_BASE_URL` | 覆盖内建 DeepSeek endpoint | 可选，默认 `https://api.deepseek.com` |
| `ZAI_API_KEY` | 智谱 API 凭据 | 使用 `zhipu` 时必需，向导临时输入除外 |
| `ZHIPU_BASE_URL` | 覆盖内建智谱 Coding Plan endpoint | 可选，默认 `https://open.bigmodel.cn/api/coding/paas/v4` |
| `KIMI_API_KEY` | Kimi API 凭据 | 使用 `kimi` 时必需，向导临时输入除外 |
| `KIMI_BASE_URL` | 覆盖内建 Kimi Coding endpoint | 可选，默认 `https://api.kimi.com/coding/v1` |

DeepSeek 的 `.env` 示例：

```dotenv
DI_CODE_PROVIDER=deepseek
DI_CODE_MODEL=deepseek-v4-flash
DEEPSEEK_API_KEY=<your-deepseek-api-key>
# DEEPSEEK_BASE_URL=https://api.deepseek.com
```

OpenAI 的 `.env` 示例：

```dotenv
DI_CODE_PROVIDER=openai
DI_CODE_MODEL=gpt-4o
OPENAI_API_KEY=<your-openai-api-key>
# OPENAI_BASE_URL=https://api.openai.com/v1
```

Anthropic Claude：

```dotenv
DI_CODE_PROVIDER=anthropic
DI_CODE_MODEL=claude-sonnet-4-5
ANTHROPIC_API_KEY=<your-anthropic-api-key>
# ANTHROPIC_BASE_URL=https://api.anthropic.com
```

Kimi Coding：

```dotenv
DI_CODE_PROVIDER=kimi
DI_CODE_MODEL=k3
KIMI_API_KEY=<your-kimi-api-key>
# KIMI_BASE_URL=https://api.kimi.com/coding/v1
```

离线 Faux Provider：

```dotenv
DI_CODE_PROVIDER=faux
```

智谱 GLM：

```dotenv
DI_CODE_PROVIDER=zhipu
DI_CODE_MODEL=glm-5.3
ZAI_API_KEY=<your-zhipu-api-key>
# ZHIPU_BASE_URL=https://open.bigmodel.cn/api/coding/paas/v4
```

不要在 `.env` 中给值添加示例尖括号后直接使用；`<your-...>` 必须替换为真实的本地凭据。不要提交包含凭据的 `.env`。

### 内建 Provider 和模型

内建 Provider 不需要 `settings.json`，模型来自生成目录。当前模型如下：

智谱 GLM Coding Plan 的模型和 endpoint 以[官方套餐概览](https://docs.bigmodel.cn/cn/coding-plan/overview)及[模型切换说明](https://docs.bigmodel.cn/cn/coding-plan/latest-model)为准。

仅 `glm-5.2` 和 `glm-5.3` 支持 [`reasoning_effort`](https://docs.bigmodel.cn/cn/guide/start/concept-param#reasoning_effort)：可选 `low`、`high`、`max`，交互模式默认 `max`；较早的 GLM 模型不会发送该字段。使用 `Shift+Tab` 切换后，di-code 会按 Provider 和模型保存到用户级 `~/.di-code/settings.json`，下次启动自动恢复；项目 `.di-code/settings.json` 不会覆盖该个人偏好。

Anthropic 的请求格式与模型 API 以[官方 Messages API 文档](https://docs.anthropic.com/en/api/messages)为准。

| Provider | 模型 ID | 默认模型 | 输入能力 |
| --- | --- | --- | --- |
| `openai` | `gpt-4o` | 是 | 文本、图片 |
| `openai` | `gpt-5.6-terra` | 否 | 文本、图片 |
| `deepseek` | `deepseek-v4-flash` | 是 | 文本 |
| `deepseek` | `deepseek-v4-pro` | 否 | 文本 |
| `anthropic` | `claude-sonnet-4-5` | 是 | 文本、图片 |
| `anthropic` | `claude-haiku-4-5` | 否 | 文本、图片 |
| `anthropic` | `claude-opus-4-5` | 否 | 文本、图片 |
| `anthropic` | `claude-fable-5`、`claude-opus-4-6`、`claude-opus-4-7`、`claude-opus-4-8`、`claude-opus-5` | 否 | 文本、图片 |
| `zhipu` | `glm-5.3`、`glm-5.2` | 是 | 文本，1M 上下文 |
| `zhipu` | `glm-5.1`、`glm-5`、`glm-5-turbo` | 否 | 文本，200K 上下文 |
| `zhipu` | `glm-4.7` | 否 | 文本 |
| `kimi` | `k3`、`k3-256k`、`kimi-for-coding`、`kimi-for-coding-highspeed` | `k3` | 文本、图片 |
| `faux` | `faux-model` | 是 | 本地测试，不访问网络 |

Custom 向导的模型目录还包含 `qwen3.7-plus` 与 `MiniMax-M3` 的已验证 Chat Completions 元数据；Kimi 已作为内建 `kimi` Provider 提供。

`DI_CODE_MODEL` 省略时使用 Provider 的默认模型：OpenAI 为 `gpt-4o`，Anthropic 为 `claude-sonnet-4-5`，Zhipu 为 `glm-5.3`，其他内建 Provider 使用其模型列表首项。模型 ID 必须属于当前 Provider，否则启动会列出可用模型并报错。

### 使用 `.di-code/settings.json`

`settings.json` 用于声明自定义 Provider、兼容网关和自定义模型。文件位置固定为项目工作目录下的 `.di-code/settings.json`，根节点必须包含 `providers` 对象。

在 interactive TTY 的首次向导或 `/login` 中选择 `Custom`，可以不手写 JSON 完成同样的配置。向导支持 `openai-responses`、`openai-chat-completions` 和 `anthropic-messages`；Base URL 必须是绝对 `http`/`https` 地址，不能带凭据、query、hash 或尾随 `/`。模型 ID 可以是目录外的任意非空值：精确匹配内置目录时复用能力元数据，否则使用文本输入、128000 上下文和 16384 输出 token 的保守默认值。再次配置会覆盖用户级 `custom` Provider，但保留其他 Provider 和语言偏好。

下面是一个包含完整模型字段的自定义 OpenAI Responses 兼容网关：

```json
{
  "providers": {
    "company-gateway": {
      "name": "Company Gateway",
      "api": "openai-responses",
      "baseUrl": "https://gateway.example.com/v1",
      "apiKey": "$COMPANY_GATEWAY_API_KEY",
      "models": [
        {
          "id": "company-coder",
          "name": "Company Coder",
          "input": ["text", "image"],
          "reasoning": true,
          "contextWindow": 200000,
          "maxTokens": 32000,
          "cost": {
            "input": 2.5,
            "output": 10,
            "cacheRead": 1.25,
            "cacheWrite": 0
          }
        }
      ]
    }
  }
}
```

配套 `.env`：

```dotenv
COMPANY_GATEWAY_API_KEY=<your-company-gateway-api-key>
# settings 中只有一个 Provider，因此以下两项都可省略
# DI_CODE_PROVIDER=company-gateway
# DI_CODE_MODEL=company-coder
```

Provider 字段：

| 字段 | 类型 | 规则 |
| --- | --- | --- |
| providers 对象的 key | string | Provider ID，必须非空，例如 `company-gateway` |
| `name` | string | 可选显示名称；省略时使用 Provider ID |
| `api` | string | 使用 `openai-responses`、`openai-chat-completions` 或 `anthropic-messages`；Chat Completions 是协议标识，不绑定厂商 |
| `baseUrl` | string | Provider endpoint；模型没有单独配置时会继承它 |
| `apiKey` | string | 推荐写 `$ENV_VAR` 或 `${ENV_VAR}`；命令形式和 `!command` 不支持 |
| `models` | array | 自定义 Provider 必需；内建 `openai`、`deepseek`、`zhipu` 可省略并使用生成目录 |

模型字段：

| 字段 | 类型 | 默认值与规则 |
| --- | --- | --- |
| `id` | string | 必需，必须非空；也是 `DI_CODE_MODEL` 使用的值 |
| `name` | string | 默认等于 `id` |
| `api` | string | 默认继承 Provider 的 `api` |
| `baseUrl` | string | 默认继承 Provider 的 `baseUrl`；模型值优先 |
| `input` | array | 默认 `["text"]`；只允许 `text`、`image` |
| `reasoning` | boolean | 默认 `false` |
| `contextWindow` | positive integer | 默认 `128000` |
| `maxTokens` | positive integer | 默认 `16384`；也接受 `maxOutputTokens`，同时存在时 `maxTokens` 优先；必须小于 `contextWindow`，以保留输入空间 |
| `cost.input` | non-negative number | 默认 `0`，配置单位为美元/百万 token |
| `cost.output` | non-negative number | 默认 `0`，配置单位为美元/百万 token |
| `cost.cacheRead` | non-negative number | 默认 `0`，配置单位为美元/百万 token |
| `cost.cacheWrite` | non-negative number | 默认 `0`，配置单位为美元/百万 token |

自定义模型只属于声明它的 Provider，不会自动出现在其他 Provider 的模型列表中。`baseUrl` 必须是绝对 `http` 或 `https` URL，不能包含用户名、密码、query 或 hash。

### 配置多个 Provider

可以在同一个 `settings.json` 中声明多个 Provider。例如同时声明两个内建 Provider 时，不需要重复写模型：

```json
{
  "providers": {
    "openai": {
      "api": "openai-responses",
      "apiKey": "$OPENAI_API_KEY"
    },
    "deepseek": {
      "api": "openai-chat-completions",
      "apiKey": "$DEEPSEEK_API_KEY"
    },
    "zhipu": {
      "api": "openai-chat-completions",
      "apiKey": "$ZAI_API_KEY"
    }
  }
}
```

配套 `.env`：

```dotenv
DI_CODE_PROVIDER=deepseek
DI_CODE_MODEL=deepseek-v4-flash
OPENAI_API_KEY=<your-openai-api-key>
DEEPSEEK_API_KEY=<your-deepseek-api-key>
ZAI_API_KEY=<your-zhipu-api-key>
```

选择规则：

1. 设置了 `DI_CODE_PROVIDER` 时，始终选择该 ID。
2. 没有设置 `DI_CODE_PROVIDER` 且 settings 中正好有一个 Provider 时，自动选择它。
3. 没有显式选择且 settings 中有两个或更多 Provider 时，交互 TTY 会启动选择向导；非交互模式必须设置 `DI_CODE_PROVIDER` 或 `defaultProvider`。
4. settings 中没有 Provider、没有明确选择且处于交互 TTY 时，启动选择向导。
5. 非交互模式有多个 Provider 但没有明确选择时立即报错，不会等待输入。

模型选择规则：设置了 `DI_CODE_MODEL` 时选择该模型；否则，当所选 Provider 与合并后的 `defaultProvider` 一致时使用 `defaultModel`（在 `/model` 或 `/login` 中选择后自动保存）；再否则 OpenAI 默认使用 `gpt-4o`，Zhipu 默认使用 `glm-5.3`，其他 Provider 使用其模型列表中的第一个模型。项目 `.di-code/settings.json` 中的模型默认值与 `thinkingLevels` 优先于用户级 `~/.di-code/settings.json`；WebUI 在已有项目 settings 时把模型和推理强度选择写回该项目文件，否则写入用户级 settings。环境变量始终优先。

### 终端语言

内置 CLI 帮助、交互终端状态、选择器和内置 slash command 描述支持英文与简体中文。通过 `DI_CODE_LOCALE=zh-CN` 临时切换；不设置时读取用户全局 `~/.di-code/settings.json` 的 `locale`，默认英文。项目 `.di-code/settings.json` 不控制语言，避免项目配置改变每位开发者的终端偏好。

进入 interactive 模式后，使用 `/settings` 也可切换语言，选择会保存到用户全局 settings。JSON/RPC 字段、slash command 名称、工具名、Provider 和模型 ID、插件文案保持原样。

### 凭据和 endpoint 规则

- 内建 OpenAI 默认读取 `OPENAI_API_KEY`，内建 DeepSeek 默认读取 `DEEPSEEK_API_KEY`，内建 Zhipu 默认读取 `ZAI_API_KEY`。
- settings 中的 `apiKey` 可以引用任意环境变量，例如 `$COMPANY_GATEWAY_API_KEY` 或 `${COMPANY_GATEWAY_API_KEY}`。
- settings 中配置了 `apiKey` 引用但对应环境变量为空或不存在时，启动会明确报出变量名，但不会打印变量值。
- 虽然 `apiKey` 支持直接写字符串，但不要把真实 key 写进 JSON；优先使用环境变量引用。
- 自定义 Provider 不会自动继承 `OPENAI_API_KEY`，必须通过自己的 `apiKey` 字段明确引用凭据。
- `OPENAI_BASE_URL`、`DEEPSEEK_BASE_URL` 和 `ZHIPU_BASE_URL` 只用于覆盖对应内建 Provider endpoint。自定义 Provider 应在 settings 中配置 `baseUrl`。
- API key 不会写入 Session。首次向导输入的 key 也不会持久化。

### 配置错误排查

| 错误 | 含义与处理 |
| --- | --- |
| `.di-code\\settings.json: invalid JSON` | 文件非空但 JSON 语法损坏；检查逗号、引号和括号 |
| `providers must be an object` | 根节点缺少 `providers` 对象 |
| `DI_CODE_PROVIDER is required when more than one provider is configured` | settings 中配置了多个 Provider；设置 `DI_CODE_PROVIDER` |
| `Configured apiKey environment variable "..." is not set` | `apiKey` 引用的环境变量不存在或为空 |
| `Unknown model "..."` | `DI_CODE_MODEL` 不属于当前 Provider；改用错误信息列出的模型 |
| `models is required for a custom provider` | 自定义 Provider 没有声明 `models` 数组 |

环境变量配置完成后，print 模式可直接验证启动和请求链路：

```powershell
npm run dev -- --print "用一句话介绍这个项目"
```

### MCP Server

第二阶段支持本地 `stdio` 和远程 Streamable HTTP MCP Server。项目级定义默认需要 project trust：interactive TTY 会在发现 MCP 配置时询问，也可以显式使用 `--trust-project`。print 和 JSON 模式不会询问，未信任时跳过 local/project Server 并向 stderr 输出 `mcp_diagnostic`；user scope 可独立使用。

```json
{
  "mcpServers": {
    "project-tools": {
      "command": "npx",
      "args": ["-y", "@example/project-mcp"],
      "env": { "EXAMPLE_TOKEN": "${EXAMPLE_TOKEN}" }
    }
  }
}
```

Server ID 只能使用小写字母、数字、`-` 和 `_`。`command` 与 `args` 作为结构化子进程参数执行，不经过 shell；HTTP 使用绝对 `http`/`https` URL 和 headers。`${ENV_VAR}` 可出现在 env/header 值中，缺失时错误只显示变量名。MCP 工具向模型暴露为 `mcp__<server-id>__<tool-name>`，参数会在转发前按 Server JSON Schema 校验。支持 resources/prompts 的 Server 另显式提供 `resources_list`、`resource_read`、`prompts_list` 和 `prompt_get` 工具；外部内容不会自动注入上下文。连接失败只禁用对应 Server，不影响内置工具；会话结束时会关闭 Server 和 HTTP transport。

MCP Client 支持 resources/prompts 分页、列表/资源变更通知、进度回调和显式 Server 重连；OAuth、URL elicitation、SSE fallback 和自动安装 Server 仍不支持。interactive 模式连接 MCP Server 时会先显示黄色 `[loading]`，随后原位替换为绿色 `[ok]` 或红色 `[error]`；成功项会列出 tools、resources 和 prompts 数量，错误内容会脱敏。`--print` 和 JSON 模式继续使用原有输出与 `mcp_diagnostic` 协议。`di-code mcp add/list/get/remove` 管理三种配置 scope：`local`（默认）写入 `<work-root>/.di-code/mcp.local.json`，project 写入 `<work-root>/.mcp.json`，user 写入 `~/.di-code/mcp.json`；生效优先级为 local > project > user，配置整体覆盖。常用 stdio 注册可简写为 `di-code mcp add <id> -- <command> [args...]`，HTTP 仍需显式指定 `--transport http`。管理命令不会下载或安装 Server，list/get 会脱敏凭据。MCP Server 是外部代码而不是权限沙箱，trust 只决定是否加载项目定义，不能替代对工具调用和 Server 来源的审查。

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
  --image <path>     Attach a local PNG, JPEG, WebP, or GIF image (repeatable)
  --skill <path>     Add a Skill document for this invocation (repeatable)
  --no-skills        Do not load Skills
  --no-context-files Do not load project context files
  --profile <profile> Select print, json, or interactive composition
  --composition <path> Apply a JSON or YAML composition after project configuration
  --no-project-plugins Skip .di-code/composition.yml for this run
  --trust-project    Trust project-local Skills and MCP configuration
  --untrust-project  Revoke project trust
  plugin <action>    Install, inspect, enable, disable, update, or remove a managed plugin
  --trace-plugins    Print Loader phase, owner Fiber, capability, and failure diagnostics
  --dump-composition Print the resolved composition without configuration values
  mcp add|list|get|remove  Manage MCP configuration
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

向支持图片输入的模型附加本地图片：

```powershell
npm run dev -- --image .\diagram.png "说明这张架构图"
```

`--image` 可重复使用，但只支持 print 和 JSON 模式；每条 prompt 最多 4 张图片、每张不超过 5 MiB。相对路径按工作根目录解析，绝对路径也可使用。

交互模式也支持图片：输入 `@diagram.png` 或 `@"architecture diagram.png"` 后发送；在终端中直接拖入图片文件会自动转换为附件。Windows 使用 `Alt+V`，macOS/Linux 使用 `Ctrl+V` 读取剪贴板图片，并将临时图片路径插入输入框；可像普通文本一样编辑或删除。Windows 终端通常会拦截 `Ctrl+V`，因此使用 `Alt+V`。临时图片保存在用户目录 `~/.di-code/clipboard/<工作区哈希>/<进程 ID>/`，发送成功、删除路径或退出后会清理，启动时还会清理当前工作区超过 24 小时的遗留文件。当前模型必须在配置的 `input` 字段中声明 `image`，否则会拒绝发送。

显式启动交互模式：

```powershell
npm run dev -- --interactive
```

默认启动会在用户目录 `~/.di-code/sessions/<工作区哈希>/` 中创建独立的 JSONL 会话。使用 `--continue`（或 `-c`）恢复当前工作区最近修改的会话；没有历史会话时会新建。使用 `--session` 可以创建或恢复指定路径的会话：

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

### RPC 模式

构建后，`di-code-rpc` 使用 stdin 接收一行一个 JSON 请求，并在 stdout 输出一行一个版本化响应或事件。stderr 只用于进程诊断。下面的 PowerShell 示例查询当前 Session 状态：

```powershell
$request = '{"version":1,"kind":"request","id":"state-1","method":"get_state","params":{}}'
$request | node packages/coding-agent/dist/rpc-entry.js
```

### 本地 Web 应用

助手回复使用 GitHub Flavored Markdown 渲染，支持标题、列表、任务列表、表格、引用、链接和代码块。嵌入的原生 HTML 会作为文本显示而不会执行。

构建后的 `di-code web [--port <0-65535>]` 会启动一个只绑定 `127.0.0.1` 的 Node 进程。它同时提供 React SPA、`/api/boot`、`/api/rpc`、`/api/events`、`/api/attachments` 和无认证的 `GET /healthz`；`--port` 省略或为 `0` 时选择可用端口。页面首次加载会建立仅同源可用的 HttpOnly cookie，浏览器不需要、也不会获得 `DI_CODE_WEBUI_TOKEN`。

```powershell
di-code web
di-code web --port 4312 --workspace D:\\projects\\second-workspace
npm run web:dev
```

`npm run web:dev` 会以当前用户已有的 settings 启动 Web backend，再启动 Vite 并代理 API；退出时会清理两个子进程。配置了但尚未提供 API key 的 Provider 不会阻止 Web 启动，页面会先使用离线 Faux runtime 并可在 Settings 中完成登录；内置 Provider（包括 Zhipu）仍会显示为未配置状态。settings 文件的格式或安全校验错误仍会阻止启动。生产静态资源随 `@di-code/coding-agent` tarball 的 `dist/web` 一起发布。静态文件只允许位于该目录内，带 hash 的 `assets/` 使用 immutable cache，其他 SPA 路径回退到 `index.html`，`/api` 与旧 HTTP/SSE 路由不会被 SPA fallback 接管。Web 应用默认只授权启动目录的真实 workspace；可重复传入 `--workspace <path>` 扩展允许列表，附加 workspace 必须已被信任。侧栏按当前选择的 workspace 显示会话，浏览器只接收不透明 workspace ID 和目录显示名，不接收绝对路径。Web 不支持远程 bind，也不创建第二套 Agent loop。

Web 首页提供 DSH 风格的双栏 App Shell：空会话以居中 hero 和单一 composer 进入，已有会话以标题栏、Chat/Trajectory tabs 和底部 sticky composer 呈现。初始恢复使用骨架屏；发送后到首个流事件前显示 three-dot loading，流式文本不使用闪烁光标，完成消息提供复制、反馈与分支入口。桌面侧栏可选择已授权 workspace，并只显示该 workspace 的会话；会话按最后修改时间倒序。超长会话标题通过三点菜单提供 Rename、Branch、Inspect 和 Delete 操作；从任一完成回复创建分支时，新分支会立即打开，并只复制该回复之前的上下文。主区从 `get_transcript`、runtime 和 usage 快照恢复对话，并通过 SSE 增量显示文本和 thinking。composer 支持输入法组合、拖放/粘贴或选择最多四张 PNG/JPEG/WebP/GIF 图片、运行中的 steer、cancel 和失败 turn retry；左下角 Commands 按钮或在输入开头键入 `/` 会显示可筛选的命令清单，包含当前 composition 的全部内置和扩展命令，以及当前 Session 已加载的 `/skill:<name>`。上下方向键选择命令，`Enter` 或鼠标点击会直接执行不需要参数的内置或扩展 command；`/skill:<name>` 和 `/steer` 会写入输入框以补充请求内容。每张图片上限为 5 MiB。图片会作为模型请求上下文中的 image content block 传递，也会随 user message 持久化并在聊天记录中渲染；重新打开会话后仍可查看。只有当前模型声明支持图像输入时附件控件才可用；例如内建 GLM Coding 模型是文本模型。浏览器只保存 attachment handle 与本地预览，绝不显示服务端文件路径或 transport token。Provider 请求失败会作为脱敏的失败 assistant 回复展示，保留用户消息和 retry；底部显示当前估算上下文占用，累计输入与输出 token 在 Session log 中明确标注；用量、`Compact context` 和 retry 保持在同一个 composer 内。已配置 Provider 的卡片点击会立即用服务器保存的凭据切换当前 Session；只有未配置 Provider 才需要输入 key。权限菜单直接提供 `Ask before tools`（默认）、`Allow tools` 和 `Deny tools`，切换立即作用于当前 Session 的工具审批并保存为默认权限模式；模型菜单只展示当前 runtime 配置的模型，并在同一入口提供 `Default`、`Low`、`Medium`、`High`、`Max` 推理等级。下拉菜单和弹窗支持点击空白或 `Escape` 关闭。连接按 sequence 去重，断开后使用 `resumeToken` 和 `Last-Event-ID` 恢复；收到 `snapshot_required` 或刷新页面时完整重拉 snapshot，不会重放 prompt。窄屏将侧栏收为导航抽屉，`prefers-reduced-motion` 会关闭非必要动画。Settings overlay 使用固定的可视高度，导航和内容可独立滚动；模型和推理强度使用同一套 scoped settings 持久化，外观切换仅保存在浏览器本地。

Custom Provider 只在 Models 中选中 `Custom` 时显示。模型 ID 输入框提供已知目录模型作为候选，仍可直接输入任意兼容网关模型 ID；保存连接后会切换当前 WebUI Session 到该 `custom` runtime。Settings overlay 保持固定可视高度，导航与内容可以独立滚动。

Web composer 中的 `/tree` 会打开当前持久化 Session 的树状节点选择器；同一线性分支的消息保持左对齐，只有实际分叉才增加缩进。选择 user 节点会将其文本回填到输入框，并从该节点之前的上下文继续，选择完成的 assistant、tool result 或 summary 节点会从所选节点继续；带 tool call 的中间 assistant 节点不可选择，应选择对应 tool result。树导航只改变模型可见上下文，不能回滚已经发生的文件、命令或外部服务副作用。通过 `/skill:<name>` 发出的请求在 Web 聊天记录中仅显示所用 Skill 名称，不显示持久化消息中的展开 Skill 正文。

对话区提供 `Chat`/`Trajectory` tabs。Trajectory 由真实 RPC 事件投影工具卡，覆盖 `read`、`write`、`edit`、`bash`、`glob`、`grep` 的 loading、success、error、cancelled、timeout 和 truncated 状态；edit 的 diff/patch、上下文文件和 compaction 事件可独立折叠查看。压缩进行时，Chat 的 composer 上方会显示 loading 状态。空闲时的 `Compact context` 操作调用当前 Session 的受限 `compact` RPC，生成或压缩期间会禁用它。工具参数和输出使用纯文本/code block 渲染，长输出限制在可滚动折叠区域。`ask` 权限模式下 Web actor 会通过 `tool_approval` 事件暂停工具，客户端必须以同一 `approvalId` 调用 `approve_tool`。

### WebUI HTTP/SSE

Web 侧栏以可展开的工作区目录分组展示所有已授权 workspace 的会话。切换工作区会切换对应的 Session actor；点击其他工作区中的会话会在切换完成后打开目标会话。浏览器只接收不透明 workspace ID 和目录显示名，不接收绝对路径。

构建后，`di-code-webui` 提供受 token 认证的本地 HTTP/SSE 传输层。它默认仅绑定 `127.0.0.1`，并且必须设置至少 32 个字符的
`DI_CODE_WEBUI_TOKEN`；token 只能放在 `Authorization: Bearer ...` 或 `X-Di-Code-Token` 请求头中，不能放在 URL、日志或事件中。

```powershell
$env:DI_CODE_PROVIDER = "faux"
$env:DI_CODE_WEBUI_TOKEN = "replace-with-a-random-token-of-at-least-32-characters"
di-code-webui
```

入口只授权启动目录对应的真实工作区，拒绝浏览器提供的其他路径。`POST /rpc` 接收已有 RPC v1 request；`GET /events` 用 SSE 返回流事件；
`POST /attachments` 接收 `{ name, contentType, data }` JSON，其中 `data` 是 base64。附件只接受 PNG、JPEG、WebP、GIF，单个最大 5 MiB，
每个浏览器 client 最多保留 32 个或 64 MiB，总计 10 分钟后过期；WebUI 将附件保存到该 client 独立的受管临时目录，
并以 opaque `attachmentId` 引用，不暴露服务器路径。Provider、模型、语言、thinking 默认值和持久化 Session 与 TUI
共同使用同一套 settings 解析：已有工作区 `.di-code/settings.json` 时，WebUI 的模型和推理强度选择写入工作区；否则写入用户级 `~/.di-code`。浏览器 client 临时目录不承载产品 settings 或 Session。

首次响应返回 `X-Di-Code-Client-Id`。SSE `ready` 事件带 10 分钟有效的 `resumeToken`；每次成功恢复都会轮换它，旧 token 立即失效。带 sequence 的事件同时使用 SSE `id`，空闲连接每 15 秒发送 comment keepalive；重连在 header 发送该 token 和 `Last-Event-ID`，服务器重放有界事件或发送
`snapshot_required`。默认最多 8 个 SSE 连接/浏览器 client、64 个/服务进程；达到限制会返回 `429`。HTTP/SSE 断开不会取消 prompt、steer、retry 或 compact；用 `get_operation` 查询终态，只有 `cancel` 会显式取消。

远程绑定必须同时设置 `DI_CODE_WEBUI_ALLOW_REMOTE=1` 和显式 token。仍应配置允许的 Origin；默认只接受同源 `http` Origin，拒绝错误的 Host。
WebUI 不是沙箱：经过认证的客户端可请求当前工作区内的本地文件工具和 shell 工具。远程开放会把这些能力交给持有 token 的客户端，除非你明确
理解网络隔离、token 分发和项目 trust 的后果，否则不要启用。

仓库内的最小 HTTP/SSE 客户端示例是 [`examples/webui-client.ts`](examples/webui-client.ts)。它使用 faux Provider，依次演示
Session 列表、transcript/tree、ProductHost 快照、附件、prompt/steer/retry/cancel、`OperationState`、流事件和断线重连：

```powershell
$env:DI_CODE_PROVIDER = "faux"
$env:DI_CODE_WEBUI_PORT = "8787"
$env:DI_CODE_WEBUI_TOKEN = "replace-with-a-random-token-of-at-least-32-characters"
npm run build
Start-Process -NoNewWindow -FilePath "di-code-webui" -WorkingDirectory (Get-Location)
node --experimental-strip-types examples/webui-client.ts
```

示例假定 `di-code-webui` 已在 `PATH`；也可以将命令替换为 `node packages/coding-agent/dist/webui-entry.js`。示例不会保存 token、附件或 Session
到仓库，SSE 重连使用服务器 `ready` 数据中的 `resumeToken` 和最后收到的 `sequence`。

所有协议记录都包含 `version: 1`。请求 `id` 关联最终响应，prompt 期间的事件使用 `requestId` 关联原请求。当前公开方法为：

| 方法 | 参数 | 结果 |
| --- | --- | --- |
| `get_state` | `{}` | Session ID、模型、是否正在生成、消息数。 |
| `prompt` | `{ "message": "..." }` | 最终 `AssistantMessage`；中间事件另行输出。 |
| `cancel` | `{ "requestId": "..." }` | 是否找到并中止对应 prompt。 |

`RpcServer` 保留为 JSONL process adapter：它负责逐行 framing、stdout 串行化、stdin shutdown 和脱敏 stderr 诊断。传输无关的 `RpcDispatcher` 负责严格 schema 校验、方法分发、request ID 操作表、事件 sequence 和环形重放缓冲。扩展客户端必须先用 `get_capabilities` 声明支持的事件；未协商连接继续只收到旧 Agent event。协商后可使用持久化 Session、transcript/tree、steer/retry、模型、压缩、usage、资源快照、`get_operation` 和受控的 `list_commands`/`run_command`，通过 `resume_events` 恢复事件或处理 `snapshot_required`。ProductHost 的 login/logout、trust 和 MCP 配置同样是可取消 operation；协商 `product_audit` 后会收到不含密钥的完成审计事件。v1 只增加方法和可选字段；`run_command` 只执行当前 composition 已注册且由 `list_commands` 返回的名称，包括受信任 composition 注册的自定义命令，不能经由 RPC 执行未列入清单的任意命令。

SDK 从公开子路径导入：

```ts
import { RpcClient, RPC_PROTOCOL_VERSION } from "@di-code/coding-agent/rpc";
```

`@di-code/orchestrator` 的 `RpcSupervisor` 接收 RPC 可执行命令、参数、cwd 和环境变量。它只通过上述公开 SDK 通信；非预期子进程退出会把状态设为 `crashed`，并拒绝所有尚未完成的请求。实现不会自动重启，因为工具调用目前没有跨进程幂等键，自动重放可能重复写文件或执行命令。

## 交互模式

交互模式提供流式对话、工具执行状态、图片附件、文件路径和斜杠命令补全。常用命令包括：

| 命令 | 作用 |
| --- | --- |
| `/help` | 显示可用交互命令。 |
| `/clear` | 清除当前界面中可见的消息，不删除会话数据。 |
| `/model` | 打开模型选择器，并将选择保存为用户默认模型。 |
| `/session` | 打开会话选择器。 |
| `/tree` | 打开当前历史对话分支树；可以选择回退至哪个阶段 |
| `/theme` | 切换深色或浅色终端主题。 |
| `/settings` | 配置上下文压缩和内置终端语言。 |
| `/compact` | 立即压缩当前持久化会话的旧上下文。 |
| `/usage` | 查看请求数、token、费用和当前上下文占用。 |
| `/retry` | 重试最后一次失败或取消的提示。 |
| `/steer` | 在当前提示词运行期间向 Agent 追加引导内容（例如 `/steer 简短回答`）。 |
| `/login` | 重新打开 Provider、模型和隐藏 API key 向导；保存到用户全局配置并切换当前会话。 |
| `/logout` | 移除当前 Provider 保存在用户全局配置中的 API key 和对应默认选择，不影响环境变量；当前会话保持可用至退出，下一次交互启动会要求重新选择或登录。 |
| `/skill:<name>` | 手动调用一个已加载的 Skill，可附带具体请求，例如 `/skill:release-check 检查发布条件`；交互框中输入 `/skill:` 后可补全。 |

输入 `/` 后可补全命令；补全菜单打开时按 `Enter` 会直接运行当前选中的 slash command，按 `Tab` 只补全到输入框。常用按键：

| 按键 | 作用 |
| --- | --- |
| `Enter` | 发送当前提示词；执行期间提交的提示词进入队列。 |
| `Shift+Enter` | 在输入框中插入换行。 |
| `Esc` | 取消当前模型请求或工具执行，并显示已取消状态；没有请求时关闭补全或选择器。 |
| `Ctrl+C` | 退出并恢复终端状态。 |
| `Tab` | 补全 slash command。 |
| `Alt+S` | 把编辑框当前内容作为引导发送给运行中的 Agent（与 `/steer` 等价）。 |
| `Shift+Tab` | 循环切换模型的 thinking 等级（模型不支持时提示错误）。 |
| `Ctrl+O` / `Ctrl+L` | 打开模型 / 会话选择器。 |
| `Ctrl+T` / `Ctrl+S` | 打开主题 / 设置。 |
| `Ctrl+R` | 重试最近失败或取消的提示。 |

取消只停止当前请求，不会删除已写入磁盘的会话记录，并显示已取消状态而非错误；之后可使用 `/retry` 或 `Ctrl+R` 重试。剪贴板图片快捷键（Windows `Alt+V`，macOS/Linux `Ctrl+V`）见上文图片部分。

## 内置工具与安全边界

| 工具 | 功能 | 默认限制 |
| --- | --- | --- |
| `read` | 读取工作根目录内的 UTF-8 文本文件。 | 最多 2,000 行、50 KiB；支持 `offset` 与 `limit`。 |
| `write` | 创建或完全覆盖工作根目录内的 UTF-8 文件。 | 自动创建父目录。 |
| `edit` | 对文件进行一次唯一的精确文本替换。 | 未找到或匹配多处时拒绝写入；保留 BOM 与换行风格。 |
| `glob` | 按 glob pattern 查找工作根目录内的文件。 | 返回排序后的相对路径；默认最多 200 个结果、50 KiB；跳过 symlink。 |
| `grep` | 在工作根目录内的 UTF-8 文本文件中查找字面量文本。 | 返回 `path:line` 匹配；默认最多 200 个结果、50 KiB；跳过二进制文件、symlink 和超过 2 MiB 的单文件。 |
| `bash` | 在工作根目录运行本地命令。 | 默认 30 秒，最大 5 分钟；stdout/stderr 各最多 50 KiB。 |

文件工具会限制路径在 `allowedRoot` 内，并拒绝二进制文件。`glob` 和 `grep` 使用 Node 文件 API，不依赖系统安装的 `grep` 或 shell；它们不跟随 symlink，并支持取消信号。`grep` 的 `pattern` 是字面量匹配，不是正则表达式。`bash` 在 Windows 上使用 PowerShell，其他平台使用 `/bin/sh`；它以工作目录作为 `cwd`，但不是操作系统级沙箱。使用真实 Provider 前，应只在信任的项目目录中运行。

## 会话与插件

默认 CLI 会为交互会话创建或恢复用户目录 `~/.di-code/sessions/<工作区哈希>/` 下的版本化 JSONL 文件。当前格式为 v2：记录只追加，每条记录可引用任意已提交父节点，因此同一文件可保存多个对话分支。`/tree` 以紧凑单栏树显示路径和节点摘要，当前选择由 `›` 标识：选择历史用户消息时会恢复其文本到编辑器，并从该消息之前的上下文发送新 prompt；选择 assistant、tool result 或 summary 时从所选节点继续。按 `s` 会先切换到所选路径，再使用现有上下文压缩生成 summary；成功后下一条 prompt 会从该 summary 分支继续。摘要仍需要有效压缩切点。图片附件只恢复文本，需重新附加。导航仅改变模型上下文，不回滚文件、命令或外部服务副作用。Session 文件 v1 不会迁移，打开时会以 `UNSUPPORTED_VERSION` 拒绝。会话仍支持锁文件保护、损坏诊断、并发追加和每分支的上下文摘要压缩；完整磁盘历史和发送给模型的压缩上下文保持分离。`SessionManager` 与 `AgentSession` 也可作为 SDK 使用。已有项目内 `.di-code/sessions/` 文件不会自动移动；需要保留或共享它们时，通过 `--session <path>` 显式打开。

默认启动只通过 Composition 解析已启用的受管 namespace plugin。交互式 TTY 只会在发现项目 Skills 或 MCP 配置时请求 trust：

```powershell
npm run dev -- --trust-project --interactive
```

受管插件在进程内执行，**不是权限沙箱**；`package.json` 的 `diCode.permissions` 用于声明和 capability audit，不会阻止插件自行访问文件、网络或子进程。默认 profile 仅将已启用插件加入 Loader；禁用项既不解析 entry，也不会 import。只安装可信来源的插件，并在插件实现中自行处理路径边界、输入校验、超时、取消和凭据保护。

默认运行时由 `base` 与选定的 `interactive`、`print`、`json` 或 `rpc` composition 组合，并追加所有 enabled managed package entry。`--profile` 选择 CLI 的 `print`、`json` 或 `interactive` composition；`--mode` 与它选择不同 mode 时会报错。Loader 固定按 `base -> mode -> ~/.di-code/composition.yml -> <work-root>/.di-code/composition.yml -> --composition` 合并层，后层通过 patch 修改前层。项目 composition 只有在项目已被 `--trust-project` 信任时才会读取；`--no-project-plugins` 会为当前运行跳过它，不影响用户托管插件。RPC 使用相同规则：未信任项目的 composition 不加载，但已启用受管 package 仍会进入 RPC Loader。缺失的 user/project composition 会忽略；存在但格式错误，或 `--composition` 指定的文件不可读取时，启动失败并显示文件路径。`plugin` 管理命令本身也由 composition entry 注册，不需要 Provider。除 `list` 外，可用 `get <id>` 查看不含安装路径或来源的公开状态。`--trace-plugins` 和 `--dump-composition` 只按需挂载开发观测 entries；它们输出实际 resolved tree、Loader phase、owner Fiber、capability audit 与脱敏失败诊断，不输出 composition 配置、凭据或 Provider 请求体。

受管插件的 package manifest 只接受 `package.json` 中单一的 `diCode.plugins` entry 与 package `exports`。entry 是 namespace module，必须导出非空 `name` 和 `apply`，并且不能有 `default` export；`apiVersion` 若存在必须为 `1`，`version` 若存在必须是合法标识。Loader 只导入 enabled entry；required entry 失败会终止并回滚已激活项，optional entry 失败会保留 `skipped` inventory 诊断。第三方 package 与 Composition 用法见[插件使用指南](docs/插件使用指南.md)。

完整的目录结构、manifest、工具 schema、事件顺序和排查方法见 [插件使用指南](docs/插件使用指南.md)。

## 开发

```powershell
npm run build   # 依次构建全部 workspace
npm run check   # Biome 检查与 TypeScript 类型检查
npm test        # 运行全部 workspace 测试
npm run dev     # 从源码运行 coding-agent
```

发布候选必须先执行本地 dry-run：

```powershell
npm run release:dry-run
```

该命令构建全部 11 个公开 workspace，检查并生成 npm tarball，在系统临时目录创建仓库外项目，以 `npm install --ignore-scripts` 安装所有 tarball，然后验证 help、version、Faux 对话和 orchestrator RPC 链路。成功或失败后都会清理临时目录；它不会运行 `npm publish`、创建 Git tag 或调用真实 Provider。

准备新版本时，不要逐个修改 package manifest。传入一个高于当前版本的稳定语义版本号（`major.minor.patch`）：

```powershell
npm run version:prepare -- 0.1.2
```

该命令同步根包、全部公开 workspace 和私有 `web` workspace 的 `version`，更新所有 `@di-code/*` 内部依赖版本，并用 `npm install --package-lock-only --ignore-scripts` 更新 lockfile。可先用 `--dry-run` 只检查目标版本，不写入文件：

```powershell
npm run version:prepare -- 0.1.2 --dry-run
```

实际发布应先补齐对应的 `CHANGELOG.md` 条目，审查版本改动、执行质量门禁并提交版本候选。发布命令只接受明确确认，并从已提交的根 `package.json` 读取版本：

```powershell
npm run check
npm test
npm run release:dry-run
git diff --check
git commit -am "chore: release 0.1.2"
npm run release:publish -- --confirm
```

`release:publish` 会拒绝脏工作区、不同步的 workspace 版本或内部依赖；缺少 `## [0.1.2]` CHANGELOG 标题时只会输出 warning，仍可继续。随后重跑 release dry-run，再按 plugin-runtime、plugin-loader、plugin-sdk、ai、agent、skills、builtins、tui、mcp、coding-agent、orchestrator 的依赖顺序调用 `npm publish --ignore-scripts`。私有 `web` workspace 会参与版本一致性检查，但不会发布。npm 不提供多包原子发布：某个包失败时，脚本会停止，但先前已成功的包不会自动撤回。此时先检查 registry 状态和失败原因，不能直接重跑整条命令。该脚本不会创建 Git tag、commit 或 push。

每个包也可单独执行构建或测试：

```powershell
npm run test --workspace @di-code/ai
npm run build --workspace @di-code/coding-agent
```

## 测试说明

测试覆盖 Provider 请求和流解析、工具参数验证、Agent 循环、文件和命令工具、会话并发与压缩、CLI、扩展契约及虚拟终端渲染。

真实 Provider smoke 测试会在对应环境变量启用时访问真实 API，因此可能受到网络、配额或模型响应时间影响。日常离线测试可使用 `DI_CODE_PROVIDER=faux`。

## 许可证

本项目采用 [MIT License](LICENSE)。
