import type { PromptSectionContext, PromptSectionRegistration, PromptSectionRegistry } from "./types.ts";

export function createPromptSectionRegistry(): PromptSectionRegistry {
	const sections = new Map<string, PromptSectionRegistration>();
	return {
		register(section) {
			if (!/^[a-z0-9][a-z0-9._:-]*$/.test(section.name)) throw new TypeError("Invalid prompt section name.");
			if (section.owner.trim().length === 0) throw new TypeError("Prompt section owner must not be empty.");
			if (!Number.isFinite(section.order)) throw new TypeError("Prompt section order must be finite.");
			if (sections.has(section.name)) throw new Error(`Duplicate prompt section: ${section.name}`);
			sections.set(section.name, section);
			let active = true;
			return () => {
				if (!active) return;
				active = false;
				if (sections.get(section.name) === section) sections.delete(section.name);
			};
		},
		snapshot: () => Object.freeze([...sections.values()]),
	};
}

function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted) throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

/** Evaluates a stable snapshot; registration order breaks equal order/name ties. */
export async function assemblePromptSections(
	sections: readonly PromptSectionRegistration[],
	legacySystemPrompt: string | undefined,
	context: PromptSectionContext,
): Promise<string | undefined> {
	throwIfAborted(context.signal);
	const seen = new Set<string>();
	const ordered = sections.map((section, index) => ({ section, index }));
	for (const { section } of ordered) {
		if (seen.has(section.name)) throw new Error(`Duplicate prompt section: ${section.name}`);
		seen.add(section.name);
	}
	ordered.sort((left, right) => left.section.order - right.section.order || left.index - right.index);
	const output: string[] = [];
	if (legacySystemPrompt !== undefined && legacySystemPrompt.trim().length > 0)
		output.push(structuredClone(legacySystemPrompt));
	for (const { section } of ordered) {
		throwIfAborted(context.signal);
		const generated = await section.generate({ ...structuredClone(context), signal: context.signal });
		throwIfAborted(context.signal);
		if (generated === undefined || generated.trim().length === 0) continue;
		output.push(structuredClone(generated));
	}
	return output.length > 0 ? output.join("\n\n") : undefined;
}
