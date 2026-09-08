import { assert } from "vitest";
import { isJsonObject, type JsonObject } from "../../lib/json-types.js";

export function outputObject(value: unknown): JsonObject {
	assert(isJsonObject(value), "expected an output object");
	return value;
}

export function outputString(value: unknown): string {
	assert(typeof value === "string", "expected an output string");
	return value;
}

function objectArray(value: unknown): JsonObject[] {
	assert(Array.isArray(value), "expected an output array");
	return value.map(outputObject);
}

export function flatHookSettings(value: unknown): { version: unknown; hooks: Record<string, JsonObject[]> } {
	const root = outputObject(value);
	const hooks = Object.fromEntries(Object.entries(outputObject(root.hooks)).map(([name, entries]) => [name, objectArray(entries)]));
	return { ...root, version: root.version, hooks };
}

interface NestedHookEntry extends JsonObject {
	hooks: JsonObject[];
}

export function nestedHookSettings(value: unknown): { hooks: Record<string, NestedHookEntry[]> } {
	const root = flatHookSettings(value);
	const hooks = Object.fromEntries(Object.entries(root.hooks).map(([name, entries]) => [name, entries.map((entry): NestedHookEntry => ({ ...entry, hooks: objectArray(entry.hooks) }))]));
	return { ...root, hooks };
}
