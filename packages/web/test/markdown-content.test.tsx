import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownContent } from "../src/components/MarkdownContent.tsx";

describe("MarkdownContent", () => {
	it("renders GitHub-flavored Markdown as semantic elements", () => {
		const html = renderToStaticMarkup(<MarkdownContent>{"# Heading\n\n**bold** and `code`\n\n- [x] done\n\n| Name | Value |\n| --- | --- |\n| one | two |"}</MarkdownContent>);
		expect(html).toContain("<h1>Heading</h1>");
		expect(html).toContain("<strong>bold</strong>");
		expect(html).toContain("<code>code</code>");
		expect(html).toContain('type="checkbox" disabled="" checked=""');
		expect(html).toContain("<table>");
	});

	it("does not execute embedded HTML or unsafe links", () => {
		const html = renderToStaticMarkup(<MarkdownContent>{"<script>alert(1)</script>\n\n[relative](docs/guide.md)\n\n[bad](javascript:alert(1))"}</MarkdownContent>);
		expect(html).not.toContain("<script>");
		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
		expect(html).toContain('href="docs/guide.md"');
		expect(html).not.toContain("javascript:");
	});
});
