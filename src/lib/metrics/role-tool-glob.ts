/**
 * The glob subset that the linter-exclude reader applies. A pattern is relative to the directory of the config file that holds it.
 * Supported: `*` (inside one segment), `**` (across segments), `?`, `[a-z]` / `[!a-z]`, one level of `{a,b}`, a leading `./` or `/`,
 * a trailing `/` (directories only) and a leading `!` (negation, last match wins). Not supported, and reported instead of guessed:
 * extended globs (`@(..)`, `+(..)`, `!(..)`, `?(..)`, `*(..)`), nested braces and an empty pattern.
 * A pattern covers a path when it matches the path or any ancestor directory of the path (the tools skip a whole excluded directory).
 */
export type GlobMode = "any-depth" | "anchored";

export interface GlobRule {
	source: string;
	negated: boolean;
	/** Matches a whole path prefix, `a`, `a/b` or `a/b/c.py`. */
	regex: RegExp;
	directoryOnly: boolean;
}
export type CompiledGlob = GlobRule | { unsupported: string };

const EXTGLOB = /[@+!?*]\(/;

function expandClass(body: string): string {
	const negate = body.startsWith("!") || body.startsWith("^");
	const inner = (negate ? body.slice(1) : body).replace(/[\\\]]/g, "\\$&");
	return `[${negate ? "^" : ""}${inner}]`;
}

interface Step { out: string; next: number; braces: number; }

/** A single star or a double star at `i`. A double star plus slash that starts a segment spans whole segments; any other double star spans anything. */
function starStep(glob: string, i: number): Omit<Step, "braces"> {
	if (glob[i + 1] !== "*") return { out: "[^/]*", next: i + 1 };
	const startsSegment = i === 0 || glob[i - 1] === "/";
	return glob[i + 2] === "/" && startsSegment ? { out: "(?:[^/]+/)*", next: i + 3 } : { out: ".*", next: i + 2 };
}

function classStep(glob: string, i: number): Omit<Step, "braces"> {
	const close = glob.indexOf("]", i + 2);
	return close === -1 ? { out: "\\[", next: i + 1 } : { out: expandClass(glob.slice(i + 1, close)), next: close + 1 };
}

const SIMPLE: Readonly<Record<string, string>> = { "?": "[^/]" };

/** The regex text for the character at `i`, or an unsupported reason. */
function stepAt(glob: string, i: number, braces: number): Step | { unsupported: string } {
	const c = glob[i] ?? "";
	if (c === "*") return { ...starStep(glob, i), braces };
	if (c === "[") return { ...classStep(glob, i), braces };
	if (c === "{") return braces > 0 ? { unsupported: "nested-braces" } : { out: "(?:", next: i + 1, braces: 1 };
	if (c === "}" && braces === 1) return { out: ")", next: i + 1, braces: 0 };
	if (c === "," && braces === 1) return { out: "|", next: i + 1, braces };
	if (c === "\\" && i + 1 < glob.length) return { out: `\\${glob[i + 1]}`, next: i + 2, braces };
	return { out: SIMPLE[c] ?? c.replace(/[.+^$()|\\]/g, "\\$&"), next: i + 1, braces };
}

/** Convert the glob body (no leading `!`, `/`, no trailing `/`) to a regex source, or name the unsupported syntax. */
function globToRegex(glob: string): { regex: string } | { unsupported: string } {
	if (EXTGLOB.test(glob)) return { unsupported: "extglob" };
	let out = "", braces = 0, i = 0;
	while (i < glob.length) {
		const step = stepAt(glob, i, braces);
		if ("unsupported" in step) return step;
		out += step.out; i = step.next; braces = step.braces;
	}
	return braces === 0 ? { regex: out } : { unsupported: "unbalanced-braces" };
}

/** Compile one pattern string. `any-depth`: a pattern without a slash matches a component at any depth (gitignore, ruff, flake8). */
export function compileGlob(raw: string, mode: GlobMode): CompiledGlob {
	let text = raw.trim();
	const negated = text.startsWith("!");
	if (negated) text = text.slice(1);
	const directoryOnly = text.endsWith("/");
	if (directoryOnly) text = text.replace(/\/+$/, "");
	text = text.replace(/^(?:\.\/)+/, "");
	const leadingSlash = text.startsWith("/");
	if (leadingSlash) text = text.replace(/^\/+/, "");
	if (text === "") return { unsupported: "empty" };
	const converted = globToRegex(text);
	if ("unsupported" in converted) return converted;
	const anywhere = mode === "any-depth" && !leadingSlash && !text.includes("/");
	const regex = new RegExp(`^${anywhere ? "(?:.*/)?" : ""}${converted.regex}$`);
	return { source: raw.trim(), negated, regex, directoryOnly };
}

/**
 * The rule that excludes `path` (relative to the config directory), or null. Rules run in order: a matching positive rule excludes,
 * a later matching negated rule re-includes. A negation re-includes even below an excluded directory (fewer paths excluded, never more).
 */
export function matchesRules(rules: readonly GlobRule[], path: string): GlobRule | null {
	const parts = path.split("/");
	let excludedBy: GlobRule | null = null;
	for (const rule of rules) {
		const hit = parts.some((_, index) => {
			const isDirectory = index < parts.length - 1;
			if (rule.directoryOnly && !isDirectory) return false;
			return rule.regex.test(parts.slice(0, index + 1).join("/"));
		});
		if (!hit) continue;
		excludedBy = rule.negated ? null : rule;
	}
	return excludedBy;
}
