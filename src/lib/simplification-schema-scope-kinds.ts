// ===========================================
// Simplification review — scalar/list JSON parsing primitives
// ===========================================
// Shared by simplification-schema.ts and simplification-schema-report-relations.ts.
// Fixed vocabularies and validators specific to the simplification report schema.
import { isRepositoryPath, stringList, uniqueCanonicalStrings } from "./report-value-parsers.js";
export {
	isRepositoryPath as isSimplificationRepositoryPath, nonNegativeInteger, nullableString,
	requiredString, stringList, uniqueCanonicalStrings,
} from "./report-value-parsers.js";

export const EVIDENCE_STATES = ["candidate", "heuristic", "proven", "sandbox-validated"] as const;
export const SCOPE_KINDS = ["repository", "changed", "staged", "range"] as const;
export const VALIDATION_STATUSES = ["not_run", "passed", "failed", "inconclusive"] as const;
export const COVERAGE_STATUSES = ["complete", "partial", "unavailable"] as const;
export const SOURCE_STATUSES = ["checked", "partial", "skipped", "unavailable"] as const;

export function isMember<T extends string>(value: unknown, choices: readonly T[]): value is T {
	return typeof value === "string" && choices.some((choice) => choice === value);
}

/** Compare individual keys so a field name containing a separator cannot impersonate two fields. */
export function exactKeys(value: object, expected: readonly string[]): boolean {
	const keys = Object.keys(value).sort();
	const wanted = [...expected].sort();
	return keys.length === wanted.length && keys.every((key, index) => key === wanted[index]);
}

export function fixtureText(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 32_768;
}

export function manifestText(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 4_096;
}

export function fixturePath(value: unknown): value is string {
	return fixtureText(value) && !value.startsWith("/") && !value.includes("\\") &&
		value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

export function sortedFixtureStrings(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(fixtureText) && uniqueCanonicalStrings(value);
}

export function sortedManifestStrings(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(manifestText) && uniqueCanonicalStrings(value);
}

export function isoTimestamp(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const millis = Date.parse(value);
	return Number.isFinite(millis) && new Date(millis).toISOString() === value;
}

export function pathList(value: unknown): string[] | null {
	const values = stringList(value);
	return values?.every(isRepositoryPath) ? values : null;
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
