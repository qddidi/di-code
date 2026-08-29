/** Presentation-only interaction surface; hosts provide the actual channel. */
export interface TuiInteractionFacade {
	readonly request: (
		input: {
			readonly requestId?: string;
			readonly kind: "question" | "questions" | "choice" | "approval";
			readonly prompt: string;
			readonly options?: readonly { readonly value: string; readonly label: string }[];
			readonly questions?: readonly { readonly id: string; readonly prompt: string }[];
		},
		signal?: AbortSignal,
	) => Promise<{
		readonly status: "answered" | "cancelled" | "timeout" | "unavailable" | "disposed";
		readonly value?: string;
		readonly values?: Readonly<Record<string, string>>;
		readonly approved?: boolean;
	}>;
}
