export type RuntimeProfileName = "terminal" | "headless";

export interface RuntimeProfile {
	readonly name: RuntimeProfileName;
	readonly mode: "interactive" | "print" | "json";
	readonly frontend: string;
	readonly pluginIds: readonly string[];
}

export interface RuntimeProfileOverrides {
	readonly user?: Partial<Pick<RuntimeProfile, "pluginIds" | "frontend">>;
	readonly project?: Partial<Pick<RuntimeProfile, "pluginIds" | "frontend">>;
	readonly cli?: Partial<Pick<RuntimeProfile, "pluginIds" | "frontend">>;
}

const BASE_PROFILES: Readonly<Record<RuntimeProfileName, RuntimeProfile>> = {
	terminal: { name: "terminal", mode: "interactive", frontend: "builtin", pluginIds: [] },
	headless: { name: "headless", mode: "print", frontend: "headless", pluginIds: [] },
};

export function resolveRuntimeProfile(
	name: string | undefined,
	overrides: RuntimeProfileOverrides = {},
	mode?: RuntimeProfile["mode"],
): RuntimeProfile {
	const selected = (name ?? "terminal") as RuntimeProfileName;
	const base = BASE_PROFILES[selected];
	if (!base) throw new Error(`Unknown runtime profile "${name}".`);
	const merged: { pluginIds: readonly string[]; frontend: RuntimeProfile["frontend"] } = {
		pluginIds: [...base.pluginIds],
		frontend: base.frontend,
	};
	for (const value of [overrides.user, overrides.project, overrides.cli]) {
		if (value?.pluginIds !== undefined) merged.pluginIds = [...value.pluginIds];
		if (value?.frontend !== undefined) merged.frontend = value.frontend;
	}
	const pluginIds = [...(merged.pluginIds ?? [])];
	if (new Set(pluginIds).size !== pluginIds.length) throw new Error("Runtime profile contains duplicate plugin IDs.");
	if (mode !== undefined && selected === "headless" && mode === "interactive")
		throw new Error('The "headless" profile cannot use interactive mode.');
	if (mode !== undefined && selected === "terminal" && mode !== "interactive")
		throw new Error('The "terminal" profile requires interactive mode.');
	if (selected === "headless" && merged.frontend !== "headless")
		throw new Error('The "headless" profile cannot select an interactive frontend.');
	return { name: selected, mode: mode ?? base.mode, frontend: merged.frontend, pluginIds };
}

export function listRuntimeProfiles(): readonly RuntimeProfile[] {
	return Object.values(BASE_PROFILES).map((profile) => ({ ...profile, pluginIds: [...profile.pluginIds] }));
}
