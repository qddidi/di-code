import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createWebSlotHost, WebSlot } from "../src/web-slots.tsx";

describe("declarative extension surfaces", () => {
	it("renders only allowlisted review and badge component keys", () => {
		const host = createWebSlotHost({
			protocolVersion: 1,
			contributions: [
				{ id: "badge", slot: "session.badge", version: 1, componentKey: "builtin.extension-badge", data: { label: "Plan active" } },
				{ id: "review", slot: "review.panel", version: 1, componentKey: "builtin.review-panel", data: { label: "Review" } },
				{ id: "unsafe", slot: "review.panel", version: 1, componentKey: "evil.html", data: { html: "<script>" } },
			],
		}, { openSettings: () => undefined, focusSession: () => undefined });
		const html = renderToStaticMarkup(<><WebSlot host={host} slot="session.badge" context={{}} actions={{ openSettings: () => undefined, focusSession: () => undefined }} signal={new AbortController().signal} /><WebSlot host={host} slot="review.panel" context={{}} actions={{ openSettings: () => undefined, focusSession: () => undefined }} signal={new AbortController().signal} /></>);
		expect(html).toContain("Plan active");
		expect(html).toContain("Review");
		expect(html).not.toContain("script");
		host.dispose();
	});
});
