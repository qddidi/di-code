# @di-code/ai

为 [di-code](https://github.com/qddidi/di-code) 提供与 Provider 无关的 TypeScript AI 契约、流式事件、模型目录，以及 OpenAI、Anthropic、DeepSeek、Kimi 和智谱 API 适配器。

这是一个库，不提供命令行程序。想直接使用 AI 编码 CLI，请安装 `@di-code/coding-agent`。

## 安装

```powershell
npm install @di-code/ai
```

要求 Node.js `>= 22.19.0`。

## 使用 Provider

创建 Provider，选择模型，然后消费类型安全的流式事件。这个包不会读写文件，也不会执行工具。

```ts
import { createOpenAIProvider } from "@di-code/ai";
const provider = createOpenAIProvider({ apiKey: process.env.OPENAI_API_KEY });
const model = provider.models[0];
if (!model) throw new Error("No OpenAI model is configured");
const stream = provider.stream(model, { messages: [], systemPrompt: "Answer concisely." });
for await (const event of stream) {
	if (event.type === "text_delta") process.stdout.write(event.delta);
}
```

需要工具执行和完整对话历史时，请配合 [`@di-code/agent`](https://www.npmjs.com/package/@di-code/agent)。

## 配置

可以显式传入凭据，也可以在 Node.js 进程启动前设置环境变量。不要提交 API key。

```powershell
$env:OPENAI_API_KEY = "your-openai-api-key"
$env:OPENAI_BASE_URL = "https://api.openai.com/v1" # 可选
```

DeepSeek 使用 `DEEPSEEK_API_KEY` 和可选的 `DEEPSEEK_BASE_URL`，默认 endpoint 是 `https://api.deepseek.com`。Kimi 使用 `KIMI_API_KEY` 和可选的 `KIMI_BASE_URL`，默认 endpoint 是 `https://api.kimi.com/coding/v1`。OpenAI 使用 `OPENAI_API_KEY` 和可选的 `OPENAI_BASE_URL`。

Anthropic 使用 `ANTHROPIC_API_KEY` 和可选的 `ANTHROPIC_BASE_URL`，默认 endpoint 是 `https://api.anthropic.com`。`createAnthropicProvider` 使用 Anthropic Messages API，支持文本、Base64 图片、工具调用、工具结果、usage、取消和临时 HTTP 错误重试；扩展思考不会在请求中主动启用。

确定性离线测试请使用 `createFauxProvider({ responses: [...] })`，它不会访问网络。

## 公共 API

主要导出 `Provider`、`Model`、`Message`、`StreamEvent`、`ToolDefinition`、TypeBox 工具、`MODELS`，以及各内建 Provider 创建函数，包括 `createKimiProvider`。

源码、示例和问题反馈：<https://github.com/qddidi/di-code>
