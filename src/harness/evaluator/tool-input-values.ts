/** Read text from an untrusted hook field without coercing objects or numbers. */
export function readToolString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** Preserve absence for optional write content, where an empty string means deletion. */
export function readOptionalToolString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}
