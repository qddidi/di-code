import type { Component } from "./tui.ts";
import { sliceByColumn, truncateToWidth, visibleWidth } from "./utils.ts";

export type OverlayAnchor =
	| "center"
	| "top-left"
	| "top-center"
	| "top-right"
	| "left-center"
	| "right-center"
	| "bottom-left"
	| "bottom-center"
	| "bottom-right";

export type SizeValue = number | `${number}%`;

export interface OverlayPlacement {
	readonly anchorRow: number;
	readonly avoidStartRow?: number;
	readonly preferred?: "above" | "below";
}

export interface OverlayOptions {
	readonly width?: SizeValue;
	readonly maxHeight?: SizeValue;
	readonly anchor?: OverlayAnchor;
	/** Positions the overlay beside a logical line in the current terminal viewport. */
	readonly placement?: OverlayPlacement;
	readonly margin?: number;
	readonly nonCapturing?: boolean;
}

export interface OverlayHandle {
	hide(): void;
	setHidden(hidden: boolean): void;
	isHidden(): boolean;
	focus(): void;
	isFocused(): boolean;
}

const SEGMENT_RESET = "\x1b[0m\x1b]8;;\x07";

function assertSizeValue(value: SizeValue | undefined, name: string): void {
	if (value === undefined) return;
	if (typeof value === "number") {
		if (!Number.isInteger(value) || value <= 0) throw new Error(`Overlay ${name} must be a positive integer`);
		return;
	}
	const match = /^(\d+(?:\.\d+)?)%$/.exec(value);
	const percentage = Number(match?.[1]);
	if (!match || percentage <= 0 || percentage > 100) {
		throw new Error(`Overlay ${name} percentage must be greater than 0% and at most 100%`);
	}
}

export function validateOverlayOptions(options: OverlayOptions): void {
	assertSizeValue(options.width, "width");
	assertSizeValue(options.maxHeight, "maxHeight");
	if (options.margin !== undefined && (!Number.isInteger(options.margin) || options.margin < 0)) {
		throw new Error("Overlay margin must be a non-negative integer");
	}
	if (options.placement && (!Number.isInteger(options.placement.anchorRow) || options.placement.anchorRow < 0)) {
		throw new Error("Overlay placement anchorRow must be a non-negative integer");
	}
	if (
		options.placement?.avoidStartRow !== undefined &&
		(!Number.isInteger(options.placement.avoidStartRow) || options.placement.avoidStartRow < 0)
	) {
		throw new Error("Overlay placement avoidStartRow must be a non-negative integer");
	}
}

function resolveSize(value: SizeValue | undefined, reference: number, fallback: number): number {
	if (value === undefined) return fallback;
	if (typeof value === "number") return value;
	return Math.floor((reference * Number(value.slice(0, -1))) / 100);
}

function horizontalPosition(anchor: OverlayAnchor, width: number, terminalWidth: number, margin: number): number {
	if (anchor.endsWith("left")) return margin;
	if (anchor.endsWith("right")) return terminalWidth - margin - width;
	return Math.floor((terminalWidth - width) / 2);
}

function verticalPosition(anchor: OverlayAnchor, height: number, terminalHeight: number, margin: number): number {
	if (anchor.startsWith("top")) return margin;
	if (anchor.startsWith("bottom")) return terminalHeight - margin - height;
	return Math.floor((terminalHeight - height) / 2);
}

function padToWidth(text: string, width: number): string {
	return `${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`;
}

function compositeLine(
	baseLine: string,
	overlayLine: string,
	column: number,
	overlayWidth: number,
	width: number,
): string {
	const prefix = padToWidth(sliceByColumn(baseLine, 0, column), column);
	const suffixStart = column + overlayWidth;
	const suffix = padToWidth(sliceByColumn(baseLine, suffixStart, width - suffixStart), width - suffixStart);
	const overlay = truncateToWidth(overlayLine, overlayWidth, "", true);
	return `${prefix}${SEGMENT_RESET}${overlay}${SEGMENT_RESET}${suffix}`;
}

export function compositeOverlay(
	baseLines: readonly string[],
	component: Component,
	options: OverlayOptions,
	terminalWidth: number,
	terminalHeight: number,
): string[] {
	const margin = Math.min(options.margin ?? 0, Math.floor((Math.min(terminalWidth, terminalHeight) - 1) / 2));
	const availableWidth = Math.max(1, terminalWidth - margin * 2);
	const availableHeight = Math.max(1, terminalHeight - margin * 2);
	const width = Math.max(1, Math.min(availableWidth, resolveSize(options.width, terminalWidth, availableWidth)));
	const maxHeight = Math.max(
		1,
		Math.min(availableHeight, resolveSize(options.maxHeight, terminalHeight, availableHeight)),
	);
	let overlayLines = component.render(width).slice(0, maxHeight);
	if (overlayLines.length === 0) return [...baseLines];

	const anchor = options.anchor ?? "center";
	const viewportTop = Math.max(0, baseLines.length - terminalHeight);
	let viewportRow = Math.max(
		margin,
		Math.min(
			terminalHeight - margin - overlayLines.length,
			verticalPosition(anchor, overlayLines.length, terminalHeight, margin),
		),
	);
	if (options.placement) {
		const anchorRow = options.placement.anchorRow - viewportTop;
		const viewportBottom = terminalHeight - margin;
		if (anchorRow >= margin && anchorRow < viewportBottom) {
			const belowSpace = Math.max(0, viewportBottom - anchorRow - 1);
			const aboveAnchorRow = (options.placement.avoidStartRow ?? options.placement.anchorRow) - viewportTop;
			const aboveSpace = Math.max(0, aboveAnchorRow - margin);
			const preferred = options.placement.preferred ?? "below";
			const useBelow =
				preferred === "below"
					? belowSpace >= overlayLines.length || aboveSpace === 0
					: aboveSpace < overlayLines.length && belowSpace > 0;
			const availableSpace = useBelow ? belowSpace : aboveSpace;
			overlayLines = overlayLines.slice(0, availableSpace);
			if (overlayLines.length === 0) return [...baseLines];
			viewportRow = useBelow ? anchorRow + 1 : aboveAnchorRow - overlayLines.length;
		}
	}
	const row = viewportTop + viewportRow;
	const column = Math.max(
		margin,
		Math.min(terminalWidth - margin - width, horizontalPosition(anchor, width, terminalWidth, margin)),
	);
	const result = [...baseLines];
	while (result.length < row + overlayLines.length) result.push("");
	for (let index = 0; index < overlayLines.length; index += 1) {
		const target = row + index;
		result[target] = compositeLine(result[target] ?? "", overlayLines[index] ?? "", column, width, terminalWidth);
	}
	return result;
}
