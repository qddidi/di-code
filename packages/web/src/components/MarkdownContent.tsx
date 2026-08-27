import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownContentProps {
	readonly children: string;
}

function safeUrl(url: string): string {
	const normalized = url.trim();
	const protocol = /^[a-z][a-z\d+.-]*:/i.exec(normalized)?.[0]?.toLowerCase();
	if (!protocol || protocol === "http:" || protocol === "https:" || protocol === "mailto:") return normalized;
	return "";
}

/** Renders model output as safe GitHub-flavored Markdown without parsing embedded HTML. */
export function MarkdownContent({ children }: MarkdownContentProps): React.JSX.Element {
	return <ReactMarkdown
		remarkPlugins={[remarkGfm]}
		urlTransform={safeUrl}
		components={{
			a: ({ href, children: linkChildren }) => <a href={href} target="_blank" rel="noreferrer">{linkChildren}</a>,
			code: ({ className, children: codeChildren }) => <code className={className}>{codeChildren}</code>,
		}}
	>{children}</ReactMarkdown>;
}
