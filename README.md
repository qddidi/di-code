# di-code

`di-code` 是一个以终端为主要界面的 TypeScript AI Coding Agent（编码代理）。它把模型适配、Agent 工具循环、编码工具、会话、插件和 ANSI 终端 UI 拆分为可独立构建、测试和发布的 npm workspace 包。

它支持 OpenAI、Anthropic、DeepSeek 和智谱等 Provider，以及流式文本、推理、工具调用、持久化会话、交互终端、JSON 输出和 JSONL RPC。


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

要使用真实 Provider，请在项目根目录创建未提交的 `.env`，再运行：

```powershell
npm run dev -- --print "检查当前项目的主要模块"
```

详见下方的[配置](#配置)、[使用](#使用)和[内置工具与安全边界](#内置工具与安全边界)。

## 功能

- OpenAI Responses API 与 DeepSeek、智谱 GLM 等 OpenAI Chat Completions 兼容 API 流式适配，包含文本、推理、工具调用和用量信息。
- Provider 无关的消息、模型、工具与事件协议。
- Agent 工具循环：模型请求工具后，执行工具并将结果回传给模型，直至任务结束。
- 内置 `read`、`write`、`edit`、`bash` 编码工具。
- 全屏交互终端 UI：多行编辑、补全、Markdown、工具状态、取消、重试、模型和主题选择。
- `print`、`json`、`interactive` 三种 CLI 模式。
- 可选 JSONL 会话持久化、并发追加保护和上下文压缩能力。
- 插件 API，可注册模型工具、interactive 模式 slash command 及 Agent 生命周期事件处理器。
- 受项目 trust 保护的 MCP `stdio` / Streamable HTTP Server tools，可接入现有 Agent 工具循环，并提供 `di-code mcp add/list/get/remove` 配置命令。
- 版本化 JSONL RPC，可从其他进程并发查询状态、提交或取消提示，并关联流式事件。
- 独立 orchestrator 包，通过公开 RPC SDK 监督 Coding Agent 子进程，不依赖其内部实现。

## 架构

```text
packages/
  ai/             Provider 无关的 AI 类型、事件流和 OpenAI/Chat Completions 适配器
  agent/          Agent 状态管理与工具调用循环
  coding-agent/   CLI、编码工具、会话、交互模式和扩展运行时
  mcp/            MCP stdio / Streamable HTTP 客户端生命周期
  skills/         独立的 SKILL.md 解析、发现、目录和调用展开包
  orchestrator/   通过公开 RPC SDK 管理 Coding Agent 子进程生命周期
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
Provider.stream() <----> Responses / Chat Completions Provider
        |
  tool_use 时依次执行 read / write / edit / bash
        |
  tool_result 回传模型，继续下一轮
```

各包职责如下：

| 包 | 说明 |
| --- | --- |
| `@di-code/ai` | `Model`、`Provider`、消息、工具 Schema、流式事件定义；实现 OpenAI、Anthropic、DeepSeek、智谱 GLM 与 Faux 测试 Provider。 |
| `@di-code/agent` | 管理完整对话历史和模型上下文，执行模型-工具循环，并向订阅者按序发布事件。 |
| `@di-code/coding-agent` | 可执行产品层，提供 CLI、文件与命令工具、会话存储、上下文压缩、交互界面和扩展契约。 |
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
- `.di-code/settings.json` 中没有 Provider。

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
| `maxTokens` | positive integer | 默认 `16384`；也接受 `maxOutputTokens`，同时存在时 `maxTokens` 优先 |
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
3. settings 中有两个或更多 Provider 时，必须设置 `DI_CODE_PROVIDER`。
4. settings 中没有 Provider、没有 `DI_CODE_PROVIDER` 且处于交互 TTY 时，启动选择向导。
5. 非交互模式没有明确 Provider 时立即报错，不会等待输入。

模型选择规则：设置了 `DI_CODE_MODEL` 时选择该模型；否则 OpenAI 默认使用 `gpt-4o`，Zhipu 默认使用 `glm-5.3`，其他 Provider 使用其模型列表中的第一个模型。

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

所有协议记录都包含 `version: 1`。请求 `id` 关联最终响应，prompt 期间的事件使用 `requestId` 关联原请求。当前公开方法为：

| 方法 | 参数 | 结果 |
| --- | --- | --- |
| `get_state` | `{}` | Session ID、模型、是否正在生成、消息数。 |
| `prompt` | `{ "message": "..." }` | 最终 `AssistantMessage`；中间事件另行输出。 |
| `cancel` | `{ "requestId": "..." }` | 是否找到并中止对应 prompt。 |

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
| `/model` | 打开模型选择器。 |
| `/session` | 打开会话选择器。 |
| `/tree` | 打开紧凑的分支树；`Enter` 从节点继续，`e` 编辑历史用户消息，`s` 为所选路径生成摘要并开始新分支。 |
| `/theme` | 切换深色或浅色终端主题。 |
| `/settings` | 配置上下文压缩和内置终端语言。 |
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

## 会话与插件

默认 CLI 会为交互会话创建或恢复用户目录 `~/.di-code/sessions/<工作区哈希>/` 下的版本化 JSONL 文件。当前格式为 v2：记录只追加，每条记录可引用任意已提交父节点，因此同一文件可保存多个对话分支。`/tree` 以紧凑单栏树显示路径和节点摘要，当前选择由 `›` 标识：选择历史用户消息时会恢复其文本到编辑器，并从该消息之前的上下文发送新 prompt；选择 assistant、tool result 或 summary 时从所选节点继续。按 `s` 会先切换到所选路径，再使用现有上下文压缩生成 summary；成功后下一条 prompt 会从该 summary 分支继续。摘要仍需要有效压缩切点。图片附件只恢复文本，需重新附加。导航仅改变模型上下文，不回滚文件、命令或外部服务副作用。Session 文件 v1 不会迁移，打开时会以 `UNSUPPORTED_VERSION` 拒绝。会话仍支持锁文件保护、损坏诊断、并发追加和每分支的上下文摘要压缩；完整磁盘历史和发送给模型的压缩上下文保持分离。`SessionManager` 与 `AgentSession` 也可作为 SDK 使用。已有项目内 `.di-code/sessions/` 文件不会自动移动；需要保留或共享它们时，通过 `--session <path>` 显式打开。

插件可在 CLI 启动时注册三类能力：模型工具、interactive 模式 slash command 和 Agent/会话生命周期事件处理器。项目本地插件位于：

```text
.di-code/plugins/<plugin-id>/
```

交互式 TTY 首次发现项目插件目录时会询问是否信任当前项目；也可以显式授予项目可信状态：

```powershell
npm run dev -- --trust-project --interactive
```

信任决定只控制是否加载项目中的 Node.js 代码，**不是权限沙箱**；manifest 中的 `permissions` 当前用于声明和审计，不会阻止插件自行访问文件、网络或子进程。interactive 模式加载插件时会显示黄色 `[loading]`、绿色 `[ok]` 或红色 `[error]` 状态；成功项会列出新增 tools 与 slash commands 数量。print 和 JSON 模式仍使用原有 `plugin_diagnostic`。只加载可信插件，并在插件实现中自行处理路径边界、输入校验、超时、取消和凭据保护。

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

该命令构建六个 workspace，检查并生成 npm tarball，在系统临时目录创建仓库外项目，以 `npm install --ignore-scripts` 安装所有 tarball，然后验证 help、version、Faux 对话和 orchestrator RPC 链路。成功或失败后都会清理临时目录；它不会运行 `npm publish`、创建 Git tag 或调用真实 Provider。

准备新版本时，不要逐个修改 package manifest。传入一个高于当前版本的稳定语义版本号（`major.minor.patch`）：

```powershell
npm run version:prepare -- 0.1.2
```

该命令同步根包和五个 public workspace 的 `version`、所有 `@di-code/*` 内部依赖版本，并用 `npm install --package-lock-only --ignore-scripts` 更新 lockfile。可先用 `--dry-run` 只检查目标版本，不写入文件：

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

`release:publish` 会拒绝脏工作区、不同步的 workspace 版本或内部依赖；缺少 `## [0.1.2]` CHANGELOG 标题时只会输出 warning，仍可继续。随后重跑 release dry-run，再按 ai、agent、tui、skills、coding-agent、orchestrator 的顺序调用 `npm publish --ignore-scripts`。npm 不提供多包原子发布：某个包失败时，脚本会停止，但先前已成功的包不会自动撤回。此时先检查 registry 状态和失败原因，不能直接重跑整条命令。该脚本不会创建 Git tag、commit 或 push。

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
