import * as Diff from "diff";

export interface DiffColors {
	readonly dim: string;
	readonly error: string;
	readonly success: string;
}

const RESET = "\x1b[0m";
const INVERSE = "\x1b[7m";

function paint(color: string, text: string, inverse = false): string {
	return `${color}${inverse ? INVERSE : ""}${text}${RESET}`;
}

function parseLine(line: string): { prefix: string; lineNumber: string; content: string } | undefined {
	const match = line.match(/^([+-\s])(\s*\d*)\s(.*)$/);
	return match ? { prefix: match[1], lineNumber: match[2], content: match[3] } : undefined;
}

function renderWordChange(oldContent: string, newContent: string): { oldLine: string; newLine: string } {
	const parts = Diff.diffWords(oldContent, newContent);
	let oldLine = "";
	let newLine = "";
	for (const part of parts) {
		if (part.removed) oldLine += paint("", part.value, true);
		else if (part.added) newLine += paint("", part.value, true);
		else {
			oldLine += part.value;
			newLine += part.value;
		}
	}
	return { oldLine, newLine };
}

function replaceTabs(text: string): string {
	return text.replaceAll("\t", "   ");
}

/** 将 edit-diff 的行号格式转换成 Pi 风格的 ANSI 着色行。 */
export function renderDiff(diffText: string, colors: DiffColors): string[] {
	const source = diffText.split("\n");
	const result: string[] = [];
	let index = 0;
	while (index < source.length) {
		const current = parseLine(source[index]);
		if (!current) {
			result.push(paint(colors.dim, source[index]));
			index += 1;
			continue;
		}
		if (current.prefix !== "-") {
			const color = current.prefix === "+" ? colors.success : colors.dim;
			result.push(paint(color, `${current.prefix}${current.lineNumber} ${replaceTabs(current.content)}`));
			index += 1;
			continue;
		}

		const removed: Array<{ lineNumber: string; content: string }> = [];
		while (index < source.length) {
			const line = parseLine(source[index]);
			if (!line || line.prefix !== "-") break;
			removed.push({ lineNumber: line.lineNumber, content: line.content });
			index += 1;
		}
		const added: Array<{ lineNumber: string; content: string }> = [];
		while (index < source.length) {
			const line = parseLine(source[index]);
			if (!line || line.prefix !== "+") break;
			added.push({ lineNumber: line.lineNumber, content: line.content });
			index += 1;
		}
		if (removed.length === 1 && added.length === 1) {
			const changed = renderWordChange(replaceTabs(removed[0].content), replaceTabs(added[0].content));
			result.push(paint(colors.error, `-${removed[0].lineNumber} ${changed.oldLine}`));
			result.push(paint(colors.success, `+${added[0].lineNumber} ${changed.newLine}`));
		} else {
			for (const line of removed) result.push(paint(colors.error, `-${line.lineNumber} ${replaceTabs(line.content)}`));
			for (const line of added) result.push(paint(colors.success, `+${line.lineNumber} ${replaceTabs(line.content)}`));
		}
	}
	return result;
}
