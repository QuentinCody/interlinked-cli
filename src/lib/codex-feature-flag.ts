// ===========================================
// Codex CLI feature-flag writer (shared)
// ===========================================
// Codex hooks are gated by `[features] hooks = true` in
// `<scope>/.codex/config.toml`. The legacy key was `codex_hooks` and is
// still recognized by Codex but emits a deprecation warning ("`[features]
// .codex_hooks` is deprecated. Use `[features].hooks` instead."). We
// always write the canonical key; on any run we also migrate existing
// `codex_hooks = true` lines to `hooks = true` in place so the warning
// goes away after the next `interlinked enable`.
//
// Used by:
//   - the legacy installer in `./hook-installers.ts`
//     (called from `interlinked enable --clients codex`), and
//   - the modern adapter's `postInstall` in `../harness/adapters/codex.ts`
//     (called from `interlinked install-hooks --runner codex`).
//
// We do not parse TOML fully — we only detect the `[features]` table and
// whether `hooks = true` (canonical) or `codex_hooks = true` (legacy) is
// already present, with comments stripped. If neither is present we
// either insert the canonical key inside an existing `[features]` block
// or append a new one at EOF.
//
// We do, however, REFUSE on duplicate `[features]` TABLE headers. TOML forbids
// defining a table twice, so such a file is already invalid and Codex rejects
// it whole — no hooks fire. Collapsing the duplicate ASSIGNMENTS while leaving
// the duplicate HEADERS reported a successful install over an unparseable file,
// which is worse than not installing at all. Merging the tables is not a safe
// automatic repair (two blocks may hold the same key, trading a duplicate-table
// error for a duplicate-key one), so the writer changes nothing and prints how
// to fix it. See `findFeaturesTableHeaderLines`.
//
// Line endings: we split on "\n" and join on "\n", which leaves any "\r"
// attached to the line it terminates — so every byte we pass through
// round-trips exactly and a Windows (CRLF) config stays CRLF. Lines we ADD
// are terminated with the file's own dominant ending (`dominantCr`) so we
// never leave a user's config with mixed endings. See `stripTomlLineComment`
// for why the comment strip must not use `.` or `$`.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// The canonical key is detected by `findFeaturesAssignments`, which is
// table-aware; the document-wide regexes that used to do it are deleted rather
// than left as a second, wrong definition of the same question.
const HOOKS_DIR = ".codex";
const CONFIG_TOML = "config.toml";

/** What `<scope>/.codex/config.toml` says about the hooks feature flag. */
type CodexHooksFlagState =
	/** `hooks` (or legacy `codex_hooks`) is `true` inside `[features]`. */
	| "enabled"
	/** The key is present inside `[features]` but set to `false`. */
	| "disabled"
	/** No such key inside `[features]` — Codex leaves hooks off. */
	| "absent";

/** `[table]` / `[table.sub]` header, capturing the name. */
const TOML_TABLE_RE = /^\s*\[([^\][]+)\]\s*$/;
/** `hooks = <value>` or `codex_hooks = <value>`, comment already stripped. */
const HOOKS_ASSIGNMENT_RE = /^\s*(hooks|codex_hooks)\s*=\s*(\S+)/;
/** The only table Codex reads the flag from. */
const FEATURES_TABLE = "features";
/** Splits an assignment line into indent / key / separator / boolean value so
 *  the rewrite can swap the key and the value while preserving every other
 *  byte — indentation, the exact spacing around `=`, and a trailing comment
 *  (`hooks = true#note` needs the `\b` to stop the value at `true`). */
const ASSIGNMENT_REWRITE_RE = /^(\s*)(?:hooks|codex_hooks)(\s*=\s*)(?:true|false)\b/;
/** Prose in a file WE generated that names the pre-migration key. */
const LEGACY_COMMENT_RE = /do not remove the codex_hooks flag/g;
const CANONICAL_COMMENT_TEXT = "do not remove the hooks flag";

/**
 * Read the hooks flag with TABLE AWARENESS. Public API — the ONE reader both
 * `interlinked doctor` and `ensureCodexFeatureFlag` consult.
 *
 * The document-wide regexes this replaces answered "does the text contain
 * `hooks = true` anywhere?", so a file like
 *
 *     [other]
 *     hooks = true
 *
 *     [features]
 *     hooks = false
 *
 * reported ENABLED while Codex ran no hooks at all — doctor would show a green
 * row for a silently disabled install, which is worse than no check. Only
 * assignments inside `[features]` count, and the LAST one wins so an explicit
 * later `false` (or a second `[features]` table) is honored rather than
 * shadowed by the first match in file order.
 */
export function readCodexHooksFlag(tomlText: string): CodexHooksFlagState {
	const { canonical, legacy } = scanFeaturesTable(tomlText);
	// Codex honors either spelling, so "will hooks fire?" is answered by
	// whichever key is present; the canonical one wins when both are.
	return canonical !== "absent" ? canonical : legacy;
}

/**
 * The table this line declares (`"features"`, `"features.nested"`, …), or
 * `null` when the line is not a table header. The ONE header parse — both the
 * assignment scan and the duplicate-table detector use it, so they cannot
 * disagree about what counts as a header.
 *
 * The comment strip is load-bearing: `[features] # config` is a header, and a
 * scan that misses it once appended a SECOND `[features]` table.
 */
function tableNameOf(rawLine: string): string | null {
	const header = TOML_TABLE_RE.exec(stripTomlLineComment(rawLine));
	return header ? (header[1] ?? "").trim() : null;
}

/**
 * 1-based line numbers of every `[features]` TABLE HEADER in the document.
 *
 * Public API — the ONE duplicate-table detector. `ensureCodexFeatureFlag`
 * refuses to write when it returns more than one line, and it is exported so a
 * reporting surface (`interlinked doctor`) can name the same condition without
 * growing a second, differently-wrong scan of the same question.
 *
 * TOML forbids defining a table twice, so more than one entry here means the
 * file is already invalid and Codex rejects it whole — no hooks fire at all.
 * Dotted sub-tables (`[features.nested]`) are a DIFFERENT table and are legal
 * alongside `[features]`, so they are not counted; a commented-out header is
 * documentation and is not counted either.
 *
 * Line-based, like the rest of this module: a literal `[features]` line inside
 * a multi-line string would be counted. That is the known bound of not carrying
 * a full TOML parser, and it errs toward refusing rather than toward writing.
 */
export function findFeaturesTableHeaderLines(tomlText: string): number[] {
	const lines = tomlText.split("\n");
	const out: number[] = [];
	for (const [index, rawLine] of lines.entries()) {
		if (tableNameOf(rawLine) === FEATURES_TABLE) out.push(index + 1);
	}
	return out;
}

/** What the human must do, said before any reason. The writer prints this and
 *  changes nothing — the file is already unparseable, and editing it would put
 *  our line in the middle of the evidence. */
function duplicateFeaturesTableMessage(tomlPath: string, headerLines: readonly number[]): string {
	return (
		`[interlinked] REFUSED to enable Codex hooks: ${tomlPath} has duplicate [features] ` +
		`table headers at lines ${headerLines.join(", ")}.\n` +
		"[interlinked] Merge them into ONE [features] table (delete the later headers, move " +
		"their keys up), then re-run `interlinked enable`. The flag this would have set is " +
		"`hooks = true`.\n" +
		"[interlinked] TOML forbids defining a table twice, so Codex rejects this file whole " +
		"and NO hooks fire. The file was left untouched.\n"
	);
}

/** One active `hooks`/`codex_hooks` assignment inside a `[features]` table. */
interface FeaturesAssignment {
	/** Index into the `split("\n")` line array. */
	readonly index: number;
	readonly key: "hooks" | "codex_hooks";
	/** True when the value is exactly `true` — i.e. this line enables hooks. */
	readonly enabling: boolean;
}

/**
 * Every active hooks/codex_hooks assignment inside `[features]`, in file order.
 * The ONE table-aware scan — both the reader (`readCodexHooksFlag`) and the
 * writer (`canonicalizeFeaturesAssignments`) derive from it, so they cannot
 * disagree about which lines count.
 *
 * Assignments under any other table are invisible on purpose: Codex reads the
 * flag only from `[features]`, so a `hooks` line under `[other]` must neither
 * satisfy the writer nor be edited by it.
 */
function findFeaturesAssignments(lines: readonly string[]): FeaturesAssignment[] {
	const out: FeaturesAssignment[] = [];
	let table = "";
	for (const [index, rawLine] of lines.entries()) {
		const header = tableNameOf(rawLine);
		if (header !== null) {
			table = header;
			continue;
		}
		if (table !== FEATURES_TABLE) continue;
		const line = stripTomlLineComment(rawLine);
		const assignment = HOOKS_ASSIGNMENT_RE.exec(line);
		if (!assignment) continue;
		out.push({
			index,
			key: assignment[1] === "hooks" ? "hooks" : "codex_hooks",
			enabling: assignment[2] === "true",
		});
	}
	return out;
}

/** Table-aware state of each key inside `[features]`. Later assignments
 *  overwrite earlier ones, so an explicit `false` (or a second `[features]`
 *  table) is honored instead of being shadowed by file order. */
function scanFeaturesTable(tomlText: string): {
	canonical: CodexHooksFlagState;
	legacy: CodexHooksFlagState;
} {
	let canonical: CodexHooksFlagState = "absent";
	let legacy: CodexHooksFlagState = "absent";
	for (const assignment of findFeaturesAssignments(tomlText.split("\n"))) {
		const state: CodexHooksFlagState = assignment.enabling ? "enabled" : "disabled";
		if (assignment.key === "hooks") canonical = state;
		else legacy = state;
	}
	return { canonical, legacy };
}

/**
 * Public API — 1-based line numbers of every `hooks` / `codex_hooks`
 * assignment inside `[features]` tables. TOML forbids defining a key twice in
 * one table, so more than one entry PER KEY means the file is invalid and
 * Codex rejects it whole — while the last-wins assignment scan would still
 * read "enabled" (review 2026-08-28: doctor printed a green row for an inert
 * install). Exported for `interlinked doctor`, mirroring
 * {@link findFeaturesTableHeaderLines} for the duplicate-TABLE case.
 */
export function findFeaturesHooksAssignmentCounts(tomlText: string): { hooks: number; codex_hooks: number } {
	const counts = { hooks: 0, codex_hooks: 0 };
	for (const assignment of findFeaturesAssignments(tomlText.split("\n"))) {
		if (assignment.key === "hooks") counts.hooks++;
		else counts.codex_hooks++;
	}
	return counts;
}

type EnsureFeatureFlagAction =
	/** Wrote a fresh file (none existed). */
	| "created"
	/** Appended a `[features]` block / inserted `hooks = true` into an existing one. */
	| "appended"
	/** Replaced legacy `codex_hooks = true` with canonical `hooks = true`. */
	| "migrated"
	/** Canonical `hooks = true` already present; file untouched. */
	| "preserved"
	/** FAILURE. The config has duplicate `[features]` table headers, so it is
	 *  already invalid TOML and Codex rejects it whole. Nothing was written and
	 *  a repair message was printed — never report this as a successful install. */
	| "refused";

/**
 * Public API — consumed by `./hook-installers.ts` and
 * `../harness/adapters/codex.ts`.
 *
 * Idempotently ensure `<base>/.codex/config.toml` enables hooks via the
 * canonical `[features] hooks = true` key. Migrates legacy `codex_hooks`
 * entries silently. Returns an action descriptor for the caller's logging.
 *
 * **`"refused"` is a FAILURE, not a variety of success.** It means the config
 * has duplicate `[features]` table headers — already invalid TOML, which Codex
 * rejects whole, so no hook fires. Nothing was written and a repair message went
 * to stderr. A caller that reports installs per client must not count a
 * `"refused"` run as a working Codex install.
 *
 * `base` is the directory containing `.codex/`. For project scope pass
 * the repo root; for user scope pass the user's home directory.
 */
export function ensureCodexFeatureFlag(base: string): EnsureFeatureFlagAction {
	const tomlPath = join(base, HOOKS_DIR, CONFIG_TOML);
	const dir = dirname(tomlPath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	if (!existsSync(tomlPath)) {
		writeFileSync(
			tomlPath,
			"# Generated by interlinked enable — do not remove the hooks flag\n" +
				"# unless you intend to disable Interlinked CLI hooks for Codex.\n" +
				"\n[features]\nhooks = true\n",
		);
		return "created";
	}

	const existing = readFileSync(tomlPath, "utf-8");

	// Duplicate `[features]` TABLE headers make the whole document invalid TOML,
	// so Codex parses NONE of it and every hook stays off. Canonicalizing the
	// duplicate ASSIGNMENTS while leaving the duplicate HEADERS reported
	// "appended"/"migrated" over a file no parser accepts — a green install with
	// dead hooks, which is strictly worse than no install. Merging the tables is
	// not a safe automatic repair either: two blocks may hold the same key, so
	// the merge would trade a duplicate-table error for a duplicate-key one.
	// Refuse, change nothing, and say how to fix it.
	const duplicateHeaders = findFeaturesTableHeaderLines(existing);
	if (duplicateHeaders.length > 1) {
		process.stderr.write(duplicateFeaturesTableMessage(tomlPath, duplicateHeaders));
		return "refused";
	}

	// Canonicalize first: when `[features]` already holds ANY hooks/codex_hooks
	// assignment, the end state must be exactly ONE of them, spelled `hooks`,
	// valued `true`. The previous writer bolted a canonical key on beside what
	// it found, so `[features] hooks = false` + `codex_hooks = true` produced
	// TWO `hooks` keys while reporting "migrated". Strict TOML parsers REJECT a
	// duplicate key, so that "successful" migration could disable Codex hooks
	// outright.
	const canonicalized = canonicalizeFeaturesAssignments(existing);
	if (canonicalized) {
		if (canonicalized.text === existing) return "preserved";
		writeFileSync(tomlPath, canonicalized.text);
		return canonicalized.action;
	}

	// No assignment inside `[features]` at all — insert one.
	const updatedExistingFeatures = insertIntoExistingFeaturesBlock(existing);
	if (updatedExistingFeatures !== null) {
		writeFileSync(tomlPath, updatedExistingFeatures);
		return "appended";
	}

	// No [features] block yet — append a fresh one at EOF, terminated the same
	// way the rest of the file is so a CRLF config does not end up mixed.
	const eol = `${dominantCr(existing)}\n`;
	const sep = existing.endsWith("\n") ? "" : eol;
	const block = ["", "# Added by interlinked", "[features]", "hooks = true", ""].join(eol);
	writeFileSync(tomlPath, `${existing}${sep}${block}`);
	return "appended";
}

/**
 * The carriage return that terminates this file's lines: `"\r"` when CRLF
 * endings are the majority, `""` otherwise. Because we join lines with `"\n"`,
 * appending this to a line we author is what makes it CRLF.
 *
 * Ties go to `""` (LF) — that matches the ending we use for a file we create,
 * so an ambiguous file is nudged toward the one we'd have written ourselves.
 */
function dominantCr(content: string): "\r" | "" {
	// Counted via split rather than `match(…) ?? []` so a file with no newline
	// at all is just a 1-element split, not a null needing a fallback.
	const newlines = content.split("\n").length - 1;
	const crlf = content.split("\r\n").length - 1;
	// The remaining `newlines - crlf` terminators are bare LF.
	return crlf > newlines - crlf ? "\r" : "";
}

/**
 * Rewrite one assignment line into the canonical `hooks = true`, keeping every
 * byte the key and the value do not occupy: indentation, the author's spacing
 * around `=`, and any trailing comment. `codex_hooks=true#legacy` becomes
 * `hooks=true#legacy`.
 *
 * A value the writer does not recognize as a boolean (`hooks = "yes"`) has no
 * safe in-place rewrite, so the whole line is replaced — carrying its `\r` so a
 * CRLF file does not acquire one lone LF line.
 */
function canonicalizeAssignmentLine(line: string): string {
	if (ASSIGNMENT_REWRITE_RE.test(line)) {
		return line.replace(ASSIGNMENT_REWRITE_RE, "$1hooks$2true");
	}
	return line.endsWith("\r") ? "hooks = true\r" : "hooks = true";
}

/**
 * Which of the `[features]` assignments becomes the single canonical one.
 *
 * Prefer an ENABLING line, so the flag Codex ends up honoring came from the
 * user's own `= true` rather than from a value this writer flipped; among
 * equals, prefer the canonical spelling and then file order, which keeps the
 * surviving line where the user put it.
 */
function chooseSurvivingAssignment(assignments: readonly FeaturesAssignment[]): FeaturesAssignment {
	const enabling = assignments.find((a) => a.enabling);
	if (enabling) {
		const canonicalEnabling = assignments.find((a) => a.enabling && a.key === "hooks");
		return canonicalEnabling ?? enabling;
	}
	const canonical = assignments.find((a) => a.key === "hooks");
	return canonical ?? nonNullAssignment(assignments[0]);
}

/** Callers only reach this with a non-empty list; narrow without `!`. */
function nonNullAssignment(value: FeaturesAssignment | undefined): FeaturesAssignment {
	if (!value) throw new Error("codex-feature-flag: empty assignment list");
	return value;
}

/**
 * Collapse every hooks/codex_hooks assignment inside `[features]` into exactly
 * ONE canonical `hooks = true`, and report what that cost.
 *
 * Returns `null` when there is no such assignment — the caller then inserts one
 * (that path is unchanged and still owns block placement + EOF append).
 *
 * The duplicate-key class this closes: `[features] hooks = false` plus a legacy
 * `codex_hooks = true` used to produce `hooks = false` AND `hooks = true` in the
 * same table. Strict TOML parsers reject a duplicate key outright, so the
 * "migrated" report described a config that could disable Codex hooks. Only
 * `[features]` is touched — a `hooks` line under any other table is none of
 * this writer's business.
 */
function canonicalizeFeaturesAssignments(
	existing: string,
): { text: string; action: EnsureFeatureFlagAction } | null {
	const lines = existing.split("\n");
	const assignments = findFeaturesAssignments(lines);
	if (assignments.length === 0) return null;

	const survivor = chooseSurvivingAssignment(assignments);
	const dropped = new Set(
		assignments.filter((a) => a.index !== survivor.index).map((a) => a.index),
	);

	const out: string[] = [];
	for (const [index, line] of lines.entries()) {
		if (dropped.has(index)) continue;
		out.push(index === survivor.index ? canonicalizeAssignmentLine(line) : line);
	}

	// Our own generated comment names the pre-migration key. Rewrite it only
	// when a legacy key was actually there, so a file that merely already said
	// `hooks = true` still round-trips byte for byte and reports "preserved".
	const hadLegacy = assignments.some((a) => a.key === "codex_hooks");
	const joined = out.join("\n");
	const text = hadLegacy ? joined.replace(LEGACY_COMMENT_RE, CANONICAL_COMMENT_TEXT) : joined;

	// "migrated" means an EXISTING enabling assignment survived as the canonical
	// key. When none existed, this writer supplied the `true` itself — that is
	// the same act as inserting the flag, so it reports "appended" and a legacy
	// `codex_hooks = false` still never counts as a successful migration.
	return { text, action: survivor.enabling ? "migrated" : "appended" };
}

function insertIntoExistingFeaturesBlock(existing: string): string | null {
	const lines = existing.split("\n");
	let featuresStart = -1;
	let featuresEnd = lines.length;

	for (const [i, rawLine] of lines.entries()) {
		const normalized = stripTomlLineComment(rawLine).trim();
		if (!normalized.startsWith("[") || !normalized.endsWith("]")) continue;

		if (featuresStart === -1 && normalized === "[features]") {
			featuresStart = i;
			continue;
		}

		if (featuresStart !== -1) {
			featuresEnd = i;
			break;
		}
	}

	if (featuresStart === -1) return null;

	const before = lines.slice(0, featuresEnd);
	const after = lines.slice(featuresEnd);
	// Carry the file's own terminator so inserting into a CRLF config does not
	// leave one lone LF line in the middle of it — but only when the join will
	// actually put a "\n" after our line. A trailing "\r" with no "\n" is a bare
	// CR, which TOML does not accept as a newline.
	const cr = after.length > 0 ? dominantCr(existing) : "";
	before.push(`hooks = true${cr}`);
	return [...before, ...after].join("\n");
}

/**
 * Remove a TOML line comment (`#` to end of line) for DETECTION purposes. The
 * result is only ever tested/trimmed, never written back, so eating the line's
 * trailing terminator along with the comment is harmless.
 *
 * `[^\n]*` rather than `.*$` is load-bearing. JS `.` excludes all four line
 * terminators (\n, \r, U+2028, U+2029) and `$` without /m anchors at true
 * end-of-string, so on a CRLF file — where splitting on "\n" leaves a trailing
 * "\r" on every line — `/#.*$/` could never match and the comment survived the
 * "strip". A commented-out `# hooks = true` then read as ENABLED, a legacy key
 * inside a comment got rewritten, and `[features] # cfg` stopped looking like a
 * table header (so a duplicate `[features]` table was appended). U+2028/U+2029
 * are not line breaks in TOML, so consuming them here is also the correct read.
 */
function stripTomlLineComment(line: string): string {
	return line.replace(/#[^\n]*/, "");
}
