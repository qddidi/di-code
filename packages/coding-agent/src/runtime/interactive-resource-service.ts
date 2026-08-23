import { createServiceKey } from "@di-code/plugin-runtime";
import type { ResourceLoaderOptions, ResourceSnapshot } from "../core/resources/types.ts";

export interface InteractiveResourceSnapshot {
	readonly resources: ResourceSnapshot;
	readonly systemPrompt: string;
}

/** Loads interactive resources and composes the prompt from registry-owned sections. */
export interface InteractiveResourceService {
	readonly load: (options: ResourceLoaderOptions) => Promise<InteractiveResourceSnapshot>;
}

export const interactiveResourceServiceKey = createServiceKey<InteractiveResourceService>("interactive-resources");
