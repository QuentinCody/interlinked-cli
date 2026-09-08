import { isJsonObject, type JsonObject } from "../../../lib/json-types.js";

/** Read emitted JSON without assuming the writer produced the expected shape. */
export function readJsonRecord(content: string): JsonObject {
	const value: unknown = JSON.parse(content);
	if (!isJsonObject(value)) throw new Error("Expected a JSON object");
	return value;
}

export function jsonRecords(value: unknown): JsonObject[] {
	if (!Array.isArray(value) || !value.every(isJsonObject)) {
		throw new Error("Expected an array of JSON objects");
	}
	return value;
}
