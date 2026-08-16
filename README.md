# di-code

`di-code` 是一个以终端为主要界面的 TypeScript AI 编码代理。它将模型 Provider、Agent 工具循环、编码工具、会话管理和 ANSI 终端 UI 拆分为可独立构建与测试的 npm workspace 包。

当前接入 OpenAI Responses API 与 DeepSeek Responses API，支持流式文本、推理、工具调用，以及面向脚本与交互使用的多种 CLI 输出模式。

## 功能

- OpenAI / DeepSeek Responses API 流式适配，包含文本、推理、工具调用和用量信息。
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
Provider.stream() <----> Responses API Provider
        |
  tool_use 时依次执行 read / write / edit / bash
        |
  tool_result 回传模型，继续下一轮
```

各包职责如下：

| 包 | 说明 |
| --- | --- |
| `@di-code/ai` | `Model`、`Provider`、消息、工具 Schema、流式事件定义；实现 OpenAI、DeepSeek Responses API 与 Faux 测试 Provider。 |
| `@di-code/agent` | 管理完整对话历史和模型上下文，执行模型-工具循环，并向订阅者按序发布事件。 |
| `@di-code/coding-agent` | 可执行产品层，提供 CLI、文件与命令工具、会话存储、上下文压缩、交互界面和扩展契约。 |
| `@di-code/tui` | ANSI 终端渲染、增量重绘、光标、焦点、Overlay、编辑器、Markdown、补全等基础组件。 |

## 环境要求

- Node.js `>= 22.19.0`
- npm
- OpenAI 或 DeepSeek API Key，或使用 `faux` Provider 做确定性本地验证

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

向导依次选择 Provider 和模型。选择 OpenAI 或 DeepSeek 且环境中没有对应 API key 时，会进入隐藏输入；选择 `Faux (offline)` 不需要凭据。向导输入的 key 只保存在本次进程内存中，退出后不会写入 `.env`、`settings.json`、Session 或日志，因此下次未配置环境变量时会再次询问。

`.di-code/settings.json` 不存在、文件为空或只有空白字符时，都按“没有 settings 配置”处理。非空文件必须是合法 JSON。

`--print`、`--mode json`、脚本、CI 或 non-TTY 环境不会启动向导，也不会等待输入；这些场景必须通过环境变量或 `settings.json` 明确选择 Provider。

### 使用 `.env` 或系统环境变量

根目录的 `npm run dev` 使用 Node.js 的 `--env-file-if-exists=.env` 读取 `.env`。也可以在 PowerShell、CI 或操作系统中设置同名环境变量。

运行时支持以下环境变量：

| 变量 | 作用 | 是否必需 |
| --- | --- | --- |
| `DI_CODE_PROVIDER` | 选择 Provider ID：`openai`、`deepseek`、`faux` 或 settings 中的自定义 ID | 非交互模式必需；settings 只有一个 Provider 时可省略 |
| `DI_CODE_MODEL` | 选择所选 Provider 的模型 ID | 可选；省略时使用该 Provider 的第一个模型 |
| `OPENAI_API_KEY` | OpenAI 凭据 | 使用 OpenAI 时必需，向导临时输入除外 |
| `OPENAI_BASE_URL` | 覆盖内建 OpenAI endpoint | 可选，默认 `https://api.openai.com/v1` |
| `DEEPSEEK_API_KEY` | DeepSeek 凭据 | 使用 DeepSeek 时必需，向导临时输入除外 |
| `DEEPSEEK_BASE_URL` | 覆盖内建 DeepSeek endpoint | 可选，默认 `https://api.deepseek.com` |

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

离线 Faux Provider：

```dotenv
DI_CODE_PROVIDER=faux
```

不要在 `.env` 中给值添加示例尖括号后直接使用；`<your-...>` 必须替换为真实的本地凭据。不要提交包含凭据的 `.env`。

### 内建 Provider 和模型

内建 Provider 不需要 `settings.json`，模型来自生成目录。当前模型如下：

| Provider | 模型 ID | 默认模型 | 输入能力 |
| --- | --- | --- | --- |
| `openai` | `gpt-4o` | 是 | 文本、图片 |
| `openai` | `gpt-5.6-terra` | 否 | 文本 |
| `openai` | `o3-mini` | 否 | 文本 |
| `deepseek` | `deepseek-v4-flash` | 是 | 文本 |
| `deepseek` | `deepseek-v4-pro` | 否 | 文本 |
| `faux` | `faux-model` | 是 | 本地测试，不访问网络 |

`DI_CODE_MODEL` 省略时使用表中的默认模型。模型 ID 必须属于当前 Provider，否则启动会列出可用模型并报错。

### 使用 `.di-code/settings.json`

`settings.json` 用于声明自定义 Provider、兼容网关和自定义模型。文件位置固定为项目工作目录下的 `.di-code/settings.json`，根节点必须包含 `providers` 对象。

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
| `api` | string | 自定义 Provider 使用 `openai-responses`；内建 `deepseek` 使用 `deepseek-responses` |
| `baseUrl` | string | Provider endpoint；模型没有单独配置时会继承它 |
| `apiKey` | string | 推荐写 `$ENV_VAR` 或 `${ENV_VAR}`；命令形式和 `!command` 不支持 |
| `models` | array | 自定义 Provider 必需；内建 `openai`、`deepseek` 可省略并使用生成目录 |

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
      "api": "deepseek-responses",
      "apiKey": "$DEEPSEEK_API_KEY"
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
```

选择规则：

1. 设置了 `DI_CODE_PROVIDER` 时，始终选择该 ID。
2. 没有设置 `DI_CODE_PROVIDER` 且 settings 中正好有一个 Provider 时，自动选择它。
3. settings 中有两个或更多 Provider 时，必须设置 `DI_CODE_PROVIDER`。
4. settings 中没有 Provider、没有 `DI_CODE_PROVIDER` 且处于交互 TTY 时，启动选择向导。
5. 非交互模式没有明确 Provider 时立即报错，不会等待输入。

模型选择规则：设置了 `DI_CODE_MODEL` 时选择该模型；否则选择 Provider 模型列表中的第一个模型。

### 凭据和 endpoint 规则

- 内建 OpenAI 默认读取 `OPENAI_API_KEY`，内建 DeepSeek 默认读取 `DEEPSEEK_API_KEY`。
- settings 中的 `apiKey` 可以引用任意环境变量，例如 `$COMPANY_GATEWAY_API_KEY` 或 `${COMPANY_GATEWAY_API_KEY}`。
- settings 中配置了 `apiKey` 引用但对应环境变量为空或不存在时，启动会明确报出变量名，但不会打印变量值。
- 虽然 `apiKey` 支持直接写字符串，但不要把真实 key 写进 JSON；优先使用环境变量引用。
- 自定义 Provider 不会自动继承 `OPENAI_API_KEY`，必须通过自己的 `apiKey` 字段明确引用凭据。
- `OPENAI_BASE_URL` 和 `DEEPSEEK_BASE_URL` 只用于覆盖对应内建 Provider endpoint。自定义 Provider 应在 settings 中配置 `baseUrl`。
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

真实 Provider smoke 测试会在对应环境变量启用时访问真实 API，因此可能受到网络、配额或模型响应时间影响。日常离线测试可使用 `DI_CODE_PROVIDER=faux`。

## 许可证

本项目采用 [MIT License](LICENSE)。
