import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: {
			"@di-code/builtins": fileURLToPath(new URL("./packages/builtins/src/index.ts", import.meta.url)),
		},
	},
});
