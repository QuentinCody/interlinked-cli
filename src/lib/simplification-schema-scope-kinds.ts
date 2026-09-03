// ===========================================
// Simplification review — scalar/list JSON parsing primitives
// ===========================================
// Shared by simplification-schema.ts and simplification-schema-report-relations.ts.
// Pure value/string parsing helpers plus the fixed vocabularies used across the
// simplification report schema. Kept import-free so both consumers can depend on
// it without creating a module cycle between them.

export const EVIDENCE_STATES = ["candidate", "heuristic", "proven", "sandbox-validated"] as const;
export const SCOPE_KINDS = ["repository", "changed", "staged", "range"] as const;
export const VALIDATION_STATUSES = ["not_run", "passed", "failed", "inconclusive"] as const;
export const COVERAGE_STATUSES = ["complete", "partial", "unavailable"] as const;
export const SOURCE_STATUSES = ["checked", "partial", "skipped", "unavailable"] as const;

export function isMember<T extends string>(value: unknown, choices: readonly T[]): value is T {
	return typeof value === "string" && choices.some((choice) => choice === value);
}

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

export function isSimplificationRepositoryPath(value: string): boolean {
	if (value.length === 0 || value.startsWith("/") || value.includes("\\")) return false;
	if (/^[A-Za-z]:/.test(value)) return false;
	return value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

export function pathList(value: unknown): string[] | null {
	const values = stringList(value);
	return values?.every(isSimplificationRepositoryPath) ? values : null;
}

export function uniqueCanonicalStrings(values: readonly string[]): boolean {
	return new Set(values).size === values.length
		&& values.every((entry, index) => index === 0 || entry >= (values[index - 1] ?? ""));
}

export function nonNegativeInteger(value: unknown): number | null {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

export function finiteNumberOrNull(value: unknown): number | null | undefined {
	if (value === null) return null;
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function parsedList<T>(value: unknown, parser: (entry: unknown) => T | null): T[] | null {
	if (!Array.isArray(value)) return null;
	const out: T[] = [];
	for (const entry of value) {
		const parsed = parser(entry);
		if (parsed === null) return null;
		out.push(parsed);
	}
	return out;
}
