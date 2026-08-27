# CLI 与配置

## 命令行

```text
di-code [options] <prompt>
```

主要选项：

| 选项 | 说明 |
| --- | --- |
| `-p, --print` | 最终文本模式（默认） |
| `--mode print\|json\|interactive` | 选择输出模式 |
| `--interactive` | 进入交互模式 |
| `--continue, -c` | 恢复当前工作区最近会话 |
| `--session <path>` | 指定或创建 JSONL 会话 |
| `--image <path>` | 附加图片；每个 prompt 最多 4 张、每张 5 MiB |
| `--skill <path>` | 显式加载 Skill 文件或目录，可重复 |
| `--no-skills` | 禁用 Skill 发现 |
| `--no-context-files` | 不加载 `AGENTS.md` |
| `--trust-project` / `--untrust-project` | 设置当前项目的信任状态 |
| `--profile <mode>` | 选择对应 Composition |
| `--composition <path>` | 在用户/项目层之后应用 JSON/YAML Composition |
| `--no-project-plugins` | 本次跳过项目 Composition |

另有 `plugin ...`、`mcp add|list|get|remove`、`web [--port] [--workspace]`、`--trace-plugins` 和 `--dump-composition`。完整帮助来自 CLI registry，可执行 `di-code --help` 查看当前构建的命令。

## Provider 环境变量

| Provider | ID | Key | 可选 Base URL |
| --- | --- | --- | --- |
| OpenAI | `openai` | `OPENAI_API_KEY` | `OPENAI_BASE_URL` |
| Anthropic | `anthropic` | `ANTHROPIC_API_KEY` | `ANTHROPIC_BASE_URL` |
| DeepSeek | `deepseek` | `DEEPSEEK_API_KEY` | `DEEPSEEK_BASE_URL` |
| Kimi | `kimi` | `KIMI_API_KEY` | `KIMI_BASE_URL` |
| 智谱 | `zhipu` | `ZAI_API_KEY` | `ZHIPU_BASE_URL` |
| Faux | `faux` | 无 | 无 |

通用变量：`DI_CODE_PROVIDER` 选择 Provider，`DI_CODE_MODEL` 选择模型，`DI_CODE_LOCALE` 为 `en` 或 `zh-CN`。环境变量优先于 settings；非交互模式必须明确 Provider（settings 中只有一个 Provider 时可省略）。

## settings.json

读取顺序是用户级 `~/.di-code/settings.json`，再到项目 `.di-code/settings.json`。同名 Provider 的项目字段覆盖用户字段；项目 `models` 出现时整体替换该列表。凭据推荐使用环境变量引用：

```json
{
  "defaultProvider": "gateway",
  "providers": {
    "gateway": {
      "name": "Team Gateway",
      "api": "openai-responses",
      "baseUrl": "https://api.example.com/v1",
      "apiKey": "$TEAM_API_KEY",
      "models": [
        { "id": "coding-model", "input": ["text", "image"], "reasoning": true, "contextWindow": 128000, "maxTokens": 16384 }
      ]
    }
  }
}
```

`api` 只能是 `openai-responses`、`openai-chat-completions` 或 `anthropic-messages`；`baseUrl` 必须是绝对 `http`/`https` URL。`models[].maxTokens` 必须小于 `contextWindow`。`apiKey` 支持 `$NAME` 和 `${NAME}`，不要提交明文 key。

用户级 settings 还保存 `locale`、`permissionMode`（`ask`、`allow`、`deny`）、`defaultModel` 和按 Provider/模型记录的 `thinkingLevels`。项目 settings 不覆盖语言偏好；WebUI 在已有项目 settings 时把模型和 thinking 写回项目，否则写回用户级文件。

## Composition

Composition 层按 `base -> mode -> user -> project -> explicit` 合并。用户文件为 `~/.di-code/composition.yml`，项目文件为 `.di-code/composition.yml`，显式文件由 `--composition` 指定。项目层只有在信任项目后读取；`--no-project-plugins` 仅影响本次项目层。

Composition 只接受 JSON/YAML 值，禁止命令表达式；配置中的 `$ENV_VAR` 会在加载时解析。entry 支持 `dependsOn`、`optionalDependsOn`、`required`、`disabled`，patch 支持 insert/append/remove/replace/enable/disable/move。格式错误、缺依赖或循环会阻止启动。

## 安全边界

`read`、`write`、`edit`、`glob`、`grep` 受工作根目录和 symlink 边界约束；`bash` 使用当前工作目录执行 PowerShell 或 `/bin/sh`，不是操作系统沙箱。模型输出、项目文件、Skill、MCP Server 和插件都按不可信输入处理。
