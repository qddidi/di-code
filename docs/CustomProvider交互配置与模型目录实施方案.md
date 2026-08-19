# Custom Provider 交互配置与模型目录实施方案

## 1. 文档状态与目标

本文是为 di-code 的首次 Provider 配置向导增加 `Custom` 选项的实施方案。仓库当前已经支持 `.di-code/settings.json` 中的自定义 Provider；本文定义的是交互式配置入口、内置模型元数据复用规则和模型目录扩充顺序，不代表这些交互行为已经实现。

目标是在 interactive TTY 中让用户完成以下配置，而不要求先手写 JSON：

```text
Custom
  -> 选择 API 协议
  -> 输入 Base URL
  -> 输入 API key
  -> 输入模型 ID
  -> 复用已知模型元数据或创建保守默认模型
  -> 保存为用户级 Provider 并立即启用
```

本方案不新增 Provider 协议，也不改变 `@di-code/agent` 的模型-工具循环。外部接口请求仍由 `@di-code/ai` 的既有 Provider 适配器执行；`@di-code/coding-agent` 只负责配置、输入校验、持久化和 interactive UI。

## 2. 当前基础

当前代码已提供下列可复用能力：

- `packages/ai/src/models.ts` 是唯一可手工维护的模型目录源，运行生成器后得到 `models.generated.ts`。
- 模型有 `id`、`api`、`input`、`reasoning`、上下文窗口、最大输出以及 Chat Completions 兼容参数等元数据。
- `packages/coding-agent/src/startup.ts` 已解析和校验 `settings.json` 的自定义 Provider，并可为 `openai-responses`、`openai-chat-completions`、`anthropic-messages` 创建运行时 Provider。
- `packages/coding-agent/src/provider-onboarding.ts` 已实现内置 Provider、模型选择、隐藏 API key 输入、取消和用户级密钥保存。

因此实现不应创建第二套配置格式或 HTTP 客户端。Custom 交互最终必须生成既有 `StartupProviderConfiguration` 可以加载的配置。

## 3. 范围与非目标

第一阶段包含：

- interactive Provider 列表中的 `Custom` 选项。
- 三种已支持协议：`openai-responses`、`openai-chat-completions`、`anthropic-messages`。
- `baseUrl`、`apiKey`、`modelId` 的顺序输入与边界校验。
- 以 `(api, modelId)` 为键的内置模型元数据查找与复制。
- 未知模型的保守默认值。
- 用户级 `~/.di-code/settings.json` 的保存、默认 Provider/Model 更新和下次启动恢复。
- 模型目录中常用、可由现有协议承载的模型补充。

第一阶段不包含：

- 自动请求 `/models` 或供应商私有模型列表。该行为需要认证、分页、网络失败语义和网关兼容性设计，不能作为向导的隐式网络请求。
- 新协议，例如 Gemini 原生 API、AWS Bedrock、Vertex AI、Azure 专有 API 或 Ollama 原生 API。
- 根据模型名称猜测厂商、上下文窗口、推理能力或工具调用能力。
- 将 Custom 配置写入项目 `.di-code/settings.json`。首次向导是用户偏好，默认只修改用户级配置；项目共享配置仍由用户显式维护。

## 4. 第一阶段先补全模型目录

在实现向导前，先扩充 `@di-code/ai` 的内置模型目录。Custom 的复用质量完全取决于该目录；先完成目录数据和测试，交互流程才能稳定依赖它。

### 4.1 目录来源和维护规则

只编辑 `packages/ai/src/models.ts`，再运行其生成脚本更新 `packages/ai/src/models.generated.ts`。不得手工编辑生成文件。

每项模型数据在合入前必须根据对应供应商的官方模型/API 文档核验，并记录：

- 精确模型 ID 和是否仍可调用；
- API 协议；
- 文本和图片输入能力；
- reasoning 以及可选 reasoning effort；
- 上下文窗口和最大输出；
- 对 OpenAI Chat Completions 的专有字段需求，例如 `max_tokens`、`max_completion_tokens`、思维链字段和流式 usage；
- 默认 endpoint。Custom 复用时不使用该 endpoint，但内置 Provider 仍需要它。

模型目录是能力声明，错误的高估会导致请求字段不兼容或上下文压缩预算错误。无法从官方资料确认的字段不得猜测；此时先不纳入目录，或在后续有明确降级语义时采用保守配置。

### 4.2 优先补充范围

当前目录已覆盖 OpenAI GPT/o 系列、Anthropic Claude、DeepSeek 和智谱 GLM。第一轮应按已有三种协议补充常用模型，优先顺序如下：

| 优先级 | 系列或平台 | 目标协议 | 目录策略 |
| --- | --- | --- | --- |
| P0 | OpenAI 当前 GPT、Codex、o 系列 | `openai-responses` | 补齐官方仍支持且适合编码的别名/稳定模型 ID；更新已有条目的能力和 token 限制。 |
| P0 | Anthropic Claude Sonnet、Opus、Haiku 当前系列 | `anthropic-messages` | 以 Messages API 的模型 ID 和能力为准。 |
| P0 | DeepSeek Chat / Reasoner 与当前 V 系列 | `openai-chat-completions` | 区分普通聊天和推理模型，核验 DeepSeek 专有 thinking/usage 参数。 |
| P0 | 智谱 GLM 编码与通用系列 | `openai-chat-completions` | 保留 Z.ai 的 `chatCompletionsCompat` 特性，不把它施加给其他兼容网关。 |
| P1 | Qwen 通义千问的编码、推理和通用系列 | `openai-chat-completions` | 仅收录 DashScope OpenAI 兼容 API 已明确支持的模型和字段。 |
| P1 | Kimi / Moonshot 的 K2 与当前通用系列 | `openai-chat-completions` | 按 Moonshot 的兼容 API 文档确认模型 ID、推理和工具调用约束。 |
| P1 | MiniMax 当前文本/推理系列 | `openai-chat-completions` | 仅在其 OpenAI 兼容端点的流式工具调用行为得到验证后收录。 |
| P1 | Mistral、xAI Grok | `openai-chat-completions` | 使用官方 OpenAI-compatible 文档确认，不以第三方网关说明为依据。 |
| P2 | Groq、Together AI、OpenRouter、NVIDIA NIM、硅基流动等聚合或推理平台 | `openai-chat-completions` | 这些平台的模型列表变化频繁，不维护完整镜像；只收录有稳定官方 ID、可验证能力的高频模型，其余交给 Custom 默认模型。 |

Gemini、Bedrock、Azure OpenAI、Ollama、vLLM 原生接口不应为了“常用模型”被错误归入现有目录：只有当它们明确提供并验证了上述三种协议之一时，才可以作为对应兼容端点的条目收录；原生协议支持须单独设计和实现。

### 4.3 目录验收标准

- 每个新增模型通过 `validateModelCatalog`。
- 生成文件与源数据一致。
- `packages/ai/test/models.test.ts` 覆盖新增模型的 API、关键能力和专有兼容字段。
- 对 Chat Completions 模型至少新增或更新一个适配器请求映射测试，确保模型元数据会生成可接受的参数。
- README 的“内建 Provider 和模型”更新为从当前目录可验证的摘要或链接，不能保留已过期的静态列表。

## 5. 交互契约

### 5.1 选择与输入顺序

`Custom` 被选择后，向导按下列顺序推进：

1. 选择协议。选项标签必须同时显示 API 名称和用途：OpenAI Responses、OpenAI Chat Completions、Anthropic Messages。
2. 输入 `baseUrl`。提示文本应说明这是 API 根地址，例如 `https://gateway.example.com/v1`。
3. 输入 `apiKey`。使用现有掩码输入，不回显、不写入状态栏或错误信息。
4. 输入 `modelId`。允许任意非空模型 ID，不能强制用户只从内置目录选择。
5. 规范化配置、保存用户级设置、解析 `StartupRuntime` 并切换当前 session。

每个步骤按 Escape、Ctrl-C 或 Ctrl-D 取消时，整个 onboarding 结束且不写入配置。任何校验失败停留在当前步骤，清楚说明字段错误，同时保留其他尚未提交的内存输入；输入值不写入终端输出。

### 5.2 Base URL 验证

复用现有配置的 URL 规则，提交前在 interactive 边界校验：

- 必须是绝对 `http:` 或 `https:` URL。
- 不允许用户名、密码、query 或 hash，避免凭据进入 URL 或请求语义不确定。
- 不允许尾随 `/`，保证适配器拼接路径的行为一致。
- 允许路径，例如 `/v1`；不探测网络可达性。

校验逻辑应成为 `startup.ts` 可测试的纯函数，onboarding 只调用它并展示错误，避免 UI 和文件配置出现两套 URL 规则。

### 5.3 API key 持久化

现有 onboarding 会在用户级 `~/.di-code/settings.json` 中保存 API key，并以目录 `0700`、文件 `0600` 创建。Custom 沿用同一规则。

Custom API key 是用户在向导中主动输入的本地凭据，保存的格式可为字符串；手写 JSON 的推荐形式仍是 `$ENV_VAR` 引用。实现不得把 key 放进 `DI_CODE_*` 临时环境、session JSONL、TUI 文本、异常消息、测试快照或日志。

## 6. 模型元数据匹配与回退

### 6.1 匹配键和复制边界

查找函数应由 `@di-code/ai` 拥有，因为模型目录也由该包拥有。建议增加一个根入口导出的只读查询函数，其语义为：

```ts
findBuiltinModel(api: ModelApi, modelId: string): Model | undefined
```

它只返回目录中 `api` 与 `id` 同时匹配的模型，且返回副本，调用者不得修改全局 `MODELS`。`modelId` 比较使用精确匹配，不做大小写折叠、前后缀剥离或模糊猜测。

匹配成功时，Custom 模型复制下列能力元数据：

- `name`、`input`、`reasoning`、`reasoningEfforts`；
- `contextWindow`、`maxOutputTokens`、`cost`；
- `chatCompletionsCompat`；
- 必要时的 `cacheRetention` 和 `sessionAffinity`。

以下字段由 Custom 输入决定，绝不从目录复制：

- `provider`：固定为保存的 Custom Provider ID；
- `api`：固定为用户选择的协议；
- `baseUrl`：固定为用户输入的 endpoint；
- `id`：固定为用户输入的 model ID。

这条边界避免将内置模型的原始供应商 endpoint 发给自定义网关，也避免同名模型在不同协议下被误判可用。

### 6.2 协议不匹配

若模型 ID 存在于目录、但只属于其他协议，视为未知 Custom 模型，不尝试跨协议转换。例如 `gpt-4o` 在目录中的协议是 `openai-responses`；用户选择 Chat Completions 时，不能复制它的 Responses 能力定义。可在输入完成后给出不含 API key 的提示：该模型未在所选协议的内置目录中，将使用默认能力参数。

### 6.3 未知模型默认值

未知模型生成的模型定义必须可用且保守：

```ts
{
  id: modelId,
  name: modelId,
  provider: "custom",
  api,
  baseUrl,
  input: ["text"],
  reasoning: false,
  contextWindow: 128_000,
  maxOutputTokens: 16_384,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}
```

若 `api` 是 `openai-chat-completions`，默认不附带 `chatCompletionsCompat`。这意味着不会主动发送供应商特有的思维链或流式 usage 参数，优先保证普通文本和工具调用请求的基础兼容性。用户之后可编辑 `settings.json`，补充真实能力数据。

默认值是请求预算与 UI 功能的保守假设，不是对远端模型能力的承诺。对实际窗口更小的模型，用户可通过自定义 `models` 配置降低值。

## 7. 持久化格式

第一阶段使用一个固定的用户级 Provider ID：`custom`。首次保存产生以下形状；字段顺序不构成 API，但结构必须可被现有 `startup.ts` 解析。

```json
{
  "defaultProvider": "custom",
  "defaultModel": "company-coder",
  "providers": {
    "custom": {
      "name": "Custom",
      "api": "openai-chat-completions",
      "baseUrl": "https://gateway.example.com/v1",
      "apiKey": "user-entered-secret",
      "models": [
        {
          "id": "company-coder",
          "name": "company-coder",
          "input": ["text"],
          "reasoning": false,
          "contextWindow": 128000,
          "maxTokens": 16384
        }
      ]
    }
  }
}
```

第二次选择 Custom 的覆盖策略须明确：同一个固定 ID 会覆盖 `custom` 的 endpoint、密钥和模型数组，并更新默认值。第一阶段不做多 Custom 配置管理；需要多个网关的用户仍可通过手写 settings 声明命名 Provider。未来若增加“保存为新名称”，应作为独立的兼容性设计，不能静默改变 `custom` 的含义。

实现保存 API 应从只保存 key 的 `saveGlobalProviderApiKey` 演进为能原子地保存完整 Custom Provider 的专用函数。该函数负责读-合并-写入、文件权限和默认值；onboarding 不得自行拼接 JSON。

## 8. 代码落点

| 位置 | 改动责任 |
| --- | --- |
| `packages/ai/src/models.ts` | 维护和补充模型源数据。 |
| `packages/ai/src/models.generated.ts` | 由生成器更新，不手改。 |
| `packages/ai/src/models.ts` 或相邻模块 | 增加按 `(api, modelId)` 查询并复制模型元数据的公共函数。 |
| `packages/ai/src/index.ts` | 从包根导出新的模型查询能力。 |
| `packages/coding-agent/src/startup.ts` | URL 规范化、未知模型回退、Custom Provider 保存与运行时解析。 |
| `packages/coding-agent/src/provider-onboarding.ts` | 增加 Custom 选项和四个输入/选择步骤；不拥有配置解析逻辑。 |
| `packages/coding-agent/src/i18n.ts` | 增加中英文 prompt、校验错误和未知模型提示。 |
| `packages/coding-agent/test/provider-onboarding.test.ts` | 验证完整键盘流程、取消、掩码和持久化结果。 |
| `packages/coding-agent/test/startup.test.ts` | 验证 URL、配置加载、已知/未知模型和覆盖策略。 |
| `packages/ai/test/models.test.ts` | 验证扩充目录和精确协议匹配。 |
| `README.md` | 实现完成后更新首次配置向导、Custom 配置和模型目录说明。 |

不改变 `@di-code/agent`、Session JSONL 或 RPC 协议。切换 Provider 继续通过现有 `AgentSession.setRuntime()` 发生，因此 RPC 状态和 Session 使用现有的 provider/model 投影，无需新增记录字段。

## 9. 测试矩阵

至少覆盖下列可观察行为：

| 场景 | 预期结果 |
| --- | --- |
| 选择 Custom 后选择每种协议 | 配置中的 `api` 与选择完全一致。 |
| 合法 Base URL | 保存并创建可解析的运行时 Provider。 |
| 非绝对 URL、非 HTTP(S)、带凭据/query/hash 或尾随 `/` | 留在输入步骤并显示字段错误，不写配置。 |
| 空 API key 或空 model ID | 留在对应输入步骤，不写配置。 |
| 已知 `(api, modelId)` | 写入的模型能力与内置目录一致，但 provider/API/baseUrl 使用 Custom 值。 |
| 同名但协议不匹配 | 写入未知模型保守默认值，不复制其他协议字段。 |
| 目录外 model ID | 写入默认模型，运行时可构造 Provider。 |
| API key 输入 | 终端输出、错误和快照不含明文 key。 |
| 任一步取消 | 返回 `undefined`，不创建或修改用户级 settings。 |
| 已存在 `custom` 配置 | 仅替换该 Provider 并保留其他 Provider、locale 和无关字段。 |
| 新配置重启 | 无 `DI_CODE_PROVIDER` 时使用保存的 `defaultProvider` 和 `defaultModel`。 |

真实网络连通性不作为单元测试前提。用 `faux` 验证 CLI 主链路；各协议适配器以 mock `fetch` 或既有 Provider 测试验证请求映射。若增加真实 smoke test，必须显式由环境变量启用，并在缺失 key 时跳过。

## 10. 实施顺序与验收

1. 根据官方资料扩充模型目录，运行生成器、模型测试和相关 Provider 映射测试。
2. 在 `@di-code/ai` 定义并测试精确协议匹配的只读模型查询函数。
3. 在 `startup.ts` 定义 URL 校验、默认模型工厂与完整 Custom Provider 保存函数，先补失败测试。
4. 在 provider onboarding 中增加 `Custom` 选择、协议选择和字段输入；新增所有键盘流程测试。
5. 更新 README、`.env.example`（仅在有新的环境变量时）和 coding-agent 包 README，使手写配置与向导产生的配置一致。
6. 运行 `npm test --workspace @di-code/ai`、`npm test --workspace @di-code/coding-agent`、`npm run check`、`npm run build`、`git diff --check`。

完成条件是：用户在交互终端无需手写配置即可为一个已支持协议的网关配置并使用 Custom；已知模型保留正确的能力元数据；未知模型在不虚构能力的前提下可工作；凭据不会被回显或写入项目/会话数据。
