# @di-code/coding-agent

`@di-code/coding-agent` 是 [di-code](https://github.com/qddidi/di-code) 的可安装终端 AI 编码代理。它包含 `di-code` CLI、本地 `read` / `write` / `edit` / `bash` 工具、会话管理、上下文压缩、交互式 ANSI UI、扩展系统和 JSONL RPC 服务端。

要求 Node.js `>= 22.19.0`。

## 快速安装启动

```powershell
npm install @di-code/coding-agent -g
```

在需要 Agent 操作的项目目录启动交互式终端界面：

```powershell
di-code
```

没有 `DI_CODE_PROVIDER` 或 Provider 配置时，真实终端会启动首次配置向导。向导中输入的 API key 只保存在本次进程内存中。

## CLI 命令

完整用法：

```text
Usage: di-code [options] <prompt>

Options:
  -p, --print        只输出最终 assistant 文本（默认）
  --mode <mode>      输出模式：print、json 或 interactive
  --interactive      启动交互式终端模式
  --continue, -c     继续最近修改的会话
  --session <path>   创建或恢复 JSONL 会话，路径相对于工作根目录
  -h, --help         显示帮助
  -v, --version      显示版本
```

常用命令：

```powershell
# 查看帮助和版本，不需要 Provider 或 API key
di-code --help
di-code --version

# 单次提问，默认是 print 模式
di-code "解释当前项目的目录结构"
di-code --print "找出项目中可能的 bug"

# JSON 模式：每行一个版本化事件，适合 PowerShell 或其他脚本消费
di-code --mode json "列出所有 TypeScript 文件"

# 交互模式：持续输入多个 prompt
di-code --interactive

# 保存到指定 JSONL 会话，后续可继续使用
di-code --session .di-code\sessions\review.jsonl "审查这个项目"
di-code --session .di-code\sessions\review.jsonl "检查测试覆盖率"

# 继续最近修改的会话
di-code --continue "继续上一次工作"
```

`--help` 和 `--version` 必须单独使用。非交互模式必须提供 prompt；`--continue` 不能和 `--session` 同时使用；`--print` 不能和 `--mode json` 或 `--interactive` 同时使用。

脚本中可以根据退出码判断结果：`0` 表示命令成功，`1` 表示参数错误、Provider 未配置或运行失败。错误文本写入 stderr，不会混入 `print` 模式的最终回答。

## 交互模式操作

运行 `di-code` 或 `di-code --interactive` 后，底部编辑器就是 prompt 输入框。输入内容后按 Enter 发送；模型生成期间再次输入的 prompt 会进入队列，按顺序执行。

### 斜杠命令

在输入框中输入 `/`，再按 Tab 可以打开命令补全菜单：

| 命令 | 作用 |
| --- | --- |
| `/help` | 在状态区显示所有交互命令 |
| `/clear` | 清除当前屏幕上的可见消息，不删除 JSONL 会话历史 |
| `/model` | 打开模型选择器，切换当前 Provider 的模型 |
| `/session` | 打开会话选择器，切换或查看当前会话 |
| `/theme` | 在 dark 和 light 终端主题之间切换 |
| `/settings` | 打开设置，目前可切换上下文压缩 `on` / `off` |
| `/compact` | 立即压缩当前已持久化会话的上下文 |
| `/usage` | 显示请求数、输入/输出 token、总 token、费用和上下文占用 |
| `/retry` | 重试最近一次失败的 prompt |

例如：

```text
/help
/model
/usage
请检查刚才发现的问题
```

未知的 `/command` 会显示错误，不会发送给模型。`/clear` 只影响当前界面；想恢复之前的完整历史，应使用 `--session <path>` 或 `--continue` 打开会话。

### 快捷键

| 按键 | 作用 |
| --- | --- |
| `Enter` | 发送当前 prompt |
| `Esc` | 取消正在进行的模型请求；没有请求时取消当前补全或关闭选择器 |
| `Ctrl+C` | 退出交互模式并恢复终端状态 |
| `Ctrl+O` | 打开模型选择器，与 `/model` 相同 |
| `Ctrl+L` | 打开会话选择器，与 `/session` 相同 |
| `Ctrl+T` | 打开主题选择器，与 `/theme` 相同 |
| `Ctrl+S` | 打开设置，与 `/settings` 相同 |
| `Ctrl+R` | 重试最近一次失败的 prompt，与 `/retry` 相同 |
| `Tab` | 补全斜杠命令；编辑普通文本时继续由编辑器处理 |

模型请求运行时按 `Esc` 会发送取消信号；取消后的 prompt 可以用 `/retry` 或 `Ctrl+R` 再次提交。退出只结束当前 CLI 进程，不会删除已经写入磁盘的会话文件。

## Provider 配置

全局安装的 CLI 启动前需要设置环境变量。不要把 API key 写入源代码或提交到 Git。

```powershell
$env:DI_CODE_PROVIDER = "openai"
$env:DI_CODE_MODEL = "gpt-4o" # 可选，不设置时使用默认模型
$env:OPENAI_API_KEY = "your-openai-api-key"
di-code --print "总结这个仓库"
```

DeepSeek 使用 `$env:DI_CODE_PROVIDER = "deepseek"`、`$env:DEEPSEEK_API_KEY`，可选 `$env:DI_CODE_MODEL`。可选 endpoint 覆盖变量是 `OPENAI_BASE_URL` 和 `DEEPSEEK_BASE_URL`。设置 `DI_CODE_PROVIDER=faux` 可使用离线确定性 Provider。

Anthropic 使用 `$env:DI_CODE_PROVIDER = "anthropic"`、`$env:ANTHROPIC_API_KEY`，可选 `$env:DI_CODE_MODEL = "claude-sonnet-4-5"` 和 `$env:ANTHROPIC_BASE_URL`。默认 endpoint 是 `https://api.anthropic.com`。

## 自定义Provider settings

要使用自定义 OpenAI Responses 兼容网关，请在工作目录创建 `.di-code/settings.json`。凭据保存在环境变量中，文件只引用变量名，或者直接配置到apiKey中：

```json
{
	"providers": {
		"company-gateway": {
			"name": "Company Gateway",
			"api": "openai-responses",
			"baseUrl": "https://gateway.example.com/v1",
			"apiKey": "$COMPANY_GATEWAY_API_KEY",
			"models": [{
				"id": "company-coder",//如gpt-5.5
				"input": ["text"],
				"reasoning": true,
				"contextWindow": 200000,//可选，根据实际情况填写
				"maxTokens": 32000 //可选
			}]
		}
	}
}
```

然后设置 `$env:COMPANY_GATEWAY_API_KEY`、`$env:DI_CODE_PROVIDER = "company-gateway"`，以及可选的 `$env:DI_CODE_MODEL = "company-coder"`。`apiKey` 支持 `$NAME` / `${NAME}` 引用。如果直接写入配置文件则无需设置环境变量。

### Provider 和模型字段

`.di-code/settings.json` 的根节点必须是 `providers` 对象。对象的 key 就是 Provider ID，用于 `DI_CODE_PROVIDER`。自定义 Provider 必须配置 `api` 和 `models`；内建 `openai`、`anthropic`、`deepseek`、`zhipu` 可以省略 `models`，使用内置模型目录。

Provider 字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `name` | string | 可选的显示名称，省略时使用 Provider ID |
| `api` | string | `openai-responses`、`deepseek-responses`、`zhipu-chat-completions` 或 `anthropic-messages` |
| `baseUrl` | string | Provider 默认 endpoint，必须是 `http` 或 `https` URL |
| `apiKey` | string | 推荐写 `$ENV_VAR` 或 `${ENV_VAR}`；也可直接写值，但不应提交到 Git |
| `models` | array | 自定义 Provider 必填；每项是一个模型对象 |

模型字段：

| 字段 | 类型 | 默认值或规则 |
| --- | --- | --- |
| `id` | string | 必填；也是 `DI_CODE_MODEL` 使用的模型 ID |
| `name` | string | 默认等于 `id` |
| `api` | string | 默认继承 Provider 的 `api`；模型值优先 |
| `baseUrl` | string | 默认继承 Provider 的 `baseUrl`；模型值优先 |
| `input` | array | 默认 `["text"]`；可填 `"text"`、`"image"` 或两者 |
| `reasoning` | boolean | 默认 `false`，表示模型是否支持思考内容 |
| `contextWindow` | 正整数 | 默认 `128000`，模型上下文 token 上限 |
| `maxTokens` | 正整数 | 默认 `16384`，单次最大输出 token；也支持 `maxOutputTokens` |
| `cost.input` | 非负数 | 默认 `0`，美元/百万输入 token |
| `cost.output` | 非负数 | 默认 `0`，美元/百万输出 token |
| `cost.cacheRead` | 非负数 | 默认 `0`，美元/百万缓存读取 token |
| `cost.cacheWrite` | 非负数 | 默认 `0`，美元/百万缓存写入 token |

完整示例：

```json
{
	"providers": {
		"company-gateway": {
			"name": "公司网关",
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

模型级 `baseUrl` 和 `api` 可以覆盖 Provider 级字段，模型级 `apiKey` 不存在，凭据始终从 Provider 级 `apiKey` 获取。`DI_CODE_MODEL` 必须匹配所选 Provider 的某个 `models[].id`；省略时使用该 Provider 的第一个模型。自定义模型只属于声明它的 Provider，不会自动出现在其他 Provider 的列表中。

## RPC 集成

该包还安装 `di-code-rpc`，这是供宿主程序使用的 JSONL 子进程入口，不是交互式终端命令。Node.js 宿主程序从 `@di-code/coding-agent/rpc` 导入 RPC API；需要监管子进程时使用 `@di-code/orchestrator`。

## 链接

- 源码和完整配置说明：<https://github.com/qddidi/di-code>
- 提交问题：<https://github.com/qddidi/di-code/issues>
