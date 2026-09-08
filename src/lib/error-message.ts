import { isJsonObject } from "./json-types.js";

/** Render thrown values without asserting that every throw is an Error. */
export function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (isJsonObject(error) && typeof error.message === "string") return error.message;
	return String(error);
}
