# @di-code/plugin-loader

`@di-code/plugin-loader` 校验第三方插件 package manifest、默认 `setup(api)`/兼容 namespace entry 和声明式 Composition，并提供 project trust 与受管插件安装。它依赖 `@di-code/plugin-runtime`，但不实现 Agent loop 或产品 CLI。

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

推荐 package 只声明标准 `exports["."]`；旧版 `package.json.diCode.plugins` 仍可读取。解析结果必须留在 package root 内。入口可以是默认 `setup(api)` 函数，也可以是兼容的 namespace `name`/`apply` 导出。`permissions`/`capabilities` 为可选审计信息，不参与 Node.js 权限拦截。

Composition 支持 JSON/YAML、受限 `$VAR`/`${VAR}` 配置插值、deterministic layer merge，以及按 id 的 insert/append/remove/replace/enable/disable/move patch。它不会执行 JavaScript、shell substitution 或命令；disabled entry 不会 import。`topologicallySortEntries()` 拒绝缺失 required dependency 和 cycle。required entry 失败会回滚已激活项；optional entry 失败记录为 `skipped` inventory。

`ProjectTrustStore` 使用 version `1` JSON 保存 project trust，并可记录来源、版本和完整性元数据；untrusted project-local entry 被 skipped。`PluginInstallManager` 支持 local、`npm:` 与 `git:` source，使用 staging、managed-root 路径检查、原子 registry replacement 和失败 rollback；`npm:` 固定使用 `--ignore-scripts`。mutating registry 操作使用跨进程目录锁，等待超时会失败，超过陈旧期限的遗留锁会回收。in-process plugin 不是 sandbox，manifest permission/capability 只用于审计和发现。

插件可在 `diCode.web` 声明 version `1` 的数据贡献。贡献只包含稳定 `slot`、`order`、`capability` 和宿主拥有的 `componentKey`，浏览器不会导入插件包或获得 command registry。当前 ProductHost 只把内置贡献和已启用的受管插件贡献聚合到 Web manifest；未信任 Workspace 或项目 `.di-code/plugins` 的 Web 声明不会进入 Web manifest，旧客户端可忽略未知 slot。受管 bundle 必须声明包内相对 `path`、SHA-256 和包含 `default-src 'self'` 的 CSP；安装时由 Loader 校验 hash。
