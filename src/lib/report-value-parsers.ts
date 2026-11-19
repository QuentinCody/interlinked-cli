/** Scalar and list values shared by repository report parsers. */
export function requiredString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

export function nullableString(value: unknown): string | null | undefined {
	if (value === null) return null;
	return requiredString(value) ?? undefined;
}

export function stringList(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	return value.every((entry): entry is string => typeof entry === "string") ? [...value] : null;
}

export function isRepositoryPath(value: string): boolean {
	if (value.length === 0 || value.startsWith("/") || value.includes("\\")) return false;
	if (/^[A-Za-z]:/.test(value)) return false;
	return value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

export function uniqueCanonicalStrings(values: readonly string[]): boolean {
	return new Set(values).size === values.length
		&& values.every((entry, index) => index === 0 || entry >= (values[index - 1] ?? ""));
}

export function nonNegativeInteger(value: unknown): number | null {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}
