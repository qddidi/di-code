# @di-code/plugin-loader

`@di-code/plugin-loader` 校验第三方 namespace plugin、package manifest 和声明式 Composition，并提供 project trust 与受管插件安装。它依赖 `@di-code/plugin-runtime`，但不实现 Agent loop 或产品 CLI。

安装：

```powershell
npm install @di-code/plugin-loader @di-code/plugin-runtime
```

公开 Loader API 接收一个 runtime `Context` 和 entry 列表：

```ts
import { createCompositionLoader } from "@di-code/plugin-loader";
import { createRootContext } from "@di-code/plugin-runtime";

const context = createRootContext({ mode: "test", trustedProject: true });
const loader = createCompositionLoader({
	context,
	entries: [{ id: "status", name: "@acme/di-code-status/plugin", required: false }],
});

try {
	const inventory = await loader.load();
	console.log(inventory.get("status")?.status);
} finally {
	await loader.dispose();
	await context.dispose();
}
```

package entry 必须且只能出现在一个 `package.json.diCode.plugins` 项中，并由 `exports` 声明；解析结果必须留在 package root 内。namespace module 必须有非空 `name` 与 callable `apply`，`apiVersion` 若存在必须为 `1`，`version` 若存在必须是合法标识，`default` export 会被拒绝。

Composition 支持 JSON/YAML、受限 `$VAR`/`${VAR}` 配置插值、deterministic layer merge，以及按 id 的 insert/append/remove/replace/enable/disable/move patch。它不会执行 JavaScript、shell substitution 或命令；disabled entry 不会 import。`topologicallySortEntries()` 拒绝缺失 required dependency 和 cycle。required entry 失败会回滚已激活项；optional entry 失败记录为 `skipped` inventory。

`ProjectTrustStore` 使用 version `1` JSON 保存 project trust；untrusted project-local entry 被 skipped。`PluginInstallManager` 支持 local、`npm:` 与 `git:` source，使用 staging、managed-root 路径检查、原子 registry replacement 和失败 rollback；`npm:` 固定使用 `--ignore-scripts`。in-process plugin 不是 sandbox，manifest permission 只用于审计与 capability policy。registry 暂无跨进程写锁，不要并发运行管理操作。
