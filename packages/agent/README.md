# @di-code/agent

为 [di-code](https://github.com/qddidi/di-code) 提供 Provider 无关的 Agent Loop（代理循环）和对话状态管理。它消费 `@di-code/ai` 的契约，按稳定顺序发布 `AgentEvent`，并可执行经过校验的工具。

这是一个库，不是可执行程序。想直接运行 CLI，请使用 `@di-code/coding-agent`。

## 安装

```powershell
npm install @di-code/agent @di-code/ai
```

要求 Node.js `>= 22.19.0`。

## 快速开始

下面使用 faux provider，整个示例离线且结果确定。

```ts
import { createFauxProvider } from "@di-code/ai";
import { Agent } from "@di-code/agent";
const faux = createFauxProvider({ responses: [{ type: "success", content: [{ type: "text", text: "Hello from di-code." }] }] });
const agent = new Agent({ provider: faux.provider, model: faux.model });
agent.subscribe((event) => {
	if (event.type === "message_update" && event.event.type === "text_delta") process.stdout.write(event.event.delta);
});
const response = await agent.prompt("Say hello");
console.log(`\nStopped: ${response.stopReason}`);
```

`Agent` 会串行处理 prompt。流式处理期间再次提交 prompt 会被拒绝，以保证对话历史顺序确定。调用 `agent.prompt()` 时传入第二个参数 `AbortSignal` 可以取消请求。

## 配置

`@di-code/agent` 没有环境变量和配置文件。请在构造函数中传入 `provider` 和 `model`。使用 OpenAI 或 DeepSeek 时，通过 `@di-code/ai` 创建 Provider，并在构造参数或对应环境变量中提供 API key。

工具使用 `AgentTool` 对象注册。每个工具声明 TypeBox 参数 Schema，以及 `execute(toolCallId, parameters, signal)` 函数。Agent 会在执行前校验参数，并把工具结果追加到下一次模型请求。

需要运行时贡献工具或 system prompt 时，可传入 `AgentContextProvider`。Agent 会在每次 Provider 请求开始前调用 `resolve(signal)`，并把返回的 `AgentRequestContext`（包括 `tools` 和可选的 `toolMiddleware`）复制为该请求的不可变快照；工具结果进入下一轮后才会重新解析。middleware 按注册顺序包裹已通过 schema 校验的工具执行，异常会转换为标准的工具错误结果，并始终发出对应的 `tool_execution_end`。未知工具或 schema 校验失败不会进入 middleware 链。middleware 不能启动新的 Provider 请求或递归调用 `Agent.prompt()`。

## 公共 API

主要导出 `Agent`、`agentLoop`、Agent 事件和工具类型，以及上下文压缩辅助函数。终端 UI、本地文件、Shell 命令、配置文件和会话持久化属于 `@di-code/coding-agent`。

源码、示例和问题反馈：<https://github.com/qddidi/di-code>
