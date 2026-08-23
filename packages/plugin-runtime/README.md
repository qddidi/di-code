# @di-code/plugin-runtime

`@di-code/plugin-runtime` 提供可插拔运行时的 Provider-neutral 基元：`Context`、`Fiber`、typed service key、生命周期状态、runtime event、capability view、诊断和 owner-aware contribution registry。它不依赖 `coding-agent`，也不连接 CLI、Provider、文件工具或产品实现。

安装：

```powershell
npm install @di-code/plugin-runtime
```

外部插件通常通过 `@di-code/plugin-sdk` 导入；直接使用本包适合构建宿主或运行时测试。

```ts
import { createRootContext, createServiceKey, type PluginDefinition } from "@di-code/plugin-runtime";

const statusKey = createServiceKey<string>("example.status");
const context = createRootContext({ mode: "test", trustedProject: true });

await context.plugin(
	{
		name: "example.status",
		apply: (ctx) => ctx.set(statusKey, "ready"),
	} satisfies PluginDefinition<undefined>,
	undefined,
);

console.log(context.require(statusKey));
await context.dispose();
```

异步 `apply` 的 service 在 Fiber active 前不可见；apply 失败会回滚其贡献。`Fiber.dispose()` 会 abort signal、等待 in-flight setup、逆序运行 disposer、聚合 cleanup error，并且可重复调用。普通 child Context 继承父 service；`child({ isolate: true })` 不继承，用于 Session 等私有 scope。

`EventBus<E>` 按 priority 降序和稳定注册顺序调度。非 critical handler 失败会被隔离并写入 diagnostic；critical handler 失败会终止 gate 并 reject。`CapabilityView` 要求 trusted project 和 plugin 声明 capability，但不构成 Node.js sandbox。诊断会脱敏 `token`、`secret`、`authorization` 和 `api_key` 文本。

`ContributionRegistry` 及 provider、tool、command、session、renderer、RPC 和 resource contribution contract 会将注册所有权绑定到 Fiber；重复、保留和跨 kind namespace 冲突会失败。只使用 package 根入口，不导入 `src` 或 `dist` 私有路径。
