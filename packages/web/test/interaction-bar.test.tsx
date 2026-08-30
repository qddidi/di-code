import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { InteractionBar } from "../src/components/InteractionBar.tsx";

describe("InteractionBar", () => {
	it("renders a pending plan review with the complete Markdown plan", () => {
		const html = renderToStaticMarkup(
			<InteractionBar
				interactions={[
					{
						requestId: "plan-review",
						kind: "choice",
						prompt: "Approve this plan and leave plan mode?",
						options: [
							{ value: "approve", label: "Approve" },
							{ value: "keep", label: "Keep planning" },
						],
						questions: [{ id: "plan", prompt: "# Ship it\n\n1. Add a regression test." }],
					},
				]}
				onRespond={vi.fn(async () => undefined)}
			/>,
		);

		expect(html).toContain("Approve this plan and leave plan mode?");
		expect(html).toContain('role="dialog"');
		expect(html).toContain("interaction-overlay");
		expect(html).toContain("<h1>Ship it</h1>");
		expect(html).toContain("Approve");
		expect(html).toContain("Keep planning");
	});
});
