# @di-code/agent

为 [di-code](https://github.com/qddidi/di-code) 提供 Provider 无关的 Agent Loop（代理循环）和对话状态管理。它消费 `@di-code/ai` 的契约，按稳定顺序发布 `AgentEvent`，并可执行经过校验的工具。

在可插拔运行时中，`@di-code/builtins/agent-loop` 将本包连接到 Provider、Tool 与 Session registry；本包本身不解析 plugin、Composition 或产品配置，也不提供第二套循环。

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

可通过 `hooks` 或 `agent.addHook()` 注册版本化生命周期 hook。hook 按注册顺序串行运行，阶段包括 `request_prepare`、`pre_step`、`request_accept`、`tool_execute_before`、`step_complete`、`turn_complete`、`failed` 和 `cancelled`。观察型 hook（`kind: "observer"`）不能修改请求；修改型 hook（`kind: "modifier"`）只能在 `pre_step` 返回新的 `assembly` 或明确的 `skip`/`abort` decision。每个 hook 都收到 `AbortSignal`，可设置 `timeoutMs` 和 `onError: "ignore" | "fail"`；返回的 disposer 可重复调用。hook 运行在现有单一 Agent loop 内，不改变工具执行顺序。

Agent 也支持 `PromptSectionRegistry`。section 必须声明唯一的 `name`、有限的 `order` 和非空的 `owner`，并在每次 Provider request 组装前调用 `generate`。同一 `order` 按注册顺序排列，空文本跳过，重复名称拒绝；生成异常或取消会令当前请求以错误/中止结果收敛。旧 `systemPrompt` 始终作为最低层前缀，所有生成文本都会深复制后再交给 Provider。Session 宿主应在 `getPromptSnapshot` 中返回当前快照，插件卸载时调用注册返回的 disposer。

## 配置

`@di-code/agent` 没有环境变量和配置文件。请在构造函数中传入 `provider` 和 `model`。使用 OpenAI 或 DeepSeek 时，通过 `@di-code/ai` 创建 Provider，并在构造参数或对应环境变量中提供 API key。

工具使用 `AgentTool` 对象注册。每个工具声明 TypeBox 参数 Schema，以及 `execute(toolCallId, parameters, signal)` 函数。Agent 会在执行前校验参数，并把工具结果追加到下一次模型请求。

工具授权由宿主在 `execute` 边界执行；policy 拒绝不会改变 catalog，且错误结果保留结构化 `details.code`。Agent 仍按参数校验、policy、approval、工具执行、output 的固定顺序处理每个 tool call。

## 公共 API

主要导出 `Agent`、`agentLoop`、Agent 事件和工具类型，以及上下文压缩辅助函数。终端 UI、本地文件、Shell 命令、配置文件和会话持久化属于 `@di-code/coding-agent`。

源码、示例和问题反馈：<https://github.com/qddidi/di-code>
