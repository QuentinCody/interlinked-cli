// ===========================================
// Large-file policy — the single source of truth for the per-file line cap
// ===========================================
// One module, consumed by three surfaces:
//   - PreToolUse  : `checkLargeFileLineCountWrite` (pre-checks.ts) blocks a
//                   Write/Edit that grows a capped file past the cap.
//   - PostToolUse : the `[interlinked:file-size]` nudge (evaluator/post-tool.ts).
//   - verify      : the `large_files` check (commands/verify/file-checks.ts).
//
// The cap applies only to HAND-WRITTEN CODE MODULES. Generated files, .d.ts
// declarations, test/spec files, and non-code files (docs, structured data,
// lockfiles, vector art) are exempt — a high line count there is not a
// code-legibility signal.
//
// The active cap and the grandfather list live in a checked-in JSON file,
// `.interlinked/large-files-baseline.json`, so lowering the cap over time
// (1500 -> 1200 -> 1000 -> 800 as the grandfather list empties) is a one-number
// edit, not a code change.

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

import { isGeneratedFile, isTestSourcePath } from "./checks/shared.js";
import { maxLinesOverride } from "./metric-caps.js";

/**
 * Default per-file line cap, used when no baseline file overrides it.
 *
 * THE canonical cap. This constant and the committed baseline's `max_lines`
 * (.interlinked/large-files-baseline.json) are the SAME number — a regression
 * test in `large-file-policy.test.ts` pins them equal so the cap can never be
 * two different values depending on whether a baseline loaded. `maxLinesFor`
 * returns the baseline value when present and falls back to this constant when
 * absent; keeping them equal means the fallback is never a *different* cap.
 *
 * Line count is a coarse proxy for the real cost — agent legibility and edit
 * reliability — so the cap sits above the ~300-500 line aspirational module
 * size: a gate that false-alarms gets ignored. The fine-grained `complexity` /
 * `cyclomatic` checks do the nuanced "is this file actually bad" work. To
 * ratchet the cap down (800 → 500 → …) as the grandfather list shrinks,
 * change BOTH this constant and the baseline's `max_lines` together — the
 * pinning test enforces it and the change shows up in one diff.
 */
export const DEFAULT_MAX_LINES = 500;

/** Repo-relative path of the baseline file. Module-private — callers go
 *  through `loadLargeFileBaseline` / `maxLinesFor`. */
const LARGE_FILE_BASELINE_REL = ".interlinked/large-files-baseline.json";

/**
 * Extensions where a high line count is not a code-legibility problem:
 * prose/docs, markup documents, structured data, lockfiles, vector art,
 * minified bundles. HTML sits here because an .html file is a document —
 * a self-contained artifact/report/template whose length measures content,
 * not module complexity, and "decompose into modules" isn't a remedy that
 * applies to a page (same reasoning as markdown and svg).
 * Module-private — reached via `isCappableFile`.
 */
const FILE_SIZE_SKIP_EXT_RE =
	/\.(?:md|mdx|markdown|txt|rst|adoc|html?|xhtml|xml|xsd|xsl|xslt|json|jsonc|json5|jsonl|ndjson|ya?ml|toml|csv|tsv|lock|log|diff|patch|svg|min\.[a-z]+)$/i;

/**
 * Path markers for generated code: a `.gen.`/`.generated.` infix on a
 * source file, or a `generated/` / `__generated__/` directory segment.
 * Module-private — reached via `isCappableFile`.
 */
const GENERATED_PATH_RE =
	/(?:\.gen|\.generated)\.(?:tsx?|jsx?|mjs|cjs|py)$|\/(?:generated|__generated__)\//;

/** Dependency source checked into the repository is not hand-written product code. */
const VENDORED_PATH_RE = /(?:^|\/)(?:vendor|vendored|third[-_]party)(?:\/|$)/i;

/** Documentation trees and configuration artifacts are not product source modules. */
const DOCUMENTATION_PATH_RE = /(?:^|\/)(?:docs?|documentation)(?:\/|$)/i;
const CONFIG_ARTIFACT_RE = /(?:^|\/)\.env(?:\.[^/]*)?$|\.(?:ini|cfg|conf|properties)$/i;
const NON_PRODUCT_TREE_RE =
	/(?:^|\/)(?:node_modules|dist|build|coverage|target|__pycache__|\.venv|venv|\.claude|\.codex)(?:\/|$)/i;
const BINARY_ARTIFACT_RE =
	/\.(?:png|jpe?g|gif|webp|avif|ico|bmp|tiff|heic|mp3|mp4|wav|ogg|webm|m4a|mov|flac|avi|mkv|woff2?|ttf|otf|eot|zip|tar|gz|tgz|bz2|7z|rar|xz|lz4|zst|exe|dll|so|dylib|bin|class|pyc|pyo|wasm|a|lib|obj|o|node|pdf|psd|ai|sketch|fig|iso|dmg|img)$/i;
const NON_CODE_BASENAMES = new Set([
	"package-lock.json",
	"yarn.lock",
	"pnpm-lock.yaml",
	"npm-shrinkwrap.json",
	"Cargo.lock",
	"poetry.lock",
	"Pipfile.lock",
	"composer.lock",
	"Gemfile.lock",
	"go.sum",
]);

function isNonProductArtifactPath(norm: string): boolean {
	if (NON_PRODUCT_TREE_RE.test(norm)) return true;
	if (BINARY_ARTIFACT_RE.test(norm)) return true;
	return NON_CODE_BASENAMES.has(basename(norm));
}

/**
 * The harness's own state directory. `.interlinked/` holds append-only logs,
 * the trigram index, archives, merge-patches, e2e probe scripts, and workflow
 * scratch — tool state and operational scripts, never product source modules.
 * A line/char count there measures an artifact, not module complexity, so the
 * cap never applies (the same reasoning that exempts `.git/`, `node_modules/`,
 * `dist/`). Matches a real `.interlinked/` path segment only — an ordinary
 * `interlinked/` source dir (no leading dot) stays cappable.
 */
const TOOL_STATE_PATH_RE = /(?:^|\/)\.interlinked\//;

/**
 * The repo-provisioned probe directory, ROOT-LEVEL `scratch/` only
 * (`interlinked scratch init` creates it: gitignored, `.ignore`-negated,
 * README'd as the sanctioned home for agent probe/draft scripts — the very
 * place `scratchpad-write-guard` REDIRECTS agent-authored code to). It is
 * non-product by construction, so the product-health surfaces that consume
 * this predicate — line cap, cyclomatic gates, coverage targeting, the
 * tested-file floor, debt focus — do not govern it; per-file quality checks
 * (tsc, lint, secrets) still run there. Root-level only: a nested
 * `src/scratch/` is somebody's product module and stays governed. Without
 * this, two gates disagreed about the same path — the scratchpad guard
 * steered a probe INTO `scratch/` and the debt focus rule then blocked the
 * write there as "moving to an unrelated file", pushing a compliant agent
 * toward harness-invisible channels (observed live 2026-07-17). Exported for
 * direct tests; reach it through `isCappableFile` everywhere else.
 */
export function isRepoScratchPath(normPath: string, root: string | undefined): boolean {
	if (/^scratch\//.test(normPath)) return true;
	if (root === undefined) return false;
	const normRoot = resolve(root).replace(/\\/g, "/").replace(/\/$/, "");
	return normPath.startsWith(`${normRoot}/scratch/`);
}

/** Per-file line cap config + grandfather list. */
export interface LargeFileBaseline {
	/** Schema version. */
	version: number;
	/** Active line cap. Files over this fail the gate / block the write. */
	max_lines: number;
	/**
	 * Grandfathered offenders: repo-relative POSIX path -> recorded line
	 * count. A listed file may shrink or hold but not grow past its
	 * recorded count; drop it below `max_lines` to remove the entry.
	 */
	files: Record<string, number>;
}

let baselineCache = new Map<string, LargeFileBaseline | null>();

/**
 * Load `.interlinked/large-files-baseline.json` for `cwd`. Memoized per
 * cwd (cheap for verify's hundreds of per-file calls). Fail-soft: a
 * missing or malformed file yields `null` — callers fall back to
 * `DEFAULT_MAX_LINES` with no grandfathering.
 *
 * The cache is process-lifetime; the harness daemon picks up baseline
 * edits on restart (the standard post-edit `harness restart` flow).
 * Tests can force a reload via `resetLargeFileBaselineCache()`.
 */
export function loadLargeFileBaseline(cwd: string): LargeFileBaseline | null {
	const cached = baselineCache.get(cwd);
	if (cached !== undefined) return cached;

	let result: LargeFileBaseline | null = null;
	try {
		const path = join(cwd, LARGE_FILE_BASELINE_REL);
		if (existsSync(path)) {
			// `: unknown` annotation (not an `as` cast) narrows JSON.parse's
			// `any` return to `unknown` — normalizeBaseline validates it.
			const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
			result = normalizeBaseline(raw);
		}
	} catch {
		result = null; // malformed JSON -> default cap, no grandfathering
	}
	baselineCache.set(cwd, result);
	return result;
}

/** Expected raw shape of a parsed baseline file — every field is `unknown`
 *  until validated by `normalizeBaseline`. */
interface RawBaseline {
	version?: unknown;
	max_lines?: unknown;
	files?: unknown;
}

/** Validate + normalize a parsed baseline; returns null when unusable. */
function normalizeBaseline(raw: unknown): LargeFileBaseline | null {
	if (typeof raw !== "object" || raw === null) return null;
	const obj = raw as RawBaseline;
	if (typeof obj.max_lines !== "number" || obj.max_lines <= 0) return null;
	const files: Record<string, number> = {};
	if (typeof obj.files === "object" && obj.files !== null) {
		for (const [key, value] of Object.entries(obj.files)) {
			if (typeof value === "number" && value > 0) {
				files[key.replace(/\\/g, "/")] = value;
			}
		}
	}
	return {
		version: typeof obj.version === "number" ? obj.version : 1,
		max_lines: obj.max_lines,
		files,
	};
}

/** Clear the memoized baseline (after writing/regenerating the file). */
export function resetLargeFileBaselineCache(): void {
	baselineCache = new Map();
}

/**
 * Persist a baseline to `.interlinked/large-files-baseline.json` for `cwd`.
 * The writer half of `loadLargeFileBaseline` — until now the only creation
 * path was ad-hoc scripts (this repo's own list was hand-built). Used by
 * `interlinked adopt`, the human-invoked ratchet-from-here bootstrap: plain
 * `fs` writes from the CLI process never pass through the PreToolUse
 * baseline-integrity gate (the same carve-out coverage-ratchet.ts relies on).
 *
 * Grandfather entries are written key-sorted so re-runs produce stable,
 * diff-friendly output, and the memoized loader cache is invalidated so a
 * subsequent `loadLargeFileBaseline` in the same process sees the new state.
 * DIRECTION is the caller's contract: pass entries that hold or tighten the
 * existing water-line (`interlinked adopt` keeps the min of recorded vs
 * current) — this function is a dumb serializer, not a policy check.
 */
export function saveLargeFileBaseline(cwd: string, baseline: LargeFileBaseline): void {
	const path = join(cwd, LARGE_FILE_BASELINE_REL);
	mkdirSync(dirname(path), { recursive: true });
	const files: Record<string, number> = {};
	const entries = Object.entries(baseline.files).sort(([a], [b]) => a.localeCompare(b));
	for (const [key, value] of entries) {
		files[key.replace(/\\/g, "/")] = value;
	}
	const payload = { version: baseline.version, max_lines: baseline.max_lines, files };
	writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
	resetLargeFileBaselineCache();
}

/** The active line cap for `cwd`. Precedence: `.interlinked/metric-caps.json`
 *  (`max_lines`, the unified `interlinked caps` surface) → the large-files
 *  baseline (legacy, also carries the grandfather list) → the shipped default. */
export function maxLinesFor(cwd: string): number {
	return maxLinesOverride(cwd) ?? baselineOrDefaultLineCap(cwd);
}

/** The line cap from the large-files baseline (legacy source + grandfather
 *  list owner), or the shipped default when no baseline file is present. */
function baselineOrDefaultLineCap(cwd: string): number {
	return loadLargeFileBaseline(cwd)?.max_lines ?? DEFAULT_MAX_LINES;
}

/** Line count, consistent with the long-standing `checkLargeFile` definition. */
export function countLines(content: string): number {
	return content.split("\n").length;
}

// The comment/string-aware code-line scanner lives in code-line-count.ts
// (2026-07-17: extracted when this module hit its own line cap) — re-exported
// so existing consumers (pre-checks, line-count-projection) keep this path.
export { countCodeLines } from "./code-line-count.js";

/**
 * Test/spec file detection — purely path/filename based.
 *
 * THIN RE-EXPORT of `checks/shared.ts::isTestSourcePath` (plan
 * `docs/plans/16-monotonic-quality-enforcement.md` §11.3, Audit B) — kept as
 * a separately named export for this module's own callers (its
 * `isCappableFile` test clause below, and its pinned test file) rather than
 * removing it outright. Deliberately NOT `checks/shared.ts::isTestFile` (aka
 * `isPatternDataFile`): that function ALSO treats interlinked-cli's own
 * `harness/checks/`, `harness/check-registry/` etc. as "test files" (a
 * content-scan FP exemption for detector files that hold scary patterns as
 * DATA). A line count is a line count regardless —
 * `check-registry/entries-warnings.ts` being 1763 lines is a real fact — so
 * the cap must use the narrow, exemption-free question-1 predicate.
 */
export function isTestOrSpecPath(filePath: string): boolean {
	return isTestSourcePath(filePath);
}

/**
 * Content marker that exempts a file from the per-file line cap WITHOUT marking
 * it `@generated` everywhere. For hand-maintained codegen-DATA modules whose
 * bulk is a large template string or data table emitted verbatim into generated
 * output (e.g. the `.mjs` hook-script chunks under `src/lib/hook-template-chunks/`
 * and `src/lib/hooks-template.ts`): there the line count measures the size of
 * the emitted artifact, not module complexity, so the cap is a false signal.
 * Sharding such a file scatters one artifact across modules for no legibility
 * win and adds byte-identical-output invariants — exempting it is the right call.
 *
 * Unlike `@generated` — which `isGeneratedFile` uses to suppress many OTHER
 * checks — this marker is scoped to the line cap alone: tsc/lint/secrets/etc.
 * still run on the file. Bounded scan: first 20 lines only (mirrors
 * `isGeneratedFile`), so the marker must sit in the file header, never buried
 * in the data body.
 */
const CODEGEN_DATA_MARKER = "@codegen-data";

function hasCodegenDataMarker(content: string): boolean {
	return content.split("\n", 20).join("\n").includes(CODEGEN_DATA_MARKER);
}

/** Resolve a path for containment comparison: lexical resolve + realpath.
 *  Realpath matters because tmp trees are exactly where symlinked prefixes
 *  live (macOS `/tmp`→`/private/tmp`, `/var`→`/private/var` — the same gotcha
 *  the coverage overlay realpath-resolves for). For a path not on disk yet (a
 *  Write creating the file), realpath the nearest EXISTING ancestor and
 *  re-append the rest — resolving only the existing side would compare
 *  `/private/var/...` (root) against `/var/...` (new file) and misjudge every
 *  brand-new file under a symlinked prefix as outside the root. */
/** Max non-existent ancestor levels to walk before giving up. Real paths are
 *  never this deep; a pathological agent-controlled path is bounded here so
 *  neither the stack (recursion) nor the wall clock (one stat per level) can
 *  be exhausted on the Pre/Post hot path (deep-round #9). */
const MAX_ANCESTOR_WALK = 256;

/** Realpath the nearest existing ancestor of `abs`, collecting the missing
 *  tail. Iterative + depth-capped. Over the cap it returns the lexical path
 *  unresolved — `startsWith` containment then fails closed for absurd depths
 *  (they are treated as outside the root), which is the safe direction. */
function realpathNearestAncestor(abs: string): { base: string; missing: string[] } {
	const missing: string[] = [];
	let cur = abs;
	for (let i = 0; i < MAX_ANCESTOR_WALK; i++) {
		try {
			return { base: realpathSync(cur), missing };
		} catch {
			const parent = dirname(cur);
			if (parent === cur) return { base: cur, missing };
			missing.push(basename(cur));
			cur = parent;
		}
	}
	// Over the walk cap: we could not resolve symlinks in the path, so we
	// must NOT return the lexical path (it would still prefix-match a root
	// and misclassify an over-deep path beneath an in-root symlink,
	// round-2 #34). A NUL-prefixed sentinel matches no real filesystem path,
	// so isInsideRoot fails closed (treats it as outside → block).
	return { base: OVER_CAP_SENTINEL, missing: [] };
}

/** NUL can't appear in a real path, so this prefix-matches nothing. Keep the
 *  NUL spelled as the U+0000 escape — a raw byte here trips binary_content,
 *  which then suppresses every other inline check on this file. */
const OVER_CAP_SENTINEL = "\u0000over-ancestor-cap";

function containmentPath(p: string): string {
	const { base, missing } = realpathNearestAncestor(resolve(p));
	return missing.length === 0 ? base : join(base, ...missing.reverse());
}

/** True when `filePath` (absolute, or resolved against `root`) lives inside
 *  `root`. Traversal-safe: both sides are resolved before comparison, so a
 *  `../`-laden agent-controlled path can't string-match its way in. */
export function isInsideRoot(root: string, filePath: string): boolean {
	const r = containmentPath(root);
	const f = containmentPath(isAbsolute(filePath) ? filePath : resolve(root, filePath));
	return f === r || f.startsWith(r + sep);
}

/**
 * Whether the per-file line cap applies to this file. True only for
 * hand-written code modules INSIDE the guarded repo. Exempt: files outside
 * `root` (when given), `.interlinked/` tool-state/probe files, generated
 * files (by path or content marker), codegen-DATA modules (a `@codegen-data`
 * header marker), `.d.ts` declarations, test/spec files, and non-code files
 * (docs, HTML/markup, structured data, diffs/patches, vector art).
 *
 * Root confinement: the cap is the guarded repo's maintainability policy —
 * its baseline lives at `<root>/.interlinked/` — so a file outside the root
 * (session scratchpad, /tmp probe, another repo) is not governed by it. Same
 * reasoning that root-confined the bash-write guard (82bfc96). Observed live
 * 2026-07-15: a 586-line self-contained HTML artifact in the session
 * scratchpad was blocked by the repo's 500-line cap, steering the agent
 * toward formatting-golf to duck under it. Callers that can see out-of-repo
 * paths (event-driven gates/nudges) MUST pass `root`; repo-walk callers
 * (verify) may omit it.
 */
export function isHandwrittenCodeFile(
	file: { filePath: string; content: string; root?: string },
): boolean {
	if (file.root !== undefined && !isInsideRoot(file.root, file.filePath)) return false;
	const norm = file.filePath.replace(/\\/g, "/");
	if (norm.endsWith(".d.ts")) return false;
	if (TOOL_STATE_PATH_RE.test(norm)) return false;
	if (isRepoScratchPath(norm, file.root)) return false;
	if (FILE_SIZE_SKIP_EXT_RE.test(norm)) return false;
	if (GENERATED_PATH_RE.test(norm)) return false;
	if (VENDORED_PATH_RE.test(norm)) return false;
	if (DOCUMENTATION_PATH_RE.test(norm)) return false;
	if (CONFIG_ARTIFACT_RE.test(norm)) return false;
	if (isNonProductArtifactPath(norm)) return false;
	if (isGeneratedFile(file.content)) return false;
	if (hasCodegenDataMarker(file.content)) return false;
	return true;
}

export function isCappableFile(file: { filePath: string; content: string; root?: string }): boolean {
	return isHandwrittenCodeFile(file) && !isTestSourcePath(file.filePath.replace(/\\/g, "/"));
}

/** Verify-side verdict for a static file snapshot. */
interface LargeFileVerdict {
	lines: number;
/** Over the active cap. */
	overCap: boolean;
	/** In the baseline and within its recorded ceiling — does not fail the gate. */
	grandfathered: boolean;
	/** Highest line count this file may reach without failing: the cap, or
	 *  its baseline ceiling if higher. */
	ceiling: number;
}

/**
 * Judge a static file snapshot against the cap + grandfather list. Used by
 * the `large_files` verify check. The PreToolUse block does NOT use this —
 * it works on a live before/after delta (see `checkLargeFileLineCountWrite`).
 */
export function evaluateLargeFile(args: {
	relPath: string;
	lines: number;
	baseline: LargeFileBaseline | null;
	/**
	 * The EFFECTIVE cap to enforce — pass `maxLinesFor(cwd)` so the
	 * `.interlinked/metric-caps.json` override (the unified `interlinked caps set
	 * lines` surface) is honored. When omitted, falls back to the baseline's
	 * `max_lines` then the shipped default. `verify` previously called this
	 * WITHOUT the override, so a lowered cap was silently ignored by `verify`
	 * while still blocking writes / nudging (finding 2026-06, round 8). The
	 * grandfather list is always read from `baseline.files` regardless.
	 */
	maxLines?: number;
}): LargeFileVerdict {
	const max = args.maxLines ?? args.baseline?.max_lines ?? DEFAULT_MAX_LINES;
	const recorded = args.baseline?.files[args.relPath.replace(/\\/g, "/")];
	const overCap = args.lines > max;
	const ceiling = recorded !== undefined && recorded > max ? recorded : max;
	// Grandfathered: listed in the baseline AND not grown past its recorded
	// size. A grandfathered file that shrank to <= max is simply under the
	// cap (overCap false) and needs no special-casing.
	const grandfathered = overCap && recorded !== undefined && args.lines <= recorded;
	return { lines: args.lines, overCap, grandfathered, ceiling };
}
