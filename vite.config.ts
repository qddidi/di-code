import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: [
			{ find: /^@di-code\/ai$/, replacement: fileURLToPath(new URL("./packages/ai/src/index.ts", import.meta.url)) },
			{
				find: /^@di-code\/agent$/,
				replacement: fileURLToPath(new URL("./packages/agent/src/index.ts", import.meta.url)),
			},
			{
				find: /^@di-code\/builtins$/,
				replacement: fileURLToPath(new URL("./packages/builtins/src/index.ts", import.meta.url)),
			},
			{
				find: /^@di-code\/plugin-runtime$/,
				replacement: fileURLToPath(new URL("./packages/plugin-runtime/src/index.ts", import.meta.url)),
			},
			{
				find: /^@di-code\/plugin-loader$/,
				replacement: fileURLToPath(new URL("./packages/plugin-loader/src/index.ts", import.meta.url)),
			},
			{
				find: /^@di-code\/plugin-sdk$/,
				replacement: fileURLToPath(new URL("./packages/plugin-sdk/src/index.ts", import.meta.url)),
			},
			{
				find: /^@di-code\/skills$/,
				replacement: fileURLToPath(new URL("./packages/skills/src/index.ts", import.meta.url)),
			},
			{ find: /^@di-code\/mcp$/, replacement: fileURLToPath(new URL("./packages/mcp/src/index.ts", import.meta.url)) },
			{ find: /^@di-code\/tui$/, replacement: fileURLToPath(new URL("./packages/tui/src/index.ts", import.meta.url)) },
		],
	},
	test: {
		include: ["**/*.{test,e2e}.?(c|m)[jt]s?(x)"],
	},
});
