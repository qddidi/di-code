import { eastAsianWidth } from "get-east-asian-width";

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI parsing necessarily matches ESC and BEL.
const ansiPattern = /^(?:\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b_[^\x07]*(?:\x07|\x1b\\))/;
const zeroWidthPattern = /^(?:\p{Default_Ignorable_Code_Point}|\p{Control}|\p{Mark}|\p{Surrogate})+$/u;
const leadingNonPrintingPattern =
	/^(?:\p{Default_Ignorable_Code_Point}|\p{Control}|\p{Format}|\p{Mark}|\p{Surrogate})+/u;
const emojiCodePointPattern = /\p{Extended_Pictographic}|\p{Emoji_Presentation}|\p{Regional_Indicator}/u;

function isPrintableAscii(text: string): boolean {
	for (let index = 0; index < text.length; index += 1) {
		const code = text.charCodeAt(index);
		if (code < 0x20 || code > 0x7e) return false;
	}
	return true;
}

function readAnsi(text: string, index: number): string | undefined {
	if (text[index] !== "\x1b") return undefined;
	const match = ansiPattern.exec(text.slice(index));
	return match?.[0];
}

function couldBeEmoji(cluster: string): boolean {
	const codePoint = cluster.codePointAt(0) ?? 0;
	return (
		(codePoint >= 0x1f000 && codePoint <= 0x1fbff) ||
		(codePoint >= 0x2300 && codePoint <= 0x23ff) ||
		(codePoint >= 0x2600 && codePoint <= 0x27bf) ||
		(codePoint >= 0x2b50 && codePoint <= 0x2b55) ||
		cluster.includes("\uFE0F") ||
		cluster.length > 2
	);
}

function isEmojiGrapheme(cluster: string): boolean {
	return emojiCodePointPattern.test(cluster) || cluster.includes("\uFE0F") || cluster.includes("\u20E3");
}

function graphemeWidth(cluster: string): number {
	if (cluster === "\t") return 3;
	if (zeroWidthPattern.test(cluster)) return 0;
	if (couldBeEmoji(cluster) && isEmojiGrapheme(cluster)) return 2;
	const base = cluster.replace(leadingNonPrintingPattern, "");
	const codePoint = base.codePointAt(0);
	if (codePoint === undefined) return 0;
	if (codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff) return 2;
	return eastAsianWidth(codePoint);
}

export function visibleWidth(text: string): number {
	if (text.length === 0) return 0;
	if (isPrintableAscii(text)) return text.length;

	let width = 0;
	let plain = "";
	const flushPlain = (): void => {
		for (const { segment } of graphemeSegmenter.segment(plain)) {
			width += graphemeWidth(segment);
		}
		plain = "";
	};

	for (let index = 0; index < text.length; ) {
		const ansi = readAnsi(text, index);
		if (ansi) {
			flushPlain();
			index += ansi.length;
			continue;
		}
		plain += text[index];
		index += 1;
	}
	flushPlain();
	return width;
}

function scanPrefix(text: string, maxWidth: number): { text: string; width: number; complete: boolean } {
	if (maxWidth <= 0) return { text: "", width: 0, complete: false };

	let result = "";
	let width = 0;
	let index = 0;
	while (index < text.length) {
		const ansi = readAnsi(text, index);
		if (ansi) {
			result += ansi;
			index += ansi.length;
			continue;
		}

		let end = index + 1;
		while (end < text.length && !readAnsi(text, end)) end += 1;
		for (const { segment } of graphemeSegmenter.segment(text.slice(index, end))) {
			const segmentWidth = graphemeWidth(segment);
			if (width + segmentWidth > maxWidth) {
				return { text: result, width, complete: false };
			}
			result += segment;
			width += segmentWidth;
		}
		index = end;
	}
	return { text: result, width, complete: true };
}

export function truncateToWidth(text: string, maxWidth: number, ellipsis = "...", pad = false): string {
	if (maxWidth <= 0) return "";
	const textWidth = visibleWidth(text);
	if (textWidth <= maxWidth) {
		return pad ? `${text}${" ".repeat(maxWidth - textWidth)}` : text;
	}

	const ellipsisWidth = visibleWidth(ellipsis);
	if (ellipsis.length === 0) {
		const prefix = scanPrefix(text, maxWidth);
		const result = `${prefix.text}\x1b[0m`;
		return pad ? `${result}${" ".repeat(maxWidth - prefix.width)}` : result;
	}

	if (ellipsisWidth >= maxWidth) {
		const clipped = scanPrefix(ellipsis, maxWidth);
		const result = `\x1b[0m${clipped.text}\x1b[0m`;
		return pad ? `${result}${" ".repeat(maxWidth - clipped.width)}` : result;
	}

	const prefix = scanPrefix(text, maxWidth - ellipsisWidth);
	const result = `${prefix.text}\x1b[0m${ellipsis}\x1b[0m`;
	return pad ? `${result}${" ".repeat(maxWidth - prefix.width - ellipsisWidth)}` : result;
}

export function sliceByColumn(line: string, startColumn: number, length: number): string {
	if (length <= 0) return "";
	const start = Math.max(0, startColumn);
	const endColumn = start + length;
	let result = "";
	let pendingAnsi = "";
	let column = 0;
	let index = 0;

	while (index < line.length) {
		const ansi = readAnsi(line, index);
		if (ansi) {
			if (column < start) {
				pendingAnsi += ansi;
			} else if (column < endColumn) {
				result += pendingAnsi + ansi;
				pendingAnsi = "";
			}
			index += ansi.length;
			continue;
		}

		let end = index + 1;
		while (end < line.length && !readAnsi(line, end)) end += 1;
		for (const { segment } of graphemeSegmenter.segment(line.slice(index, end))) {
			const segmentWidth = graphemeWidth(segment);
			if (column >= start && column + segmentWidth <= endColumn) {
				result += pendingAnsi + segment;
				pendingAnsi = "";
			}
			column += segmentWidth;
		}
		index = end;
	}

	return result ? `${result}\x1b[0m` : "";
}
