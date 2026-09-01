import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Toast } from "../src/components/Toast.tsx";

describe("Toast", () => {
	it("renders an accessible dismissible error notification", () => {
		const html = renderToStaticMarkup(<Toast message="Unable to delete the session." onClose={() => undefined} />);
		expect(html).toContain('role="alert"');
		expect(html).toContain("Unable to delete the session.");
		expect(html).toContain('aria-label="Dismiss notification"');
	});

	it("renders nothing without a message", () => {
		expect(renderToStaticMarkup(<Toast onClose={() => undefined} />)).toBe("");
	});
});
