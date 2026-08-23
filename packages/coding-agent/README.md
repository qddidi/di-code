# @di-code/coding-agent

`@di-code/coding-agent` 是 [di-code](https://github.com/qddidi/di-code) 的可安装终端 AI 编码代理。安装后提供：

- `di-code`：面向人的交互式、单次输出和 JSON 事件 CLI；
- `di-code-rpc`：供 Node.js 宿主程序管理的 JSONL RPC 子进程入口；
- 内置的 `read`、`write`、`edit`、`glob`、`grep`、`bash` 工具、JSONL 会话、图片输入、上下文压缩；
- 可复用的 **Skills（技能指令）**、`AGENTS.md` 项目说明，以及插件扩展机制。

> **运行环境：**Node.js `>= 22.19.0`。真实 Provider 会产生网络请求和费用；首次体验可使用离线的 `faux` Provider。

## 目录

- [快速使用教程](#快速使用教程)
- [配置模型 Provider](#配置模型-provider)
- [日常使用](#日常使用)
- [交互模式](#交互模式)
- [会话、图片与内置工具](#会话图片与内置工具)
- [项目说明与 Skills](#项目说明与-skills)
- [插件](#插件)
- [自定义 Provider](#自定义-provider)
- [脚本和 RPC 集成](#脚本和-rpc-集成)
- [安全边界与故障排查](#安全边界与故障排查)

## 快速使用教程


### 方式一：使用首次配置向导

这是第一次使用时最简单的方式。先安装并进入项目目录：

```powershell
npm install -g @di-code/coding-agent
```
然后执行

```
di-code
```

在向导中依次完成：

1. **选择 Provider**：例如 `OpenAI`、`Anthropic`、`DeepSeek`、`Zhipu AI`；也可以选择 `Custom` 配置兼容网关；如果只想离线试用，选择 `Faux (offline)`。
2. **选择模型**：内建 Provider 会列出当前支持的模型；Custom 会先选择 API 协议，再输入 Base URL、API key 和任意模型 ID。
3. **填写 API key**：选择真实 Provider 时，在隐藏输入框中粘贴对应的 key；输入内容不会显示在终端中。
4. **确认并开始对话**：向导完成后进入 interactive 模式，在底部输入框输入问题并按 `Enter`。

向导输入的 API key 会保存到用户全局 `~/.di-code/settings.json`，供之后启动复用

已经进入交互模式后，使用 `/login` 可以重新打开 Provider、模型和 key 向导。



### 方式二：直接用 `settings.json` 配置

如果你已经知道 Provider、`baseUrl`、模型和 API key，可以不使用向导，直接创建 `settings.json`。启动时会先读取用户全局配置 `~/.di-code/settings.json`，再读取当前项目的 `.di-code/settings.json`；项目配置会覆盖同名 Provider 的已设置字段，并保留全局 Provider 中项目未设置的字段。全局配置适合个人常用 Provider，项目配置适合私有网关或项目专用模型。

同名 Provider 的 `models` 在项目中出现时会整体替换全局的模型列表；项目未写 `models` 时继续使用全局模型列表。只存在于任一文件中的 Provider 都会保留。

下面这个例子使用 OpenAI Responses 兼容接口。将示例中的 `baseUrl`、`apiKey` 和模型字段替换为实际值后即可使用：


`~/.di-code/settings.json` 或 `.di-code/settings.json`：

```json
{
  "providers": {
    "my-provider": {
      "name": "My Coding Gateway",
      "api": "openai-responses",
      "baseUrl": "https://api.example.com/v1",
      "apiKey": "your-api-key",
      "models": [
        {
          "id": "my-coding-model",
          "name": "My Coding Model",
          "input": ["text", "image"],
          "reasoning": true,
          "contextWindow": 128000,
          "maxTokens": 16384
        }
      ]
    }
  }
}
```
默认使用第一个模型。可以添加多个模型然后使用`/model`切换


`settings.json` 中的 `apiKey` 可以直接填写字符串，也可以引用环境变量。全局配置通常不进入项目 Git，因此适合保存个人配置；项目配置若使用明文 key，必须确保 `.di-code/settings.json` 不会提交。环境变量写法如下：

```json
{
  "providers": {
    "my-provider": {
      "api": "openai-responses",
      "baseUrl": "https://api.example.com/v1",
      "apiKey": "$MY_CODING_API_KEY",
      "models": [
        {
          "id": "my-coding-model",
          "input": ["text"]
        }
      ]
    }
  }
}
```

```powershell
$env:MY_CODING_API_KEY = "your-api-key"
$env:DI_CODE_PROVIDER = "my-provider"
di-code "检查当前项目的测试状态"
```

`settings.json` 中最重要的字段是：

| 字段 | 作用 |
| --- | --- |
| `providers` | Provider 配置对象，key 是 Provider ID |
| `defaultProvider` | 可选的默认 Provider；`/login` 自动更新，多个 Provider 时用于消除启动歧义 |
| `defaultModel` | `defaultProvider` 的可选默认模型；`/login` 和 `/model` 自动更新 |
| `locale` | 仅用户全局 `~/.di-code/settings.json`：`en` 或 `zh-CN`；控制内置 CLI 与交互终端文案 |
| `api` | 接口类型：`openai-responses`、`openai-chat-completions` 或 `anthropic-messages` |
| `baseUrl` | Provider 的接口地址，必须是绝对的 `http` 或 `https` URL |
| `apiKey` | API key，推荐填写 `$ENV_VAR` 或 `${ENV_VAR}` |
| `models` | 自定义 Provider 必填的模型列表 |
| `models[].id` | 模型真实 ID，也就是 `DI_CODE_MODEL` 的值 |
| `models[].input` | 输入类型，填写 `text`、`image` 或两者 |
| `models[].reasoning` | 是否支持 reasoning/thinking 内容 |
| `models[].contextWindow` | 上下文 token 上限 |
| `models[].maxTokens` | 单次最大输出 token 数 |

`models` 可以配置多个模型，运行时用 `/model` 切换，或者修改 `DI_CODE_MODEL`：

```json
{
  "providers": {
    "my-provider": {
      "api": "openai-responses",
      "baseUrl": "https://api.example.com/v1",
      "apiKey": "$MY_CODING_API_KEY",
      "models": [
        { "id": "fast-model", "input": ["text"] },
        { "id": "strong-model", "input": ["text", "image"], "reasoning": true }
      ]
    }
  }
}
```

### 方式三：使用环境变量

如果使用内建 Provider，可以只设置环境变量，不创建 `settings.json`：

```powershell
$env:DI_CODE_PROVIDER = "openai"
$env:DI_CODE_MODEL = "gpt-4o"
$env:OPENAI_API_KEY = "your-api-key"
di-code --print "检查当前项目的目录结构"
```

确认 print 模式可以正常返回后，再运行 `di-code --interactive` 开始持续对话。

## 配置模型 Provider

日常使用推荐把凭据放在操作系统环境变量或未提交的项目 `.env` 中，**不要**把真实 API key 提交到 Git。全局安装的 `di-code` 读取当前进程环境变量；若使用项目 `.env`，请先通过你的 shell、秘密管理工具或启动脚本加载它。

PowerShell 临时配置 OpenAI：

```powershell
$env:DI_CODE_PROVIDER = "openai"
$env:DI_CODE_MODEL = "gpt-4o" # 可省略，使用该 Provider 的默认模型
$env:OPENAI_API_KEY = "your-api-key"
di-code "检查这个仓库的目录结构"
```

内建 Provider：

| Provider ID | 必需 API key 变量 | 可选 endpoint 覆盖变量 |
| --- | --- | --- |
| `openai` | `OPENAI_API_KEY` | `OPENAI_BASE_URL` |
| `anthropic` | `ANTHROPIC_API_KEY` | `ANTHROPIC_BASE_URL` |
| `deepseek` | `DEEPSEEK_API_KEY` | `DEEPSEEK_BASE_URL` |
| `zhipu` | `ZAI_API_KEY` | `ZHIPU_BASE_URL` |
| `kimi` | `KIMI_API_KEY` | `KIMI_BASE_URL` |
| `faux` | 无 | 无（离线测试用） |

例如 DeepSeek：

```powershell
$env:DI_CODE_PROVIDER = "deepseek"
$env:DI_CODE_MODEL = "deepseek-v4-flash"
$env:DEEPSEEK_API_KEY = "your-api-key"
di-code "找出可能需要补测试的模块"
```

`DI_CODE_MODEL` 必须属于当前 Provider；省略时会使用内建默认模型或该 Provider 列表中的第一个模型。选错模型时，CLI 会列出可用 ID。

Kimi Coding 使用 OpenAI Chat Completions 兼容 endpoint `https://api.kimi.com/coding/v1`，内建模型为 `k3`、`k3-256k`、`kimi-for-coding` 和 `kimi-for-coding-highspeed`。Kimi 官方也提供 Anthropic 兼容 endpoint，但当前内建 Provider 使用 OpenAI 兼容协议。

### 终端语言

设置 `DI_CODE_LOCALE=zh-CN` 可为当前进程显示中文内置终端文案；`en` 则显示英文。未设置时，di-code 读取用户全局 `~/.di-code/settings.json` 的 `locale`，默认 `en`。在 interactive 模式中通过 `/settings` 切换会立即刷新界面并保存该全局偏好。项目 `.di-code/settings.json` 不会覆盖语言偏好。

JSON/RPC 字段、slash command 名称、工具名、Provider 和模型 ID，以及插件提供的文本不随 locale 改变。

## 日常使用

```text
Usage: di-code [options] <prompt>

Options:
  -p, --print        只输出最终 assistant 文本（默认）
  --mode <mode>      输出模式：print、json 或 interactive
  --interactive      启动交互式终端模式
  --continue, -c     继续最近修改的会话
  --session <path>   创建或恢复 JSONL 会话（相对工作根目录）
  --image <path>     附加本地图片；可重复传入
  --skill <path>     加载一个 SKILL.md 文件或技能目录；可重复传入
  --no-skills        不加载任何 Skill
  --no-context-files 不发现或加载 AGENTS.md
  --trust-project    信任当前项目的本地 Skills 和插件
  --untrust-project  撤销当前项目的本地信任
  plugin <action>    安装、列出、启用、禁用、更新或移除插件
  -h, --help         显示帮助
  -v, --version      显示版本
```

### 三种输出模式

| 模式 | 适合场景 | 示例 |
| --- | --- | --- |
| `print`（默认） | 单次提问、shell 调用；stdout 只有最终文本 | `di-code "解释 package.json"` |
| `json` | 脚本或其他程序消费流式事件；每行一个 JSON 记录 | `di-code --mode json "运行测试并总结结果"` |
| `interactive` | 长时间结对编码、查看流式输出与工具状态 | `di-code --interactive` |

常用示例：

```powershell
# 只获得最终回答；错误写入 stderr，成功退出码为 0
di-code --print "列出主要模块及其职责"

# JSONL 事件流。不要把这个模式的 stdout 当作普通文本解析
di-code --mode json "检查 TypeScript 配置"

# 显式进入持续对话
di-code --interactive

# 使用一个指定、可持续追加的会话
di-code --session .di-code\sessions\review.jsonl "审查当前改动"
di-code --session .di-code\sessions\review.jsonl "继续处理最高优先级问题"

# 恢复最近修改的会话
di-code --continue "继续上一次工作"
```

`--help` 和 `--version` 必须单独使用。非交互模式必须有 prompt；`--continue` 不能和 `--session` 一起使用；`--print` 不能和 `--mode json` 或 interactive 模式组合。

## 交互模式

运行 `di-code` 或 `di-code --interactive` 后，在底部输入框输入请求并按 `Enter`。生成过程中输入的新请求会排队，按顺序执行。

### Slash commands 与快捷键

输入 `/` 后可补全命令；补全菜单打开时按 `Enter` 会直接运行当前选中的 slash command，按 `Tab` 只补全到输入框。

| 命令 | 作用 |
| --- | --- |
| `/help` | 显示可用交互命令 |
| `/clear` | 仅清除屏幕可见消息，不删除会话文件 |
| `/model` | 切换当前 Provider 的模型 |
| `/session` | 选择或切换会话 |
| `/tree` | 打开当前历史对话分支树；可以选择回退至哪个阶段 |
| `/theme` | 选择 dark 或 light 主题 |
| `/settings` | 配置上下文压缩开关和内置终端语言 |
| `/login` | 打开 Provider、模型和隐藏 API key 向导；保存到用户全局配置并切换当前会话 |
| `/logout` | 移除当前 Provider 的用户全局 `apiKey`，并在适用时清除默认 Provider/模型；不改环境变量或其他 Provider 配置，当前会话保持可用至退出 |
| `/compact` | 立即压缩当前持久化会话的旧上下文 |
| `/usage` | 查看请求数、token、费用和上下文占用 |
| `/retry` | 重新提交最近失败或取消的 prompt |
| `/steer` | 在当前 prompt 运行期间向 Agent 追加引导内容（例如 `/steer 简短回答`）；空闲时使用会报错 |
| `/skill:<name>` | 手动调用一个已加载的 Skill，可附带具体请求（见下文 Skills 部分） |

插件和扩展也可以注册额外 slash command，名称与内置命令冲突时以加载诊断为准。

| 按键 | 作用 |
| --- | --- |
| `Enter` | 发送当前 prompt |
| `Shift+Enter` | 在输入框中插入换行 |
| `Esc` | 取消当前模型请求并显示取消状态；没有请求时关闭补全或选择器 |
| `Ctrl+C` | 退出并恢复终端状态 |
| `Tab` | 补全 slash command |
| `Alt+S` | 把编辑框当前内容作为引导发送给运行中的 Agent（与 `/steer` 等价） |
| `Shift+Tab` | 循环切换模型的 thinking 等级并保存为用户偏好（模型不支持时提示错误） |
| `Ctrl+O` / `Ctrl+L` | 打开模型 / 会话选择器 |
| `Ctrl+T` / `Ctrl+S` | 打开主题 / 设置 |
| `Ctrl+R` | 重试最近失败的 prompt |

取消只停止当前请求，不会删除已经追加到磁盘的会话记录，并显示取消状态而非错误。之后可使用 `/retry` 再试一次。

## 会话、图片与内置工具

### 会话

交互式启动默认会在用户目录 `~/.di-code/sessions/<工作区哈希>/` 创建 v2 JSONL 会话。记录为 append-only（只追加）格式，可引用任意已提交父节点，因此一份文件可以保存多个分支；重启默认恢复物理文件末端记录所在的分支。`/tree` 只在 interactive 模式提供专用树浏览器：以紧凑单栏树显示节点摘要和当前路径，当前选择以 `›` 标识；选择用户消息会将其文本恢复到编辑器，并从它的父节点创建新的 sibling 分支；选择 assistant、tool result 或 summary 则将该节点作为活动叶节点。`s` 会在所选路径上执行现有上下文压缩，成功后的 summary 成为下一条 prompt 的分支父节点；没有有效压缩切点时会明确失败。图片附件不会自动恢复，导航只改变模型可见上下文，不能回滚工作区副作用。v1 或未知版本的会话文件不迁移，打开时返回 `UNSUPPORTED_VERSION`。完整磁盘历史和发送给模型的压缩上下文分开保存，summary 只作用于其所在分支。`/session` 与 `--continue` 只显示或恢复当前工作区的默认会话；`--session` 可以打开任意指定路径。已有项目内 `.di-code/sessions/` 文件不会自动移动，仍可用 `--session <path>` 显式打开。

产品 interactive 与 RPC 会话都由 Composition 的 `AgentSessionFactory` 创建。factory 为每个会话建立 isolated Context，并从当时已激活的 `ToolRegistry` 与 capability services 固定工具快照；禁用或未加载的工具不会被会话补回。直接构造 `AgentSession` 必须传入不可变 `tools` 快照；SDK 集成应使用 Composition factory 或自行从其注册表创建该快照。

会话可能包含你的 prompt、模型回答、工具结果和图片内容。不要在 prompt 或图片中提交不应保留在本地历史中的密钥或敏感材料。

### 图片

非交互模式使用 `--image`，可重复传入：

```powershell
di-code --image .\diagram.png "解释这张架构图"
di-code --image .\before.png --image .\after.webp "比较两张图"
```

只支持 PNG、JPEG、WebP、GIF；文件根据内容签名而不是扩展名校验。每条 prompt 最多 4 张、每张最多 5 MiB，并且当前模型必须声明支持图片输入。

交互模式中可输入 `@diagram.png`；有空格的路径使用 `@"architecture diagram.png"`。也可将图片拖入终端。读取剪贴板图片时，Windows 使用 `Alt+V`，macOS/Linux 使用 `Ctrl+V`。剪贴板临时文件放在用户目录 `~/.di-code/clipboard/<工作区哈希>/<进程 ID>/`，发送、删除引用或退出后会清理；启动时也会清理当前工作区超过 24 小时的遗留文件。

### Agent 可调用的内置工具

模型可按任务需要调用以下工具；请在可信项目中运行，并在 prompt 中明确希望它执行或不执行的动作。

| 工具 | 功能 | 限制 |
| --- | --- | --- |
| `read` | 读取工作根目录中的 UTF-8 文本文件 | 最多 2,000 行、50 KiB；支持 `offset`、`limit` |
| `write` | 创建或完全覆盖 UTF-8 文件 | 自动创建父目录 |
| `edit` | 对文件做一次唯一的精确文本替换 | 找不到或匹配多处时拒绝写入；保留 BOM 和换行风格 |
| `glob` | 按 glob pattern 查找文件 | 返回排序后的相对路径；默认最多 200 个结果、50 KiB；跳过 symlink |
| `grep` | 在 UTF-8 文本文件中查找字面量文本 | 返回 `path:line` 匹配；默认最多 200 个结果、50 KiB；跳过二进制文件、symlink 和超过 2 MiB 的单文件 |
| `bash` | 在工作根目录执行本地命令 | 默认 30 秒、最大 5 分钟；stdout/stderr 各截断至 50 KiB |

文件工具限制目标在工作根目录内并拒绝二进制文件。`glob` 和 `grep` 使用 Node 文件 API，不依赖系统安装的 `grep` 或 shell；它们不跟随 symlink，并支持取消信号。`grep` 的 `pattern` 是字面量匹配，不是正则表达式。`bash` 在 Windows 使用 PowerShell，在其他平台使用 `/bin/sh`；它并不是操作系统级沙箱。模型和插件仍可能尝试执行危险操作，因此请审查任务和结果，并避免在包含无关敏感文件的目录运行。

## MCP Server

受信任项目可在工作根目录创建 `.mcp.json` 来接入 MCP Server tools。支持本地 `stdio` 和远程 Streamable HTTP：

```json
{
  "mcpServers": {
    "project-tools": { "command": "npx", "args": ["-y", "@example/project-mcp"] }
  }
}
```

HTTP 配置使用 `type: "http"`、绝对 `http`/`https` `url` 和可选 `headers`。Server ID 使用小写字母、数字、`-` 和 `_`；工具名会转换为 `mcp__project-tools__<tool-name>`。支持 resources/prompts 的 Server 还会显式注册 `mcp__project-tools__resources_list`、`resource_read`、`prompts_list` 和 `prompt_get`；资源和提示词不会自动注入模型上下文。`env` 和 `headers` 中可使用 `${ENV_VAR}`，缺失变量会阻止该配置加载且不会泄露变量值。项目未获 trust 时不会启动 local/project Server；user scope 仍可使用。连接、schema、认证或工具调用错误会产生脱敏 `mcp_diagnostic` 或正常的工具错误。MCP Server 是外部代码，项目 trust 不是权限沙箱。

配置管理命令：

```powershell
di-code mcp add project-tools -- npx -y @example/project-mcp
di-code mcp add --scope project project-tools -- npx -y @example/project-mcp
di-code mcp add --scope project --transport http company-api https://mcp.example.com/mcp
di-code mcp list --scope project
di-code mcp get company-api
di-code mcp remove company-api --scope project
```

配置范围按 `local` > `project` > `user` 生效：local 写入 `<work-root>/.di-code/mcp.local.json`，project 写入 `<work-root>/.mcp.json`，user 写入 `~/.di-code/mcp.json`。同一 Server ID 整体覆盖，不做字段级合并。interactive 启动时，每个 MCP Server 会先显示黄色 `[loading]`，并在完成时原位替换为绿色 `[ok]` 或红色 `[error]`；成功状态包含 tools、resources 和 prompts 数量，失败信息经过脱敏。`mcp add <id> -- <command> [args...]` 默认使用 local stdio；HTTP 必须显式指定 `--transport http`。`list` 和 `get` 会脱敏 header、环境变量和其他凭据；`add` 不安装或下载 Server 软件，stdio 的命令仍由用户提供并在连接时执行。

## 项目说明与 Skills

### `AGENTS.md`：给 Agent 的项目规则

启动时，di-code 会读取全局 Agent 目录中的 `AGENTS.md`（或 `AGENTS.MD`），以及当前工作目录中的同名文件。不会自动加载当前目录父级中的 `AGENTS.md`。这些文件会作为项目上下文提供给模型，适合记录构建命令、代码风格、测试要求和目录约定。

项目文件是**不可信的上下文**，不能改变 CLI 的真实路径、权限或安全边界。临时忽略所有这类文件：

```powershell
di-code --no-context-files "只分析当前文件，不遵循项目说明"
```

### Skills：可按需加载的专业工作流

Skill 是带 YAML frontmatter 的 `SKILL.md` 文件。解析、发现、目录和正文读取由独立的 `@di-code/skills` 包提供；它不是可执行代码。默认情况下，模型只看到名称和描述；任务匹配时，它必须使用受控的 `load_skill` 工具按名称加载正文。

Skill 的发现位置和优先级如下：

1. `--skill <path>` 显式传入的文件或目录；
2. 已信任项目的 `.di-code/skills/` 与 `.agents/skills/`；
3. 用户全局目录 `~/.di-code/skills/`。

目录会递归查找名为 `SKILL.md` 的文件，跳过隐藏目录和 `node_modules`。同名时先发现的 Skill 生效；冲突和格式错误会产生诊断。项目 Skill 不会在项目未信任时加载。Skill metadata 不能授予文件、命令或网络权限。

创建项目 Skill：

```text
my-project/
  .di-code/
    skills/
      release-check/
        SKILL.md
```

`.di-code/skills/release-check/SKILL.md`（或 `.agents/skills/release-check/SKILL.md`）：

```markdown
---
name: release-check
description: Verify the release checklist before publishing a package.
---

1. Read the unreleased changelog section.
2. Run the project test command before any release action.
3. Report failures; never publish unless the user explicitly asks.
```

规则：

- `name` 必填，最长 64 个字符，只能使用小写字母、数字和单连字符；
- `description` 必填，最长 1,024 个字符；
- 文件最大 256 KiB，首行和 frontmatter 结束行必须都是 `---`；
- 可加 `disable-model-invocation: true` 隐藏该 Skill，使模型不自动选择它，但用户仍可手动调用。

交互式 TTY 首次发现项目本地 Skill、插件或扩展目录时，di-code 会询问是否信任当前项目。回答 `y`/`yes` 会加载这些项目资源，其他输入（包括直接回车）会拒绝加载；选择会保存到用户全局 Agent 目录，后续启动不再重复询问。非交互模式不会等待询问，默认不信任。

也可以显式授予信任：

```powershell
Set-Location D:\work\my-project
di-code --trust-project --interactive
```

撤销：

```powershell
di-code --untrust-project --interactive
```

手动选择一个已加载 Skill 的语法为 `/skill:<name> [你的具体请求]`，可在普通 prompt 或交互输入框中使用：

```powershell
di-code "/skill:release-check 检查这个仓库是否已经满足发布前置条件"
```

或临时加载不属于项目目录的 Skill：

```powershell
di-code --skill D:\team-skills\release-check "按 release-check 流程检查"
di-code --no-skills "不要加载任何 Skill"
```

> Skill 是提示词上下文，不是权限机制。只把可信、准确的 Skill 放入全局目录或授予项目信任；Skill 中提及的相对路径以该 Skill 所在目录为基准。

## 插件

插件是与 di-code 运行在**同一 Node.js 进程**中的 JavaScript/TypeScript namespace module。Provider、Agent、工具、Session、CLI/TUI、RPC、MCP 和 Skills 都以 Composition entry 装配；第三方 entry 可以在公开 runtime/registry 边界贡献服务、工具、命令、renderer 或事件观察者。

发布插件必须在 `package.json.diCode.plugins` 中只列出一个 package `exports` entry。namespace 必须导出非空 `name` 和 `apply`，不能有 `default` export；`apiVersion` 若存在必须为 `1`，`version` 若存在必须是合法标识。Loader 只解析 enabled managed package；disabled package 不会 import。required entry 失败会回滚已经 active 的 entry 并阻止启动，optional entry 失败会成为 `skipped` inventory。完整 package shape、SDK、Composition、trust、capability 和 lifecycle 规则见[插件使用指南](../../docs/插件使用指南.md)。

插件不是 MCP Server，也没有热重载、插件市场或真正的权限沙箱。manifest 的 `permissions` 是声明和 capability audit 信息，**不会**阻止插件访问文件、网络或子进程。因此，只安装可信来源的插件。`--trace-plugins` 可显示实际 phase 和失败诊断。

### 管理全局插件

全局托管插件安装在用户的 `~/.di-code/plugins/installed/` 下，只有已启用的插件会在启动时加载：

```powershell
# 本地目录、npm 包或 git URL 都可以作为来源
di-code plugin install D:\work\my-plugin
di-code plugin install npm:@acme/di-code-project-status@1.0.0
di-code plugin install git:https://github.com/acme/di-code-project-status.git

# 查看 ID、启用状态和版本
di-code plugin list
di-code plugin get project-status

di-code plugin disable project-status
di-code plugin enable project-status
di-code plugin update project-status
di-code plugin remove project-status
```

安装过程固定使用 `npm --ignore-scripts`，但这并不使插件本身安全：插件在加载时仍是本机代码。`plugin` 管理命令不需要配置 Provider。

默认运行时先加载 `base` composition，再加载 `interactive`、`print`、`json` 或 `rpc` entry 集合。`--profile <print|json|interactive>` 选择 CLI profile；`--composition <path>` 将一个 JSON 或 YAML document 作为最后一层应用，固定优先级为 `base -> mode -> ~/.di-code/composition.yml -> <work-root>/.di-code/composition.yml -> --composition`。项目 composition 仅在该项目已被 `--trust-project` 信任时读取；`--no-project-plugins` 会为当前运行跳过它，但不会禁用用户托管插件。缺失的 user/project 文件会忽略，格式错误或显式文件不可读取则终止启动并显示路径。`plugin-manager` 是一个 command plugin，管理操作不会 import 已禁用插件。嵌入产品仍可直接使用 `@di-code/plugin-loader` 的公开 API。需要诊断 composition 时可运行：

```powershell
di-code --trace-plugins
di-code --dump-composition
```

两条命令按需挂载 `plugin-trace` 和 `plugin-dump-composition`，输出实际 resolved tree、entry phase、owner Fiber、capability audit 与脱敏失败信息；不会输出 entry config、安装路径、凭据或完整 Provider 请求。

## 自定义 Provider

在 interactive TTY 的首次向导或 `/login` 中选择 `Custom`，可以按协议、Base URL、API key 和模型 ID 的顺序配置一个用户级固定 `custom` Provider。支持 `openai-responses`、`openai-chat-completions` 和 `anthropic-messages`。Base URL 必须是绝对 `http`/`https` URL，不能包含凭据、query、hash 或尾随 `/`。如果模型 ID 与内置目录中的同协议模型精确匹配，向导会复制其能力元数据；否则使用保守的文本模型默认值。重新配置会覆盖 `custom`，但保留其他用户级 Provider。

自定义 OpenAI Responses 兼容网关或私有模型时，可在用户全局 `~/.di-code/settings.json` 或工作根目录 `.di-code/settings.json` 中声明 Provider。两个文件同时存在时，项目配置覆盖全局配置中的同名 Provider 字段。`apiKey` 可以直接填写，或使用环境变量引用：

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
          "maxTokens": 32000
        }
      ]
    }
  }
}
```

然后设置 Provider、模型和凭据：

```powershell
$env:COMPANY_GATEWAY_API_KEY = "your-api-key"
$env:DI_CODE_PROVIDER = "company-gateway"
$env:DI_CODE_MODEL = "company-coder"
di-code "总结当前项目"
```

`api` 可为 `openai-responses`、`openai-chat-completions` 或 `anthropic-messages`。自定义 Provider 必须提供 `models`；每个模型可设置 `id`、`name`、`input`、`reasoning`、`reasoningEfforts`、`defaultReasoningEffort`、`contextWindow`、`maxTokens`（或 `maxOutputTokens`）及按美元/百万 token 计的 `cost`。`defaultReasoningEffort` 必须在 `reasoningEfforts` 中。Chat Completions 模型还可声明 `chatCompletionsCompat`，用于 DeepSeek/GLM/Kimi 的 thinking、reasoning_effort、`max_tokens`、流式 usage 和 `tool_stream` 等兼容差异。Kimi 模型支持 `low`、`high`、`max` 推理等级；Kimi 不发送 DeepSeek/智谱的 `thinking` 对象，而是发送 `reasoning_effort`。

`apiKey` 支持直接字符串，也支持 `$NAME` 或 `${NAME}` 环境变量引用。项目级 `settings.json` 若含明文 key，必须保持未提交；`baseUrl` 必须是绝对 `http`/`https` URL。

## 脚本和 RPC 集成

### 处理 CLI 退出码

脚本中可根据退出码处理结果：`0` 表示成功，`1` 表示参数错误、Provider 未配置或运行失败。print 模式的最终回答写 stdout；错误写 stderr，避免混入回答。

```powershell
di-code --print "生成变更摘要"
if ($LASTEXITCODE -ne 0) {
  throw "di-code failed with exit code $LASTEXITCODE"
}
```

JSON 模式的 stdout 是逐行版本化事件，适合流式消费：

```powershell
di-code --mode json "检查测试状态" | ForEach-Object {
  $event = $_ | ConvertFrom-Json
  # 根据 $event.type 处理事件
}
```

### JSONL RPC

`di-code-rpc` 是供宿主程序启动的子进程入口，不是交互命令。它从 stdin 接收一行一个 JSON 请求，并从 stdout 写一行一个版本化响应或事件；stderr 仅用于诊断。

worker 通过 composition 的 `AgentSessionFactory` 创建 session，而不是入口直接构造 session。stdin 结束或收到终止信号时，它会先结束或取消活跃请求并写入终态 response，再 flush stdout、dispose composition，最后退出。嵌入 `RpcServer` 时，使用可 await 的 `shutdown()` 获得同一顺序；`stop()` 保留为兼容的非阻塞入口。

公开 RPC 方法：

| 方法 | 参数 | 结果 |
| --- | --- | --- |
| `get_state` | `{}` | Session ID、模型、是否正在生成、消息数 |
| `prompt` | `{ "message": "..." }` | 最终 `AssistantMessage`，中间事件另行输出 |
| `cancel` | `{ "requestId": "..." }` | 是否找到并取消该请求 |

Node.js 宿主从公开入口导入 SDK：

```ts
import { RpcClient, RPC_PROTOCOL_VERSION } from "@di-code/coding-agent/rpc";
```

需要监督子进程生命周期时，使用 `@di-code/orchestrator`，不要依赖 coding-agent 的内部文件路径。

## 安全边界与故障排查

- 在可信项目根目录运行；`bash` 不是沙箱，插件也没有沙箱。
- 向导会将输入的 API key 保存到用户全局 `~/.di-code/settings.json`；不要放入 prompt、Skill、插件源码、会话、图片、项目配置或 Git。
- 项目 Skill 和 MCP 配置默认不加载；交互式 TTY 首次发现这些内容时会询问一次，`--trust-project` / `--untrust-project` 可显式控制。该决定不会导入旧项目本地插件目录，也不会赋予额外系统权限。
- Provider、模型、图片、配置和工具参数都会校验；外部项目内容和模型输出仍应视作不可信输入。

| 问题 | 优先检查 |
| --- | --- |
| `Provider is not configured` | 设置 `DI_CODE_PROVIDER` 及对应 API key；或在 TTY 中运行 `di-code` 使用向导；离线测试使用 `faux` |
| `Unknown model` | 确认 `DI_CODE_MODEL` 属于当前 `DI_CODE_PROVIDER` |
| 项目 Skill / MCP 没有加载 | Skill 目录是否为 `.di-code/skills` 或 `.agents/skills`，或检查 `.mcp.json`；交互式启动时确认 trust 提示，或运行 `di-code --trust-project --interactive` |
| `Unknown skill` | Skill 是否有正确 `SKILL.md` frontmatter，名称是否匹配 `/skill:<name>`；检查是否被 `--no-skills` 禁用 |
| plugin Loader 诊断 | 检查 `package.json.diCode.plugins`、对应 `exports`、namespace `name`/`apply` 与 `di-code --dump-composition` 输出；详见插件指南 |
| 图片被拒绝 | 确认格式、4 张/5 MiB 限制，以及模型 `input` 包含 `image` |
| 文件工具无法访问路径 | 从工作根目录启动，且目标未越出根目录；二进制文件不支持 |

## 相关链接

- 项目源码与完整开发文档：<https://github.com/qddidi/di-code>
- 插件详细指南：[GitHub 上的《插件使用指南》](https://github.com/qddidi/di-code/blob/main/docs/%E6%8F%92%E4%BB%B6%E4%BD%BF%E7%94%A8%E6%8C%87%E5%8D%97.md)
- 问题反馈：<https://github.com/qddidi/di-code/issues>
- 许可证：[MIT](https://github.com/qddidi/di-code/blob/main/LICENSE)
