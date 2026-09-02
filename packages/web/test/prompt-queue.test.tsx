import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PromptQueue } from "../src/components/PromptQueue.tsx";

describe("PromptQueue", () => {
	it("shows queued messages and steering items while a response is active", () => {
		const html = renderToStaticMarkup(<PromptQueue busy queuedPrompts={["second request"]} steeringPrompts={["focus on tests"]} />);
		expect(html).toContain("Queued messages");
		expect(html).toContain("second request");
		expect(html).toContain("Steering");
		expect(html).toContain("focus on tests");
	});

	it("keeps the steering surface visible while idle queue is empty", () => {
		const html = renderToStaticMarkup(<PromptQueue busy queuedPrompts={[]} steeringPrompts={[]} />);
		expect(html).toContain("Use Alt+S to guide the active response.");
	});
});
