import type { Component } from "../tui.ts";

export class Spacer implements Component {
	private readonly rows: number;

	constructor(rows = 1) {
		if (!Number.isInteger(rows) || rows < 0) throw new Error("Spacer rows must be a non-negative integer");
		this.rows = rows;
	}

	render(_width: number): string[] {
		return Array.from({ length: this.rows }, () => "");
	}

	invalidate(): void {}
}
