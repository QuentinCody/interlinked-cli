// interlinked-tdd: exempt
// ===========================================
// Verification-Before-Stop — predicates, stub scan, file-count + doc-fact
// ===========================================
//
// Leaf helpers extracted from verification-stop-checks.ts so the main file
// stays under the per-file line cap. All pure / total: the Bash+tool
// classification predicates, the UI/code/doc-fact file predicates, the
// stub-introduction content scan, and the per-session file-count + doc-marker
// drift helpers. Depend only on their own regexes plus the shared `isDocFile`
// predicate and `basename`. Behavior is byte-identical to the originals.

import { isDocFile } from "./commit-cadence.js";

/** Verification signal kinds tracked across a session.
 *
 *  Correctness signals (typecheck, test, lint, build, verify-suite)
 *  satisfy the "unverified code" check. UI-interaction signals
 *  (browser, dev-server) satisfy the "UI not interacted" check. Each
 *  kind is treated as a separate axis — running `bun run dev` proves
 *  the UI was at least loadable but does NOT prove the code typechecks.
 *
 *  `verify-suite` covers `interlinked verify`, the canonical local gate
 *  that runs tsc + biome + lint + secrets + SAST + docs:check (and
 *  mirrors the CI pipeline). Observing it satisfies all four
 *  individual correctness axes at once. */
export type VerificationSignal =
	| "typecheck"
	| "test"
	| "lint"
	| "build"
	| "verify-suite"
	| "browser"
	| "dev-server";

/** Bash commands that indicate a typechecker ran (tsc, ttsc, tspc).
 *  Word-boundary anchored so `tsconfig` / `tsc-multi-watch` don't match. */
const TYPECHECK_RE = /(?:^|[\s;&|])(?:tsc|tspc|ttsc)(?:\s|$|--)/;

/** Test runners across JS/TS, Python, Rust, Go, Bun, Deno, plus the
 *  generic `npm/bun/pnpm/yarn run test` and `script test`. */
const TEST_RE =
	/\b(?:vitest|jest|mocha|tap|ava|pytest|nose2|tox|cargo\s+(?:test|nextest)|go\s+test|bun\s+test|deno\s+test|rspec|phpunit|gradle\s+test|mvn\s+test)\b|\b(?:npm|bun|pnpm|yarn)\s+(?:run\s+)?test\b/;

/** Linters / formatters that double as correctness signals.
 *  `cargo check` is treated as a typecheck above? Actually it's neither —
 *  but it IS a correctness gate. Treat as lint for simplicity. */
const LINT_RE =
	/\b(?:biome(?:\s+(?:check|lint|ci))?|eslint|oxlint|ruff|clippy|tslint|stylelint|cargo\s+check|cargo\s+clippy)\b|\b(?:npm|bun|pnpm|yarn)\s+run\s+lint\b/;

/** Project-wide build commands. Excludes `tsc --watch` (development) and
 *  `bun build <file>` (one-off compile) — those don't prove the full
 *  project compiles. */
const BUILD_RE =
	/\b(?:tsc\s+--build|cargo\s+build|go\s+build|mvn\s+(?:compile|package)|gradle\s+build)\b|\b(?:npm|bun|pnpm|yarn)\s+run\s+build\b/;

/** Dev-server starters across the common JS frameworks plus the Python
 *  dev servers (`python -m http.server`, `uvicorn`, `flask run`). Matches
 *  `wrangler dev`, `npm run dev` / `bun run dev`, and the Python shapes. */
const DEV_SERVER_RE =
	/\b(?:wrangler\s+dev|next\s+dev|vite(?:\s+dev|\s+preview|\s+--port)?|astro\s+dev|nuxt\s+dev|svelte-kit\s+dev|webpack\s+serve|remix\s+dev|gatsby\s+develop)\b|\b(?:npm|bun|pnpm|yarn)\s+run\s+dev\b|\bpython3?\s+-m\s+http\.server\b|\buvicorn\b|\bflask\s+run\b/;

/** Browser-automation CLIs that prove the agent drove a real page:
 *  Simon Willison's Rodney (`uvx rodney …`), Vercel's agent-browser, and
 *  the Playwright CLI. The command-line counterpart of the chrome-devtools
 *  and playwright MCP tools that `classifyBrowserToolName` already covers —
 *  added so an agent that manual-tests via a CLI tool (per the
 *  agentic-engineering-patterns "agentic manual testing" guide) still
 *  satisfies the UI-not-interacted check. */
const BROWSER_CLI_RE =
	/\b(?:rodney|agent-browser)\b|(?:^|[\s;&|])(?:npx\s+|uvx\s+|bunx\s+)?playwright\s+(?:test|codegen|show-report|install|open)\b/;

/** `interlinked verify` — the project's canonical local gate. Recognized
 *  in all the common invocation shapes (direct binary, npx, ts-node, the
 *  built dist entry). Observing this command in the session trajectory is
 *  stronger evidence of correctness than any single tool signal because
 *  verify runs tsc + biome + lint + secrets + SAST + docs:check together
 *  and aggregates results. */
const VERIFY_SUITE_RE =
	/\b(?:npx\s+)?interlinked\s+verify\b|\bnode\s+\S*(?:dist|src)\S*\s+verify\b|\b(?:npx\s+)?tsx\s+\S*index\.ts\s+verify\b/;

/**
 * Public predicate — classify a Bash command into a single verification
 * signal kind, or null. The first matching pattern wins; commands that
 * chain multiple kinds (`bun run test && bun run build`) return whichever
 * the regex order resolves first.
 *
 * Verify-suite is checked FIRST so an `interlinked verify` invocation
 * doesn't get misclassified as just `tsc` because verify spawns tsc
 * internally — the suite signal is strictly more informative.
 */
export function classifyVerificationCommand(cmd: string): VerificationSignal | null {
	if (VERIFY_SUITE_RE.test(cmd)) return "verify-suite";
	if (TYPECHECK_RE.test(cmd)) return "typecheck";
	if (TEST_RE.test(cmd)) return "test";
	if (LINT_RE.test(cmd)) return "lint";
	if (BUILD_RE.test(cmd)) return "build";
	if (BROWSER_CLI_RE.test(cmd)) return "browser";
	if (DEV_SERVER_RE.test(cmd)) return "dev-server";
	return null;
}

/**
 * Whether `cmd` is a test-runner invocation — the exact predicate
 * `characterize-campaign-target.ts`'s `commandNamesFile` gates on before it
 * even looks at the command's file arguments. Exported here (rather than
 * re-derived in the gate or in `trackCommand`) so the "does this command
 * count as a test run" question has exactly one implementation; the gate and
 * the durable `test_commands_run` recorder both import this instead of each
 * carrying their own copy that could drift apart.
 */
export function isTestRunnerCommand(cmd: string): boolean {
	return classifyVerificationCommand(cmd) === "test";
}

/** The correctness-grade `VerificationSignal` kinds — the subset of
 *  {@link classifyVerificationCommand}'s outputs that prove the code was
 *  actually *checked* (typecheck / test / lint / build / the full verify
 *  suite). The `browser` / `dev-server` kinds are excluded: they prove a
 *  page loaded, not that the code compiles or its tests pass. */
const CORRECTNESS_COMMAND_KINDS: ReadonlySet<VerificationSignal> = new Set([
	"typecheck",
	"test",
	"lint",
	"build",
	"verify-suite",
]);

/**
 * Public — count the correctness-grade verification commands in a session's
 * Bash `commands_run` list. This is the numerator of the verify-to-edit
 * cadence ratio the unverified-code Stop nudge gates on.
 *
 * Distinct from the `verification_observed` Set, which records the distinct
 * signal *kinds* — one `tsc` run and fifty `tsc` runs both collapse to
 * `{typecheck}`. The cadence ratio needs raw invocation *count*, so it can
 * reflect how *often* the agent verified (the Fable-corpus §A metric: the
 * best released models sustain ~0.5–1.0 verifications per code edit), not
 * merely *whether* it verified once.
 */
export function countVerifyCommands(commands: readonly string[]): number {
	let count = 0;
	for (const cmd of commands) {
		const kind = classifyVerificationCommand(cmd);
		if (kind !== null && CORRECTNESS_COMMAND_KINDS.has(kind)) count++;
	}
	return count;
}

/**
 * Public predicate — classify a tool name (typically an MCP-prefixed
 * tool) into a browser-interaction signal. Treats both `chrome-devtools`
 * and `playwright` MCP tools as evidence the agent loaded a page.
 */
export function classifyBrowserToolName(toolName: string | undefined): VerificationSignal | null {
	if (!toolName) return null;
	if (toolName.startsWith("mcp__chrome-devtools__")) return "browser";
	if (toolName.startsWith("mcp__playwright__browser_")) return "browser";
	return null;
}

/** UI source-file extensions. Covers the major component frameworks
 *  (React .tsx/.jsx, Vue, Svelte, Astro) plus raw markup and styles. */
const UI_FILE_RE = /\.(?:tsx|jsx|html?|css|scss|sass|less|vue|svelte|astro)$/i;

/** Code-file extensions for the "unverified code" check. Intentionally
 *  broader than UI files but excludes data files and lockfiles. Doc
 *  files are filtered separately via `isDocFile`. */
const CODE_FILE_RE =
	/\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|c|cc|cpp|h|hpp|cs|rb|kt|swift|php|scala|sh|bash|zsh|fish|ps1|sql|vue|svelte|astro)$/i;

/** Public predicate. UI files are a strict subset of code files. */
export function isUiFile(filePath: string): boolean {
	return UI_FILE_RE.test(filePath);
}

/** Public predicate. Code files exclude markdown/docs/plan files (per
 *  the existing `isDocFile`) and include source code across the
 *  supported languages. */
export function isCodeFile(filePath: string): boolean {
	if (isDocFile(filePath)) return false;
	return CODE_FILE_RE.test(filePath);
}

// ---------------------------------------------------------------------------
// Stub-introduction detection (PostToolUse content scan)
// ---------------------------------------------------------------------------

/** Kind label for one of the patterns we surface in the Stop nudge.
 *  Kept distinct from `VerificationSignal` so the two axes don't tangle. */
export type StubKind = "TODO" | "FIXME" | "not-implemented-throw" | "disabled-test";

interface StubPattern {
	kind: StubKind;
	re: RegExp;
}

/** Patterns that indicate the agent is leaving work unfinished or
 *  silenced. Each pattern is anchored to avoid the obvious false
 *  positives (`TODO` inside the word `KOMODO` etc.). */
const STUB_PATTERNS: ReadonlyArray<StubPattern> = [
	// `TODO:` / `TODO(name):` / `// TODO ` — require a punctuation or
	// space delimiter after to avoid matching identifiers like `MyTODOList`.
	{ kind: "TODO", re: /(?:^|[^A-Za-z0-9_])TODO\b\s*[:(\-\s]/m },
	{ kind: "FIXME", re: /(?:^|[^A-Za-z0-9_])FIXME\b/m },
	// `throw new Error("not implemented")` / `throw new TypeError("TODO")` etc.
	// The message must contain one of {not implemented, unimplemented, TODO, stub}.
	{
		kind: "not-implemented-throw",
		re: /\bthrow\s+new\s+\w*Error\s*\(\s*["'`][^"'`]*\b(?:not\s+implemented|unimplemented|TODO|stub)\b/i,
	},
	// `it.skip(`, `test.skip(`, `describe.skip(`, `xit(`, `xdescribe(`.
	{ kind: "disabled-test", re: /\b(?:it|test|describe)\.skip\s*\(|\b(?:xit|xdescribe)\s*\(/m },
];

/** Maximum stubs we'll record per session. Past this, additional
 *  introductions are dropped silently — the nudge is informational, not
 *  audit-grade, and an unbounded array on a long session is wasteful. */
export const STUB_INTRODUCED_CAP = 50;

export interface StubMatch {
	kind: StubKind;
	/** Trimmed line surrounding the match, capped at 120 chars. */
	snippet: string;
}

/**
 * Public — scan new content (Write `content`, Edit `new_string`,
 * MultiEdit `edits[].new_string`) for stub patterns. Returns at most one
 * match per kind so a file with three TODOs only contributes one TODO
 * record. Pure: caller decides whether to record into session state.
 */
export function scanForStubs(content: string): StubMatch[] {
	if (typeof content !== "string" || content.length === 0) return [];
	const found: StubMatch[] = [];
	const seen = new Set<StubKind>();
	for (const { kind, re } of STUB_PATTERNS) {
		if (seen.has(kind)) continue;
		const m = content.match(re);
		if (!m) continue;
		seen.add(kind);
		const idx = m.index ?? 0;
		const lineStart = content.lastIndexOf("\n", Math.max(0, idx - 1)) + 1;
		let lineEnd = content.indexOf("\n", idx);
		if (lineEnd === -1) lineEnd = content.length;
		const line = content.slice(lineStart, lineEnd).trim();
		const snippet = line.length > 120 ? `${line.slice(0, 117)}...` : line;
		found.push({ kind, snippet });
	}
	return found;
}
// ---------------------------------------------------------------------------
// Aggregation helpers for the Stop branch
// ---------------------------------------------------------------------------

/**
 * Public — count distinct code files (non-doc) written this session.
 *
 * `files_written` stores BOTH the raw and resolved-absolute form per
 * the existing convention in session-state.ts, so a naive `.size`
 * double-counts. We dedupe by skipping the raw form when the resolved
 * absolute form is also present.
 */
export function countCodeFilesEdited(filesWritten: ReadonlySet<string>): number {
	return countMatchingFiles(filesWritten, isCodeFile);
}

/** Public — count distinct UI files (subset of code files) written this session. */
export function countUiFilesEdited(filesWritten: ReadonlySet<string>): number {
	return countMatchingFiles(filesWritten, isUiFile);
}

function countMatchingFiles(
	filesWritten: ReadonlySet<string>,
	predicate: (p: string) => boolean,
): number {
	const matching: string[] = [];
	for (const path of filesWritten) {
		if (predicate(path)) matching.push(path);
	}
	// Dedupe: if both `src/foo.ts` and `/abs/path/src/foo.ts` are
	// present, keep only the absolute form. Heuristic: a path is the
	// "raw" duplicate of an absolute path if some absolute path in the
	// set ends with `/` + raw.
	const absolutes = matching.filter((p) => p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p));
	const relatives = matching.filter((p) => !absolutes.includes(p));
	const dedupedRelatives = relatives.filter(
		(rel) => !absolutes.some((abs) => abs.endsWith(`/${rel}`) || abs.endsWith(`\\${rel}`)),
	);
	return absolutes.length + dedupedRelatives.length;
}

// ---------------------------------------------------------------------------
// Doc-fact drift (gen-marker) — Stop nudge
// ---------------------------------------------------------------------------
// The landing page and README embed `<!-- gen:* -->` counters (built-in rule
// count, runner list, mode names) that scripts/extract-doc-facts.mjs computes
// from source. Editing one of those source files without regenerating the docs
// drifts the counters — a failure CI's docs:check (and the pre-push gate)
// catch, but only at push time, after a whole session of edits. This Stop
// nudge surfaces it the moment the session ends instead. (The 113→116 rule
// count that landed red is the canonical instance.)
//
// The matched set mirrors extract-doc-facts.mjs's extract*() inputs that
// produce a COUNT or LIST — the values that silently drift:
//   - src/harness/rules/builtin-rules-*.ts → builtin_rule_count
//   - src/lib/hooks.ts                     → runner_count / runners_inline
//   - src/harness/modes.ts                 → mode_names_*
// package.json (node-min) is deliberately excluded: it changes rarely and is
// edited for many unrelated reasons, so including it would over-fire.
const DOC_FACT_SOURCE_RE =
	/(?:^|\/)(?:src\/harness\/rules\/builtin-rules-[\w-]+\.ts|src\/lib\/hooks\.ts|src\/harness\/modes\.ts)$/;

/** Public predicate — a source file the doc-fact extractor reads to compute a
 *  gen-marker counter. Editing one can drift the landing/README counters. */
export function isDocFactSourceFile(filePath: string): boolean {
	return DOC_FACT_SOURCE_RE.test(filePath);
}

/** Public — count distinct doc-fact source files written this session. */
export function countDocFactSourcesEdited(filesWritten: ReadonlySet<string>): number {
	return countMatchingFiles(filesWritten, isDocFactSourceFile);
}

/** Commands that regenerate or validate the gen-markers. Seeing one in the
 *  session's command history means the agent already reconciled the docs, so
 *  the nudge would be noise. `interlinked verify` aggregates docs:check. */
const DOCS_REGEN_CMD_RE = /\bdocs:(?:build|check)\b|\bcheck-docs(?:\.mjs)?\b|\binterlinked\s+verify\b/;

export interface FormatDocMarkerDriftOpts {
	/** Distinct doc-fact source files written this session. */
	docSourcesEdited: number;
	/** Shell commands run this session (to suppress once docs were regenerated). */
	commandsRun: ReadonlyArray<string>;
}

/**
 * Public — Stop-time nudge when a gen-marker SOURCE file (a built-in rule
 * family, the runner registry, or the modes type) was edited this session but
 * no `docs:build` / `docs:check` / `interlinked verify` was run. Those edits
 * drift the `<!-- gen:* -->` counters on the landing page and README, which
 * CI's docs:check and the pre-push gate block on. Firing here turns a
 * push-time / CI-only signal into an in-session one.
 *
 * Returns null when no doc-fact source was edited, or when the docs were
 * already regenerated / validated this session.
 */
export function formatDocMarkerDriftWarning(opts: FormatDocMarkerDriftOpts): string | null {
	if (opts.docSourcesEdited === 0) return null;
	if (opts.commandsRun.some((c) => DOCS_REGEN_CMD_RE.test(c))) return null;
	return (
		`[interlinked:verify-before-stop] Stopping with ${opts.docSourcesEdited} edit(s) to a ` +
		"doc-fact source (a built-in rule family, the runner registry, or the modes type) and no " +
		"`docs:build` / `docs:check` run this session. These files feed the generated " +
		"`<!-- gen:* -->` counters on the landing page and README; CI's docs:check (and the pre-push " +
		"gate) block on drift. Run `npm run docs:build && npm run docs:check` before pushing — a stale " +
		"rule count is otherwise a CI-only signal that lands red on main."
	);
}
