import { posix } from "node:path";

/**
 * A claim that a generator writes a path, read from a generator's own config or from a repository command. The reader gives the raw
 * path, the directory it is relative to, and the file and line it came from. `resolveClaims` checks the path against the tracked files:
 * a path that names nothing tracked, the repository root, a generic top-level directory, a shell variable or a path outside the
 * repository is skipped and counted. Nothing is guessed.
 */
export type ClaimKind = "generator-config" | "generator-command" | "doc-statement";
export interface RawClaim { tool: string; path: string; baseDir: string; file: string; line: number; kind: ClaimKind; /** Further directories to try before the repository root. */ fallbackDirs?: string[];
	/** Paths (relative to `baseDir`) that the same config names as INPUT (sqlc schema and queries, a spec, a schema file): never claimed. */ inputs?: string[];
	/** File extensions that the output has (the language of a sqlc `gen` block); none means every extension. */ extensions?: string[]; }
export interface ClaimSkip { file: string; line: number; tool: string; reason: string; pattern?: string | undefined; }
export interface ClaimReading { claims: RawClaim[]; skipped: ClaimSkip[]; }
export interface ResolvedClaim { tool: string; target: string; isDirectory: boolean; file: string; line: number; kind: ClaimKind; inputs: string[]; extensions: string[]; }

/** A top-level directory that holds a whole project: a generator that writes "src" has not said which files it owns. */
const BROAD_TOP_LEVEL = new Set(["", ".", "src", "lib", "app", "apps", "packages", "source", "sources", "internal", "pkg", "cmd", "include", "test", "tests", "docs", "scripts"]);

function normalized(base: string, raw: string): string | null {
	const joined = posix.normalize(posix.join(base === "" ? "." : base, raw.replace(/^\.\//, "")));
	return joined.startsWith("..") ? null : joined.replace(/^\.$/, "").replace(/\/+$/, "");
}

/** The tracked files and every directory that holds one. */
function trackedSets(tracked: readonly string[]): { files: Set<string>; directories: Set<string> } {
	const files = new Set(tracked), directories = new Set<string>();
	for (const file of tracked) for (let dir = posix.dirname(file); dir !== "." && !directories.has(dir); dir = posix.dirname(dir)) directories.add(dir);
	return { files, directories };
}

export function resolveClaims(raw: readonly RawClaim[], tracked: readonly string[]): { claims: ResolvedClaim[]; skipped: ClaimSkip[] } {
	const sets = trackedSets(tracked), claims: ResolvedClaim[] = [], skipped: ClaimSkip[] = [];
	for (const item of raw) {
		const skip = (reason: string): void => { skipped.push({ file: item.file, line: item.line, tool: item.tool, reason, pattern: item.path }); };
		const path = item.path.trim();
		if (/[$`]|\{\{/.test(path)) { skip("variable-path"); continue; }
		const candidates = [item.baseDir, ...(item.fallbackDirs ?? []), ""].map((base) => normalized(base, path));
		if (candidates.every((candidate) => candidate === null)) { skip("outside-repository"); continue; }
		if (candidates.some((candidate) => candidate !== null && BROAD_TOP_LEVEL.has(candidate) && !sets.files.has(candidate))) { skip("too-broad"); continue; }
		const target = candidates.find((candidate): candidate is string => candidate !== null && (sets.files.has(candidate) || sets.directories.has(candidate)));
		if (target === undefined) { skip("unresolved-path"); continue; }
		const inputs = (item.inputs ?? []).map((input) => normalized(item.baseDir, input)).filter((input): input is string => input !== null && input !== "");
		claims.push({ tool: item.tool, target, isDirectory: !sets.files.has(target), file: item.file, line: item.line, kind: item.kind, inputs, extensions: item.extensions ?? [] });
	}
	return { claims, skipped };
}

/** A claim on a directory never covers a file that the same config names as an input, nor a file whose extension is not the output language's. */
function claimsFile(claim: ResolvedClaim, path: string): boolean {
	if (claim.inputs.some((input) => path === input || path.startsWith(`${input}/`))) return false;
	return claim.extensions.length === 0 || !claim.isDirectory || claim.extensions.some((extension) => path.endsWith(extension));
}

export interface ClaimIndex { match(path: string): ResolvedClaim | null; size: number; }

/** Lookup by path: the deepest directory claim wins; an exact file claim wins over its directory. */
export function buildClaimIndex(claims: readonly ResolvedClaim[]): ClaimIndex {
	const byTarget = new Map<string, ResolvedClaim>();
	for (const claim of claims) if (!byTarget.has(claim.target)) byTarget.set(claim.target, claim);
	return {
		size: byTarget.size,
		match(path) {
			for (let at = path; at !== "." && at !== ""; at = posix.dirname(at)) {
				const hit = byTarget.get(at);
				if (hit !== undefined && (hit.isDirectory ? at !== path : at === path) && claimsFile(hit, path)) return hit;
			}
			return null;
		},
	};
}
