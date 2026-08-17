import hljs from "highlight.js";

type Color = "36" | "33" | "35" | "32" | "90";

const ENTITY_MAP: Record<string, string> = {
	"&amp;": "&",
	"&lt;": "<",
	"&gt;": ">",
	"&quot;": '"',
	"&#x27;": "'",
};

function decodeHtml(value: string): string {
	return value.replace(/&(?:amp|lt|gt|quot|#x27);/g, (entity) => ENTITY_MAP[entity] ?? entity);
}

function colorFor(scope: string): Color | undefined {
	if (scope.startsWith("keyword") || scope.startsWith("built_in")) return "36";
	if (scope.startsWith("string") || scope.startsWith("number") || scope.startsWith("literal")) return "33";
	if (scope.startsWith("title") || scope.startsWith("function") || scope.startsWith("type")) return "35";
	if (scope.startsWith("comment")) return "90";
	if (scope.startsWith("attr") || scope.startsWith("variable")) return "32";
	return undefined;
}

function renderHtml(html: string): string {
	const parts = html.split(/(<span class="hljs-[^"]+">|<\/span>)/g);
	const colors: Color[] = [];
	return parts
		.map((part) => {
			if (part === "</span>") {
				colors.pop();
				return "\x1b[0m";
			}
			const match = /^<span class="hljs-([^"]+)">$/.exec(part);
			if (match) {
				const color = colorFor(match[1] ?? "");
				if (color) colors.push(color);
				return color ? `\x1b[${color}m` : "";
			}
			return decodeHtml(part);
		})
		.join("");
}

export function highlightCode(code: string, language: string): string[] | undefined {
	if (!hljs.getLanguage(language)) return undefined;
	try {
		return renderHtml(hljs.highlight(code, { language, ignoreIllegals: true }).value).split("\n");
	} catch {
		return undefined;
	}
}
