# @di-code/plugin-sdk

`@di-code/plugin-sdk` 是第三方 `di-code` namespace plugin 的稳定公开入口。它只重导出 `@di-code/plugin-runtime` 与 `@di-code/plugin-loader` 的根 API；插件不得导入任何包的 `src`、`dist` 或未声明 subpath。

```powershell
npm install @di-code/plugin-sdk
```

```ts
import { createServiceKey, type PluginDefinition } from "@di-code/plugin-sdk";

export const greetingKey = createServiceKey<string>("acme.greeting");
export const apiVersion = 1 as const;
export const name = "acme.greeting";
export const version = "1.0.0";
export const apply: PluginDefinition["apply"] = (context) => {
	context.set(greetingKey, "hello");
};
```

发布 package 必须以 ESM `exports` 声明该 entry，并在 `package.json.diCode.plugins` 中只列出它。Loader 拒绝 default export、缺失的 `name`/`apply`、不兼容 API version 和 package root 外的 export target。完整 manifest、Composition、trust、capability 和 lifecycle 规则见仓库 [`docs/插件使用指南.md`](../../docs/插件使用指南.md)。

Web UI 扩展使用 `WebManifest`、`WebContribution` 和 `WebSlotId`。贡献通过宿主 `WebSlotRegistry` 按 owner 管理，`dispose` 幂等；`componentKey` 是宿主白名单键，不是 URL、HTML 或 JavaScript。插件只能提供声明式只读数据，所需 capability 和 Workspace trust 由宿主检查。
