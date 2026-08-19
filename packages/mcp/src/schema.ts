import type { ValidateFunction } from "ajv";
import { Ajv } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { McpError } from "./errors.ts";

const Ajv2020Constructor = Ajv2020 as unknown as new (
	options?: ConstructorParameters<typeof Ajv>[0],
) => InstanceType<typeof Ajv>;

/** Compiles an MCP JSON Schema at the external boundary and validates plain tool arguments. */
export function compileMcpInputSchema(
	serverId: string,
	toolName: string,
	schema: Record<string, unknown>,
): (value: unknown) => void {
	let validate: ValidateFunction;
	try {
		const dialect = typeof schema.$schema === "string" ? schema.$schema : "";
		const ajv = dialect.includes("2020-12")
			? new Ajv2020Constructor({ allErrors: true, strict: false })
			: new Ajv({ allErrors: true, strict: false });
		(addFormats as unknown as (instance: InstanceType<typeof Ajv>) => void)(ajv);
		validate = ajv.compile(schema);
	} catch (cause) {
		throw new McpError("protocol", serverId, `tool "${toolName}" has an invalid inputSchema`, { cause });
	}
	return (value: unknown): void => {
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			throw new McpError("tool", serverId, `tool "${toolName}" arguments must be an object`);
		}
		if (!validate(value)) {
			const issues = (validate.errors ?? [])
				.slice(0, 5)
				.map((error) => `${error.instancePath || "/"} ${error.message}`)
				.join("; ");
			throw new McpError(
				"tool",
				serverId,
				`invalid arguments for tool "${toolName}": ${issues || "schema validation failed"}`,
			);
		}
	};
}
