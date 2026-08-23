import { promptRegistryKey, resourceRegistryKey } from "@di-code/builtins";
import type { PluginDefinition } from "@di-code/plugin-runtime";
import { loadResources } from "./core/resources/loader.ts";
import type { ResourceSnapshot } from "./core/resources/types.ts";
import { buildSystemPrompt } from "./core/system-prompt.ts";
import { interactiveResourceServiceKey } from "./runtime/interactive-resource-service.ts";

interface PromptInput extends ResourceSnapshot {
	readonly cwd: string;
}

function isPromptInput(value: unknown): value is PromptInput {
	return (
		typeof value === "object" &&
		value !== null &&
		"cwd" in value &&
		typeof value.cwd === "string" &&
		"contextFiles" in value &&
		Array.isArray(value.contextFiles) &&
		"skills" in value &&
		Array.isArray(value.skills)
	);
}

/** Provides resource discovery and the default prompt as replaceable registry contributions. */
export const apiVersion = 1 as const;
export const name = "interactive-resources";
export const version = "0.1.7";
export const apply: PluginDefinition["apply"] = (context, _config, fiber) => {
	const prompts = context.require(promptRegistryKey);
	const resources = context.require(resourceRegistryKey);
	fiber.addDisposer(
		prompts.register("interactive-default", (input) => {
			if (!isPromptInput(input)) throw new TypeError("Interactive prompt input is invalid");
			return buildSystemPrompt(input);
		}),
	);
	const service = {
		load: async (options: Parameters<typeof loadResources>[0]) => {
			const snapshot = await loadResources(options);
			const sections = await Promise.all(
				prompts.snapshot().map(async (entry) => await entry.get({ cwd: options.cwd, ...snapshot })),
			);
			return {
				resources: snapshot,
				systemPrompt: sections
					.filter((section): section is string => typeof section === "string" && section.length > 0)
					.join("\n\n"),
			};
		},
	};
	context.set(interactiveResourceServiceKey, service);
	fiber.addDisposer(resources.register("interactive-resources", service));
};
