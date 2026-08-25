import { resolve } from "node:path";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
	const environment = loadEnv(mode, process.cwd(), "DI_CODE_WEB_");
	const backend = environment.DI_CODE_WEB_DEV_BACKEND;
	const developmentOrigin = environment.DI_CODE_WEB_DEV_ORIGIN;
	return {
		plugins: [react()],
		build: {
			outDir: resolve(import.meta.dirname, "../coding-agent/dist/web"),
			emptyOutDir: true,
			sourcemap: true,
		},
		server: backend
			? {
					proxy: {
						"/api": {
							target: backend,
							changeOrigin: true,
							...(developmentOrigin ? { headers: { origin: developmentOrigin } } : {}),
						},
						"/healthz": {
							target: backend,
							changeOrigin: true,
							...(developmentOrigin ? { headers: { origin: developmentOrigin } } : {}),
						},
					},
				}
			: undefined,
	};
});
