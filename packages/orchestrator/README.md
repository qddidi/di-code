# @di-code/orchestrator

用于监管 `di-code-rpc` 子进程的 supervisor（进程监管器）。它是 [di-code](https://github.com/qddidi/di-code) 的一部分，只通过公开的 `@di-code/coding-agent/rpc` 协议通信。

组合运行时可以把 `orchestratorHost` 作为 namespace entry 装配，但它仍只依赖公开 RPC SDK，绝不导入 coding-agent、Loader 或 builtins 的私有实现。

当 Node.js 应用需要启动 Agent 子进程、等待就绪握手、提交 prompt、消费流式事件、带超时停止进程或检测崩溃时使用此包。它不是交互式 CLI。

## 安装

```powershell
npm install @di-code/orchestrator @di-code/coding-agent
```

要求 Node.js `>= 22.19.0`。`@di-code/coding-agent` 提供 `di-code-rpc` 可执行命令。

## 快速开始

先全局安装 `@di-code/coding-agent`，或让宿主应用能够在 `PATH` 中找到 `di-code-rpc`，然后通过 `RpcSupervisor` 启动：

```ts
import { RpcSupervisor } from "@di-code/orchestrator";

const supervisor = new RpcSupervisor({
	command: process.platform === "win32" ? "di-code-rpc.cmd" : "di-code-rpc",
	cwd: process.cwd(),
	env: { DI_CODE_PROVIDER: "openai", OPENAI_API_KEY: process.env.OPENAI_API_KEY },
});

supervisor.subscribe((state) => console.log(`agent is ${state}`));
const session = await supervisor.start();
console.log(`ready: ${session.providerId} / ${session.modelId}`);
const unsubscribe = supervisor.subscribeEvents((record) => console.log(record.requestId, record.event.type));
const answer = await supervisor.prompt("总结这个项目");
console.log(answer.stopReason);
unsubscribe();
await supervisor.stop();
```

运行中的 supervisor 还转发公开 SDK 的 `cancel()`、`getOperation()`、`negotiate()`、`resumeEvents()`、Session
列表/创建/打开、Product/项目 trust 快照和 `createAttachment()`。这些方法的参数和结果来自
`@di-code/coding-agent/rpc`，不会暴露或接受 coding-agent 的 `SessionHost`、`SessionManager` 或其他内部对象。
附件只保存在子进程内存并由命名 prompt/steer 一次性消费。宿主应先协商 sequence 事件，并在恢复要求快照时重新读取状态，不能
假定事件会被永久保存。

Windows 下 npm 安装的可执行 shim（命令包装器）是 `di-code-rpc.cmd`。如果宿主程序使用其他运行时位置，请传入绝对路径。

组合运行时时，可从根入口使用 `orchestratorHost` 和 `orchestratorHostKey` 创建 `RpcSupervisor`。host 只封装公开 RPC SDK，不会导入 coding-agent 的内部实现。

## 配置

`RpcSupervisor` 会把 `cwd` 和 `env` 传给子进程。子进程配置与 `di-code` CLI 相同：OpenAI 使用 `DI_CODE_PROVIDER=openai` 和 `OPENAI_API_KEY`；DeepSeek 使用 `DI_CODE_PROVIDER=deepseek` 和 `DEEPSEEK_API_KEY`；自定义网关使用 `cwd` 下的 `.di-code/settings.json`。`apiKey` 应引用环境变量，不能写入真实凭据。

不要记录传入的 `env` 对象。supervisor 最多保留子进程 stderr 的最后 16 KiB。它不会自动重启崩溃进程，也不会重放请求，以免重复执行工具副作用。子进程退出会将状态设为 `crashed` 并以 `PROCESS_EXIT` 拒绝全部 pending request；`stop()` 可重复调用且共享同一关闭过程。

## 生命周期和取消

状态可能为 `idle`、`starting`、`running`、`stopping`、`stopped` 或 `crashed`。`start()` 完成 `get_state` RPC 握手后才会 resolve。给 `prompt()` 传入 `{ signal }` 可取消请求。`stop()` 先发送 `SIGTERM`，超过 `stopTimeoutMs` 后升级为 `SIGKILL`，默认超时五秒。

源码、示例和问题反馈：<https://github.com/qddidi/di-code>
