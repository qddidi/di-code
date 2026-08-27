import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ToolCard } from "../src/components/ToolCard.tsx";

describe("ToolCard images", () => {
	it("renders images returned by a tool", () => {
		const html = renderToStaticMarkup(
			<ToolCard
				tool={{
					id: "screenshot",
					name: "browser_take_screenshot",
					arguments: {},
					status: "success",
					images: [{ src: "data:image/png;base64,iVBORw0KGgo=", mimeType: "image/png", alt: "Tool image" }],
				}}
			/>,
		);
		expect(html).toContain('class="tool-images"');
		expect(html).toContain('src="data:image/png;base64,iVBORw0KGgo="');
	});
});
