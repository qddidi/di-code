// Keep the release order in one place so version preparation and publication
// cannot drift apart as new workspace packages are added.
export const releasePackages = [
	{ directory: "plugin-runtime", name: "@di-code/plugin-runtime" },
	{ directory: "plugin-loader", name: "@di-code/plugin-loader" },
	{ directory: "plugin-sdk", name: "@di-code/plugin-sdk" },
	{ directory: "plan-mode", name: "@di-code/plan-mode" },
	{ directory: "ai", name: "@di-code/ai" },
	{ directory: "agent", name: "@di-code/agent" },
	{ directory: "skills", name: "@di-code/skills" },
	{ directory: "builtins", name: "@di-code/builtins" },
	{ directory: "tui", name: "@di-code/tui" },
	{ directory: "mcp", name: "@di-code/mcp" },
	{ directory: "coding-agent", name: "@di-code/coding-agent" },
	{ directory: "orchestrator", name: "@di-code/orchestrator" },
];

export const releaseWorkspaceDirectories = releasePackages.map(({ directory }) => directory);
export const releaseWorkspaces = releasePackages.map(({ name }) => name);

// Private workspaces still need matching versions and lockfile entries, but
// are intentionally excluded from npm publication.
export const versionWorkspaceDirectories = [...releaseWorkspaceDirectories, "web"];
