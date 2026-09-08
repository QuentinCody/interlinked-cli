/** A deliberately bounded proof over positive, relative coverage globs.
 * Unsupported syntax abstains; a failed witness search never proves equality. */
export interface CoverageGlobArrays {
	include: string[] | null;
	exclude: string[] | null;
}

export type CoverageGlobComparison =
	| { kind: "nondecreasing" }
	| { kind: "reduced"; witness: string }
	| { kind: "undecidable"; detail: string };

interface SimpleGlob {
	directories: string[];
	recursive: boolean;
	filename: string;
}

const MAX_PATTERNS = 64;
const MAX_WITNESSES = 4096;

function expandAlternatives(pattern: string): string[] | null {
	if ((pattern.match(/\{/g)?.length ?? 0) > 6) return null;
	const brace = /\{([A-Za-z0-9_.-]+(?:,[A-Za-z0-9_.-]+)+)\}/.exec(pattern);
	if (!brace) return [pattern];
	const members = brace[1]?.split(",") ?? [];
	const expanded: string[] = [];
	for (const member of members) {
		const rest = expandAlternatives(pattern.slice(0, brace.index) + member + pattern.slice(brace.index + brace[0].length));
		if (rest === null || expanded.length + rest.length > MAX_PATTERNS) return null;
		expanded.push(...rest);
	}
	return expanded;
}

function parseSimpleGlob(pattern: string): SimpleGlob | null {
	// No negation, extglobs, escapes, dot segments, character classes, or
	// wildcard directory components other than one complete globstar segment.
	if (!/^[A-Za-z0-9_*-][A-Za-z0-9_.*\/-]*$/.test(pattern)) return null;
	const segments = pattern.split("/");
	if (segments.some(segment => !segment || segment.startsWith("."))) return null;
	const final = segments.pop();
	if (final === undefined) return null;
	let recursive = final === "**";
	if (segments.at(-1) === "**") {
		if (recursive) return null;
		recursive = true;
		segments.pop();
	}
	if (segments.some(segment => segment.includes("*"))) return null;
	const filename = final === "**" ? "*" : final;
	if (!/^\*?[A-Za-z0-9_.-]*$/.test(filename)) return null;
	return { directories: segments, recursive, filename };
}

function parsePatterns(patterns: string[] | null): SimpleGlob[] | null {
	if (patterns === null) return null;
	const parsed: SimpleGlob[] = [];
	for (const pattern of new Set(patterns)) {
		const expanded = expandAlternatives(pattern);
		if (expanded === null || parsed.length + expanded.length > MAX_PATTERNS) return null;
		for (const member of expanded) {
			const glob = parseSimpleGlob(member);
			if (glob === null) return null;
			parsed.push(glob);
		}
	}
	return parsed;
}

function filenameSubset(source: string, target: string): boolean {
	if (!target.startsWith("*")) return source === target;
	return source.endsWith(target.slice(1));
}

function globSubset(source: SimpleGlob, target: SimpleGlob): boolean {
	if (!target.directories.every((part, index) => source.directories[index] === part)) return false;
	if (!target.recursive && (source.recursive || source.directories.length !== target.directories.length)) return false;
	return filenameSubset(source.filename, target.filename);
}

function patternsSubset(source: SimpleGlob[] | null, target: SimpleGlob[] | null): boolean {
	if (source === null || target === null) return source === target;
	return source.every(pattern => target.some(other => globSubset(pattern, other)));
}

function covered(path: SimpleGlob, include: SimpleGlob[], exclude: SimpleGlob[]): boolean {
	return include.some(pattern => globSubset(path, pattern)) && !exclude.some(pattern => globSubset(path, pattern));
}

function findLostPath(
	head: { include: SimpleGlob[]; exclude: SimpleGlob[] },
	proposed: { include: SimpleGlob[]; exclude: SimpleGlob[] },
): string | null {
	const patterns = [...head.include, ...head.exclude, ...proposed.include, ...proposed.exclude];
	const directories = new Set(patterns.flatMap(pattern => [pattern.directories.join("/"), [...pattern.directories, "coverage-directory"].join("/")]));
	const filenames = new Set(patterns.map(pattern => pattern.filename.replace("*", "coverage-file")));
	let attempts = 0;
	for (const directory of directories) {
		for (const filename of filenames) {
			if (++attempts > MAX_WITNESSES) return null;
			const path = { directories: directory ? directory.split("/") : [], recursive: false, filename };
			if (covered(path, head.include, head.exclude) && !covered(path, proposed.include, proposed.exclude)) {
				return [...path.directories, filename].join("/");
			}
		}
	}
	return null;
}

/** Prove monotonicity by containment, or scope loss with a concrete path.
 * A witness describes the configured path language, not an on-disk file census. */
export function compareCoverageGlobScope(head: CoverageGlobArrays, proposed: CoverageGlobArrays): CoverageGlobComparison {
	const before = { include: parsePatterns(head.include), exclude: parsePatterns(head.exclude) };
	const after = { include: parsePatterns(proposed.include), exclude: parsePatterns(proposed.exclude) };
	for (const key of ["include", "exclude"] as const) {
		if ((head[key] !== null && before[key] === null) || (proposed[key] !== null && after[key] === null)) {
			return { kind: "undecidable", detail: `coverage.${key} has unsupported glob syntax or exceeds the ${MAX_PATTERNS}-pattern comparison budget` };
		}
	}
	if (patternsSubset(before.include, after.include) && patternsSubset(after.exclude, before.exclude)) return { kind: "nondecreasing" };
	if (before.include === null || before.exclude === null || after.include === null || after.exclude === null) {
		return { kind: "undecidable", detail: "absent include/exclude arrays use Vitest defaults, so effective path membership cannot be proved" };
	}
	const witness = findLostPath({ include: before.include, exclude: before.exclude }, { include: after.include, exclude: after.exclude });
	return witness === null
		? { kind: "undecidable", detail: "glob overlap could not be resolved within the bounded path comparison; no scope reduction was proved" }
		: { kind: "reduced", witness };
}
