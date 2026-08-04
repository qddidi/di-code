import { Type } from "typebox";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { ToolDefinition } from "../src/index.ts";
import { parseToolArguments, ToolArgumentsValidationError, validateToolArguments } from "../src/index.ts";

const readTool = {
	name: "read",
	description: "Read a text file",
	parameters: Type.Object({
		path: Type.String({ minLength: 1 }),
		limit: Type.Number({ minimum: 1 }),
		options: Type.Object({
			labels: Type.Array(Type.String()),
		}),
	}),
} satisfies ToolDefinition;

function captureValidationError(run: () => unknown): ToolArgumentsValidationError {
	try {
		run();
	} catch (cause) {
		if (cause instanceof ToolArgumentsValidationError) {
			return cause;
		}
		throw cause;
	}
	throw new Error("Expected ToolArgumentsValidationError");
}

describe("validateToolArguments", () => {
	it("returns a statically typed deep clone for valid arguments", () => {
		const input = {
			path: "README.md",
			limit: 20,
			options: { labels: ["docs"] },
		};

		const validated = validateToolArguments(readTool, input);

		expectTypeOf(validated.path).toEqualTypeOf<string>();
		expectTypeOf(validated.limit).toEqualTypeOf<number>();
		expectTypeOf(validated.options.labels).toEqualTypeOf<string[]>();
		expect(validated).toEqual(input);
		expect(validated).not.toBe(input);
		expect(validated.options).not.toBe(input.options);
		expect(validated.options.labels).not.toBe(input.options.labels);
	});

	it("reports the missing required property path", () => {
		const error = captureValidationError(() =>
			validateToolArguments(readTool, {
				limit: 20,
				options: { labels: [] },
			}),
		);

		expect(error.toolName).toBe("read");
		expect(error.issues.join("\n")).toMatch(/\/path/i);
		expect(error.message).toContain('tool "read"');
	});

	it("does not convert a string to the required number", () => {
		const error = captureValidationError(() =>
			validateToolArguments(readTool, {
				path: "README.md",
				limit: "20",
				options: { labels: [] },
			}),
		);

		expect(error.issues.join("\n")).toMatch(/\/limit.*number/i);
	});

	it("enforces minimum and minLength constraints", () => {
		const error = captureValidationError(() =>
			validateToolArguments(readTool, {
				path: "",
				limit: 0,
				options: { labels: [] },
			}),
		);
		const issues = error.issues.join("\n");

		expect(issues).toContain("/path");
		expect(issues).toContain("/limit");
	});

	it("rejects null, arrays, and non-plain object roots", () => {
		expect(() => validateToolArguments(readTool, null)).toThrow(ToolArgumentsValidationError);
		expect(() => validateToolArguments(readTool, [])).toThrow(ToolArgumentsValidationError);
		expect(() => validateToolArguments(readTool, new Date(0))).toThrow(ToolArgumentsValidationError);
	});

	it("normalizes structuredClone failures", () => {
		const error = captureValidationError(() =>
			validateToolArguments(readTool, {
				path: "README.md",
				limit: 20,
				options: { labels: [] },
				callback: () => undefined,
			}),
		);

		expect(error.issues).toContain("/: arguments must contain only structured-clone-compatible values");
	});
});
describe("parseToolArguments", () => {
	it("parses valid JSON and returns typed arguments", () => {
		const parsed = parseToolArguments(readTool, '{"path":"README.md","limit":20,"options":{"labels":["docs"]}}');

		expectTypeOf(parsed.limit).toEqualTypeOf<number>();
		expect(parsed).toEqual({
			path: "README.md",
			limit: 20,
			options: { labels: ["docs"] },
		});
	});

	it("normalizes invalid JSON syntax", () => {
		const error = captureValidationError(() => parseToolArguments(readTool, '{"path":'));

		expect(error.toolName).toBe("read");
		expect(error.issues).toContain("/: arguments must be valid JSON");
	});

	it("rejects parsed values whose root is not an object", () => {
		expect(() => parseToolArguments(readTool, "null")).toThrow(ToolArgumentsValidationError);
		expect(() => parseToolArguments(readTool, "[]")).toThrow(ToolArgumentsValidationError);
		expect(() => parseToolArguments(readTool, '"text"')).toThrow(ToolArgumentsValidationError);
	});

	it("does not include a large untrusted input in its error", () => {
		const marker = `UNTRUSTED_${"x".repeat(5_000)}`;
		const error = captureValidationError(() => parseToolArguments(readTool, `{"path":"${marker}`));

		expect(error.message).not.toContain("UNTRUSTED_");
		expect(error.message.length).toBeLessThan(500);
	});
});
