// ===========================================
// Sanitizer Registry — Per-sink-class sanitizer / validator patterns
// ===========================================
// Project-extensible JSON registry consumed by tainted-flow detectors
// (currently `checks/tainted-sink.ts`; later by the endpoint-security
// pack in Phase B). Replaces the inline `VALIDATOR_PATTERNS` array that
// previously lived inside `checks/tainted-sink.ts` so projects can extend
// per-sink-class sanitizer recognition via `.interlinked/sanitizers.json`
// without touching code.
//
// File layout (mirrors `guard-rules.json` / `guard-rules.local.json`):
//
//   .interlinked/sanitizers.json        — committed, team-shared defaults
//   .interlinked/sanitizers.local.json  — gitignored, per-developer overrides
//
// Per-sink-class schema:
//
//   {
//     "version": 1,
//     "sanitizers": {
//       "sql":      [Entry, ...],
//       "html":     [Entry, ...],
//       "shell":    [Entry, ...],
//       "url":      [Entry, ...],
//       "identity": [Entry, ...]
//     }
//   }
//
// Each Entry = { name, kind: "function"|"method"|"regex", pattern, scope? }.
//
// - `function`: matches a bare-name call `foo(...)`. Pattern is the function
//   name (e.g. "escape", "DOMPurify.sanitize"). Compiled to a regex that
//   refuses dotted prefixes for unqualified names ("escape" matches `escape(`
//   but not `someEscape(` or `obj.escape(`) and exact-segment-matches for
//   dotted names ("DOMPurify.sanitize" matches `DOMPurify.sanitize(`).
// - `method`: matches a method call `.foo(...)`. Pattern is the method name
//   sans dot (e.g. "parse"). Compiled to `\.<name>\s*\(`.
// - `regex`: pattern is a JS regex source string, used verbatim.
//
// `scope` is reserved for module-scoped sanitizers (e.g. "marked is only a
// sanitizer when called from module X"). Default "global" — matches anywhere.
//
// Hot-reload mirrors `rules-loader.ts::watchRulesFiles`: both the team and
// the local file are watched via `node:fs.watchFile` and a reload callback
// re-runs the merged load.
//
// The `INTERLINKED_SKIP_SANITIZER_OVERRIDES=1` env var skips the local
// override layer (used by tests that need deterministic defaults).
//
// Migration provenance: the initial `identity` defaults were ported
// verbatim from the `VALIDATOR_PATTERNS` list at
// `src/harness/checks/tainted-sink.ts:47-61` (pre-A1). The migration
// preserves every existing tainted-sink test answer.

import { existsSync, readFileSync, unwatchFile, watchFile } from "node:fs";
import { join } from "node:path";

/** Sink class — the kind of sink a sanitizer covers. */
type SinkClass = "sql" | "html" | "shell" | "url" | "identity";

/** All sink classes in declaration order. */
export const SINK_CLASSES: readonly SinkClass[] = [
	"sql",
	"html",
	"shell",
	"url",
	"identity",
] as const;

/** Kind discriminator for a sanitizer entry. */
type SanitizerKind = "function" | "method" | "regex";

/**
 * Named constants for `SanitizerKind` so call-sites read as intent rather
 * than as bare string literals. Declared with `as const` so they narrow to
 * their literal type — needed for the `validateEntry` discriminator check
 * to preserve the discriminated-union narrowing.
 *
 * Public API: re-exported for downstream tainted-sink detectors that build
 * registry entries programmatically (Phase B endpoint-security pack).
 */
export const SANITIZER_KIND_FUNCTION = "function" as const;
export const SANITIZER_KIND_METHOD = "method" as const;
export const SANITIZER_KIND_REGEX = "regex" as const;

/**
 * Named constant for the global / "applies-everywhere" scope sentinel.
 * Public API — re-exported for the same reason as the kind constants above.
 */
export const SCOPE_GLOBAL = "global" as const;

/** One sanitizer entry (validated, post-load shape). */
interface SanitizerEntry {
	name: string;
	kind: SanitizerKind;
	pattern: string;
	/** "global" (default) or a module specifier (e.g. "marked"). */
	scope: string;
	/** Human-readable note from the JSON — for tooling, not matching. */
	description?: string | undefined;
	/** Compiled regex — derived from `pattern` + `kind`. */
	compiled: RegExp;
}

/** Loaded registry — keyed by sink class. */
export interface SanitizerRegistry {
	version: number;
	sanitizers: Record<SinkClass, SanitizerEntry[]>;
}

/** Raw entry shape as it appears in the JSON file (pre-validation). */
interface RawEntry {
	name?: unknown;
	kind?: unknown;
	pattern?: unknown;
	scope?: unknown;
	description?: unknown;
}

/** Raw file shape as it appears on disk (pre-validation). The `sanitizers`
 * map holds per-sink-class arrays of `RawEntry`-shaped values; each entry
 * is validated downstream and untrusted ones are dropped. */
interface RawRegistry {
	version?: unknown;
	sanitizers?: { [K in SinkClass]?: RawEntry[] };
}

/** Compile an entry's pattern according to its kind. */
function compileEntry(kind: SanitizerKind, pattern: string): RegExp {
	if (kind === SANITIZER_KIND_REGEX) {
		// `regex` is taken verbatim. Caller-supplied regex syntax.
		return new RegExp(pattern);
	}
	if (kind === SANITIZER_KIND_METHOD) {
		// Method call: `.<name>(`. Allow the name to be a regex-escaped
		// identifier — methods are simple names by convention.
		const safe = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		return new RegExp(String.raw`\.${safe}\s*\(`);
	}
	// kind === SANITIZER_KIND_FUNCTION — bare or dotted call. For `escape`
	// (no dot) we refuse a dotted prefix so `obj.escape(` doesn't match;
	// for `DOMPurify.sanitize` we anchor both segments.
	const segments = pattern.split(".").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	if (segments.length === 1) {
		// Unqualified: must not have a `.` or word-char before the name.
		return new RegExp(String.raw`(?<![\w.$])${segments[0]}\s*\(`);
	}
	// Qualified: exact-segment match.
	const dotted = segments.join(String.raw`\.`);
	return new RegExp(String.raw`(?<![\w$])${dotted}\s*\(`);
}

/** Default empty-but-valid registry. */
function emptyRegistry(): SanitizerRegistry {
	return {
		version: 1,
		sanitizers: {
			sql: [],
			html: [],
			shell: [],
			url: [],
			identity: [],
		},
	};
}

/**
 * Public API — validate and coerce a raw parsed JSON object into a typed
 * `SanitizerRegistry`. Unknown keys at the top level are ignored. Invalid
 * entries are dropped silently; the function never throws so a malformed
 * registry never bricks the daemon.
 *
 * This is a pure function — no file I/O. Consumed by `load()` and
 * directly by the tests.
 */
export function validate(raw: unknown): SanitizerRegistry {
	const out = emptyRegistry();
	if (!raw || typeof raw !== "object") return out;
	const r = raw as RawRegistry;
	if (typeof r.version === "number") out.version = r.version;
	const sanitizers = r.sanitizers;
	if (!sanitizers || typeof sanitizers !== "object") return out;
	for (const cls of SINK_CLASSES) {
		const raw_entries = sanitizers[cls];
		if (!Array.isArray(raw_entries)) continue;
		const compiled: SanitizerEntry[] = [];
		for (const raw_entry of raw_entries) {
			const validated = validateEntry(raw_entry);
			if (validated) compiled.push(validated);
		}
		out.sanitizers[cls] = compiled;
	}
	return out;
}

/** Validate one entry. Returns null if invalid. */
function validateEntry(raw: unknown): SanitizerEntry | null {
	if (!raw || typeof raw !== "object") return null;
	const e = raw as RawEntry;
	const name = typeof e.name === "string" ? e.name : null;
	const kind =
		e.kind === SANITIZER_KIND_FUNCTION ||
		e.kind === SANITIZER_KIND_METHOD ||
		e.kind === SANITIZER_KIND_REGEX
			? e.kind
			: null;
	const pattern = typeof e.pattern === "string" ? e.pattern : null;
	if (!name || !kind || !pattern) return null;
	const scope = typeof e.scope === "string" ? e.scope : SCOPE_GLOBAL;
	const description = typeof e.description === "string" ? e.description : undefined;
	let compiled: RegExp;
	try {
		compiled = compileEntry(kind, pattern);
	} catch {
		// Invalid regex syntax — drop the entry.
		return null;
	}
	return { name, kind, pattern, scope, description, compiled };
}

/** Deep-merge override entries on top of base entries.
 *
 * Override semantics: an override entry replaces a base entry with the same
 * `name`+`scope` pair; otherwise it appends. This lets `.local.json` either
 * extend or surgically override committed defaults.
 */
function mergeRegistry(
	base: SanitizerRegistry,
	override: SanitizerRegistry,
): SanitizerRegistry {
	const merged = emptyRegistry();
	merged.version = override.version || base.version;
	for (const cls of SINK_CLASSES) {
		const base_entries = base.sanitizers[cls] || [];
		const override_entries = override.sanitizers[cls] || [];
		const by_key = new Map<string, SanitizerEntry>();
		for (const e of base_entries) {
			by_key.set(`${e.name}|${e.scope}`, e);
		}
		for (const e of override_entries) {
			by_key.set(`${e.name}|${e.scope}`, e);
		}
		merged.sanitizers[cls] = Array.from(by_key.values());
	}
	return merged;
}

/** Path of the team-shared (committed) sanitizers file. */
export function teamSanitizersPath(cwd: string): string {
	return join(cwd, ".interlinked", "sanitizers.json");
}

/** Path of the local (gitignored) per-developer override file. */
export function localSanitizersPath(cwd: string): string {
	return join(cwd, ".interlinked", "sanitizers.local.json");
}

/** Read + JSON-parse a sanitizers file. Returns null on missing/malformed. */
function readSanitizersFile(path: string): unknown | null {
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		// Best-effort: malformed JSON → treat as absent so the daemon doesn't
		// brick on a hand-edit typo. The verify command will surface the parse
		// error separately when wired up in a later phase.
		return null;
	}
}

/**
 * Public API — main entry point. Loads the team config, deep-merges the
 * local override (if present), validates, and returns the compiled
 * registry. Returns an empty-but-valid registry if neither file exists.
 *
 * Skips the local override when `INTERLINKED_SKIP_SANITIZER_OVERRIDES=1`
 * (for deterministic tests).
 */
export function load(cwd: string = process.cwd()): SanitizerRegistry {
	const teamRaw = readSanitizersFile(teamSanitizersPath(cwd));
	const teamReg = validate(teamRaw);
	const skipOverride = process.env.INTERLINKED_SKIP_SANITIZER_OVERRIDES === "1";
	if (skipOverride) return teamReg;
	const localRaw = readSanitizersFile(localSanitizersPath(cwd));
	if (localRaw === null) return teamReg;
	const localReg = validate(localRaw);
	return mergeRegistry(teamReg, localReg);
}

/** Options for `isSanitized` scope filtering. Trailing struct so call-sites
 * read as intent (`{ currentModule: "marked" }`) rather than the order of
 * two same-typed string positional args. */
interface IsSanitizedOptions {
	/** Optional module specifier — when supplied, module-scoped entries
	 * apply only when their `scope` matches this string. Module-scoped
	 * entries are skipped when this is `undefined`. */
	currentModule?: string;
}

/**
 * Public API — predicate. Returns true iff the expression matches any
 * compiled sanitizer entry for the given sink class.
 *
 * Scope filtering: an entry's `scope` is matched against the optional
 * `opts.currentModule`. `SCOPE_GLOBAL` entries always apply; module-scoped
 * entries apply only when `opts.currentModule` matches the entry's `scope`.
 * Omit `opts` (or pass `{}`) to treat all entries as global.
 */
export function isSanitized(
	registry: SanitizerRegistry,
	sinkClass: SinkClass,
	expression: string,
	opts: IsSanitizedOptions = {},
): boolean {
	const entries = registry.sanitizers[sinkClass];
	if (!entries || entries.length === 0) return false;
	const { currentModule } = opts;
	for (const entry of entries) {
		if (
			entry.scope !== SCOPE_GLOBAL &&
			currentModule !== undefined &&
			entry.scope !== currentModule
		) {
			continue;
		}
		if (entry.compiled.test(expression)) return true;
	}
	return false;
}

/**
 * Public API — hot-reload watcher. Mirrors `rules-loader.ts::watchRulesFiles`.
 * Polls both the team and local file every 2s; calls `onReload` with a
 * freshly loaded registry whenever either changes. Returns a cleanup
 * function that removes both watchers.
 */
export function watchSanitizerFiles(
	cwd: string,
	onReload: (registry: SanitizerRegistry) => void,
): () => void {
	const teamPath = teamSanitizersPath(cwd);
	const localPath = localSanitizersPath(cwd);
	const WATCH_POLL_INTERVAL_MS = 2_000;
	const reload = (): void => {
		try {
			onReload(load(cwd));
		} catch (_err) {
			/* intentional: best-effort hot-reload — swallow errors */
		}
	};
	const watchedPaths = [teamPath, localPath];
	for (const path of watchedPaths) {
		watchFile(path, { interval: WATCH_POLL_INTERVAL_MS }, reload);
	}
	return () => {
		for (const path of watchedPaths) {
			unwatchFile(path, reload);
		}
	};
}
