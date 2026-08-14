import { createFauxProvider, createOpenAIProvider, type FauxResponse, type Model, type Provider } from "@di-code/ai";

export interface StartupRuntime {
	readonly provider: Provider;
	readonly model: Model;
}

const FAUX_RESPONSES: readonly FauxResponse[] = [
	{ type: "success", content: [{ type: "text", text: "Faux response." }] },
];

export function resolveStartupArgs(args: readonly string[]): readonly string[] {
	return args.length === 0 ? ["--interactive"] : args;
}

function requireOpenAIModel(env: Readonly<Record<string, string | undefined>>): string {
	const model = env.OPENAI_MODEL?.trim();
	if (!model) throw new Error("OPENAI_MODEL is required when DI_CODE_PROVIDER=openai");
	return model;
}

function createOpenAIRuntime(env: Readonly<Record<string, string | undefined>>): StartupRuntime {
	const modelId = requireOpenAIModel(env);
	const provider = createOpenAIProvider({ env });
	const model = provider.models.find((candidate) => candidate.id === modelId);
	if (!model) {
		const availableModels = provider.models.map((candidate) => candidate.id).join(", ");
		throw new Error(`Unknown OpenAI model "${modelId}". Available models: ${availableModels}.`);
	}
	return { provider, model };
}

function createFauxRuntime(): StartupRuntime {
	const faux = createFauxProvider({ responses: FAUX_RESPONSES });
	return { provider: faux.provider, model: faux.model };
}

export function resolveStartupRuntime(env: Readonly<Record<string, string | undefined>>): StartupRuntime {
	const provider = env.DI_CODE_PROVIDER?.trim() || "openai";
	if (provider === "openai") return createOpenAIRuntime(env);
	if (provider === "faux") return createFauxRuntime();
	throw new Error(`Unsupported DI_CODE_PROVIDER "${provider}". Expected openai or faux.`);
}
