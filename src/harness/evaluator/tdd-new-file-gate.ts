// ===========================================
// TDD Gate: new-file creation
// ===========================================
// Blocks creation of a new non-test `.ts`/`.tsx` source file unless a companion
// test file already exists on disk OR was written earlier in the same session.
//
// Runs only when `structural_checks.test_first_mode === "enforce"` (the
// current default). Scope is intentionally narrow — existing files can still
// be Edit'd without a gate; we start with the gentler "new-files-only"
// rollout and will widen to all edits in a follow-up.
//
// Bypasses:
//   - Per-file directive `// interlinked-tdd: exempt` in the first ~400 bytes
//     of the Write content (meant for genuinely untestable surfaces — entry
//     points that only wire DI, generated bridges, etc.).
//   - Path is on the exemption list (tests, fixtures, generated artifacts,
//     type declarations, config files, standalone scripts).

import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { nonNull } from "../../lib/non-null.js";
import {
	companionHintPath,
	companionTestCandidates,
	hasCompanionTest,
	isCompanionFileName,
} from "./companion-test.js";
import { existsSync } from "node:fs";
import { appendDebtTxn } from "../obligation-ledger-io.js";
import type { ObligationTxn } from "../obligations.js";
import { getRepoProfile } from "../repo-profile.js";
import type {
	GuardRulesConfig,
	HarnessDecision,
	HarnessEvent,
	SessionTrajectory,
	StructuralChecksConfig,
} from "../types.js";

/** The only mode in which this gate fires. Extracted so the conditional reads
 *  as intent; see `types.ts#GuardRulesConfig.structural_checks.test_first_mode`. */
const ENFORCE_MODE: "enforce" = "enforce";

const SOURCE_EXT_RE = /\.(ts|tsx)$/;

// Paths where a companion test isn't meaningful — skip the gate.
const EXEMPT_PATH_RES: readonly RegExp[] = [
	/\.d\.ts$/, // type-only declarations
	/\.test\.tsx?$/, // the tests themselves
	/\.spec\.tsx?$/,
	/(^|\/)__tests__\//,
	/(^|\/)__fixtures__\//,
	/(^|\/)__mocks__\//,
	/(^|\/)dist\//,
	/(^|\/)\.claude\//,
	/(^|\/)\.interlinked\//,
	/(^|\/)node_modules\//,
	/(^|\/)scripts\//, // one-off build/release scripts
	// Session/agent scratch scripts (gitignored, rg-searchable via .ignore
	// negation). First-class for content-quality/security/caps gates, but
	// companion tests are not demanded — requiring TDD for one-off scripts
	// just pushes agents back to ungoverned /tmp (operator decision 2026-07-07).
	/(^|\/)scratch\//,
	/\.config\.tsx?$/, // vite.config.ts / vitest.config.ts / tsup.config.ts / ...
	// Static-site / deploy-artifact directories — Workers, landing pages,
	// docs sites. These ship as deployed bundles, not as application source,
	// and a unit test for the entrypoint isn't meaningful.
	/(^|\/)landing\//,
	/(^|\/)web\//,
	/(^|\/)site\//,
];

const TDD_EXEMPT_DIRECTIVE_RE = /\/\/\s*interlinked-tdd:\s*exempt\b/;
const EXEMPT_DIRECTIVE_SCAN_BYTES = 400;

interface TddNewFileGateArgs {
	filePath: string;
	cwd?: string | undefined;
	session: SessionTrajectory | undefined;
	content?: string | undefined;
	testFirstMode: "nudge" | "warn" | "enforce" | undefined;
}

/** Public API — consumed by `evaluator/pre-tool.ts` on every file-write event.
 *
 *  Returns `null` when the gate is not applicable (wrong mode, wrong ext, in
 *  an exempt path, existing file, or companion found). Returns a `block`
 *  decision when a new `.ts`/`.tsx` file is being created without a
 *  companion test. */
export function evaluateTddNewFileGate(args: TddNewFileGateArgs): HarnessDecision | null {
	// "warn" runs the same detection but resolves to allow+warning below —
	// the balanced-mode ladder (2026-08-17). "nudge" and undefined stay silent
	// at this gate (the always-on test-first nudge covers them elsewhere).
	if (args.testFirstMode !== ENFORCE_MODE && args.testFirstMode !== "warn") return null;
	if (!args.filePath) return null;
	if (!SOURCE_EXT_RE.test(args.filePath)) return null;
	if (isExemptPath(args.filePath)) return null;
	if (hasExemptDirective(args.content)) return null;

	const abs = toAbsolute(args.filePath, args.cwd);

	// Only fire on NEW files. Existing-file Edits are part of the later
	// "enforce_all" rollout.
	if (existsSync(abs)) return null;

	const projectRoot = args.cwd || process.cwd();
	const candidates = companionTestCandidates(abs, projectRoot);
	if (hasCompanionTest(abs, projectRoot)) return null;
	if (args.session && sessionWroteCompanion(args, abs, candidates)) return null;

	return missingCompanionVerdict(args, candidates, projectRoot);
}

/**
 * Build the "no companion test" verdict once the gate has decided to fire.
 *
 * Layout-conditional severity (portability — external assessment 2026-07-06):
 * the gate was written against this repo's colocated-vitest workflow and, on a
 * repo with NO test files anywhere (`testLayout === "none"`), a hard block is
 * pure noise — that repo never opted into TDD, and there is no existing test
 * convention the agent could follow. On such repos the same message is emitted
 * as an allow+warning instead (never a block, never an opened debt — see the
 * pass-through guard in {@link downgradeNewFileBlockToDebt}). Colocated and
 * separate-tree repos DID opt in (they have tests) and keep the historical
 * hard-block semantics byte-for-byte. The demotion lives here, inside the
 * gate, not as config mutation, so a repo that later grows its first test file
 * re-enters enforce mode automatically on the next profile detection.
 */
function missingCompanionVerdict(
	args: TddNewFileGateArgs,
	candidates: string[],
	projectRoot: string,
): HarnessDecision {
	const hint = companionHintPath(args.filePath);
	const surface = extractPublicSurface(args.content);
	const surfaceLine = surface.length > 0
		? ` Public surface to test (extracted from your content): ${surface.join(", ")}.`
		: "";
	const body =
		`new source file "${args.filePath}" has no companion test. ` +
		`Red/green TDD is enforced for new .ts/.tsx files. ` +
		`Create ${hint} first with a failing test, then write the implementation. ` +
		`(Searched: ${candidates.map((c) => shortest(c, args.cwd)).join(", ")}.)` +
		surfaceLine +
		` If this file has no testable surface, add "// interlinked-tdd: exempt" as the first line.`;
	if (args.testFirstMode === "warn") {
		return {
			decision: "allow",
			warnings: [
				`[interlinked:tdd] ${body} (test_first_mode "warn": advisory here — ` +
					`strict mode blocks this. interlinked mode strict to enforce.)`,
			],
			rule_id: "tdd_new_file_gate",
			severity: "low",
			category: "tdd",
		};
	}
	if (getRepoProfile(projectRoot).testLayout === "none") {
		return {
			decision: "allow",
			warnings: [
				`[interlinked:tdd] ${body} (Advisory only: this repo has no test files, so TDD ` +
					`enforcement is demoted to a warning here.)`,
			],
			rule_id: "tdd_new_file_gate",
			severity: "low",
			category: "tdd",
		};
	}
	return {
		decision: "block",
		reason: `BLOCKED: ${body}`,
		rule_id: "tdd_new_file_gate",
		severity: "high",
		category: "tdd",
	};
}

// ===========================================
// Public surface extraction
// ===========================================
// When the gate fires we already have the impl content the agent was
// trying to write. Listing its top-level testable exports in the block
// message saves a Read round-trip when the agent then writes the test —
// they don't have to re-open the impl to remember what to assert against.
//
// We deliberately skip type-only exports (`type`, `interface`) because
// they don't survive to runtime and so can't be asserted on directly.
// Heuristic — regex-based, no AST. Good enough for triage; not a contract.

const EXPORT_FUNCTION_RE = /^\s*export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/gm;
const EXPORT_CLASS_RE = /^\s*export\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)\b/gm;
const EXPORT_VAR_RE = /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/gm;
const EXPORT_ENUM_RE = /^\s*export\s+(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)\b/gm;
const SURFACE_LIMIT = 10;

function extractPublicSurface(content: string | undefined): string[] {
	if (!content) return [];
	const names = new Set<string>();
	const patterns: readonly RegExp[] = [
		EXPORT_FUNCTION_RE,
		EXPORT_CLASS_RE,
		EXPORT_VAR_RE,
		EXPORT_ENUM_RE,
	];
	for (const re of patterns) {
		// Reset lastIndex because the same regex instance is reused.
		re.lastIndex = 0;
		let m: RegExpExecArray | null = re.exec(content);
		while (m !== null) {
			names.add(nonNull(m[1]));
			if (names.size >= SURFACE_LIMIT) return [...names];
			m = re.exec(content);
		}
	}
	return [...names];
}

/**
 * Public API — consumed by `evaluator/pre-tool.ts` as a thin event-level
 * wrapper around `evaluateTddNewFileGate`. Extracts `file_path`/`content` from
 * the raw tool input so the call site stays a one-liner, then routes the verdict
 * through {@link downgradeNewFileBlockToDebt}.
 *
 * **Debt-mode downgrade.** When `per_edit_coverage.debt_mode` is on (now the
 * default), a new-file block is converted into an *opened coverage debt* + allow
 * instead of a hard stop: the agent may write a new source file and its test as
 * two ordinary edits. The existing `applyDebtMode` machinery (which reads the
 * ledger on subsequent edits) then handles the wander-block and the optimistic
 * discharge when the companion test is edited — so we only OPEN the debt + allow
 * here. When `debt_mode` is off the original hard block is returned unchanged.
 * The `// interlinked-tdd: exempt` escape is honored upstream (the pure gate
 * returns null for it), so an exempt file never reaches the debt branch.
 */
export function evaluateTddNewFileGateForEvent(
	event: HarnessEvent,
	rules: GuardRulesConfig,
	session: SessionTrajectory | undefined,
): HarnessDecision | null {
	// SAFETY: GuardRulesConfig declares `structural_checks` as required, but a
	// hand-built or partially-merged rules object can omit it in practice
	// (proven by the "returns null when test_first_mode is not enforce"
	// test, whose `makeRules()` fixture omits this field entirely) — cast to
	// the honest optional shape so the chain below reflects reality instead
	// of the (unenforced) declared type.
	const structuralChecks = rules.structural_checks as StructuralChecksConfig | undefined;
	const toolInput = event.tool_input || {};
	const filePath = (toolInput.file_path as string) || (toolInput.path as string) || "";
	const block = evaluateTddNewFileGate({
		filePath,
		cwd: event.cwd,
		session,
		content:
			(toolInput.content as string | undefined) ??
			(toolInput.new_string as string | undefined),
		// NOTE: keyed off `structural_checks.test_first_mode` alone — DELIBERATELY
		// independent of `structural_checks.enabled` (the 2026-07-06 portability
		// review flagged the surprise; independence is preserved for back-compat:
		// repos that disabled structural checks still expect the TDD gate to run).
		testFirstMode: structuralChecks?.test_first_mode,
	});
	return downgradeNewFileBlockToDebt(block, event, rules, filePath);
}

/**
 * Convert a new-file hard block into an opened coverage debt + allow when
 * `per_edit_coverage.debt_mode` is on; otherwise return the verdict (block /
 * null / unrelated) untouched. Split out of {@link evaluateTddNewFileGateForEvent}
 * so the wrapper stays a thin extract-and-call and the debt branch's
 * conditionals live in one cohesive function.
 */
function downgradeNewFileBlockToDebt(
	block: HarnessDecision | null,
	event: HarnessEvent,
	rules: GuardRulesConfig,
	filePath: string,
): HarnessDecision | null {
	// Not a new-file block (allow / null / unrelated rule) ⇒ pass through.
	// The layout-"none" portability demotion returns an ALLOW+warning that
	// carries this same rule_id — the decision check keeps it a pure warning
	// (never converted into an opened debt).
	if (!block || block.rule_id !== "tdd_new_file_gate" || block.decision !== "block") return block;
	// Debt mode off ⇒ keep the historical hard block.
	if (rules.per_edit_coverage?.debt_mode !== true) return block;
	// No cwd ⇒ can't resolve the ledger path; fall back to the hard block.
	const projectRoot = event.cwd;
	if (!projectRoot) return block;
	return openNewFileCoverageDebt(projectRoot, filePath, event.session_id);
}

/**
 * Open a coverage debt for a newly-created, test-less source file and ALLOW the
 * write. Uses the same ledger scheme as the per-edit gate: an `open`
 * `ObligationTxn` keyed by `kind:"coverage"` + the repo-relative path, appended
 * through {@link appendDebtTxn}. The obligation id is derived from kind+file
 * inside the engine's `applyObligationTxn`, so the subsequent `applyDebtMode`
 * calls discharge it when the companion test lands (optimistic) and block a
 * wander away from it in the meantime — no reimplementation here.
 */
function openNewFileCoverageDebt(
	projectRoot: string,
	filePath: string,
	sessionId: string,
): HarnessDecision {
	const relPath = relative(projectRoot, toAbsolute(filePath, projectRoot));
	const txn: ObligationTxn = {
		op: "open",
		kind: "coverage",
		file: relPath,
		contentHash: "",
		sessionId,
		atMs: Date.now(),
	};
	appendDebtTxn(projectRoot, txn);
	const companion = companionHintPath(relPath);
	return {
		decision: "allow",
		warnings: [
			`[interlinked:coverage] Opened coverage debt for ${relPath} — write its companion ` +
				`test (${companion}) next; don't move to an unrelated file until it's covered.`,
		],
	};
}

function isExemptPath(p: string): boolean {
	return isTddExemptPath(p);
}

/**
 * Public re-export of the same path-exemption check used by the new-file
 * gate. Behavioral checks (`checkTddCycleViolation`, `checkTddRegression`)
 * share this list so a file under `landing/` doesn't trip the cycle check
 * after slipping past the new-file gate, and vice versa. Keep both consumers
 * pointed at this helper so the exempt set stays single-sourced.
 */
export function isTddExemptPath(p: string): boolean {
	for (const re of EXEMPT_PATH_RES) {
		if (re.test(p)) return true;
	}
	return false;
}

function hasExemptDirective(content: string | undefined): boolean {
	if (!content) return false;
	return TDD_EXEMPT_DIRECTIVE_RE.test(content.slice(0, EXEMPT_DIRECTIVE_SCAN_BYTES));
}

/**
 * Public re-export of the same exempt-directive scan, with a non-optional
 * `content` parameter for call-sites that already have a string in hand.
 * Behavioral checks (e.g., assertion-density) honor the same
 * `// interlinked-tdd: exempt` convention as this gate so users don't have
 * to learn two opt-out mechanisms — keep these in sync by going through
 * this helper.
 */
export function hasTddExemptDirective(content: string): boolean {
	return TDD_EXEMPT_DIRECTIVE_RE.test(content.slice(0, EXEMPT_DIRECTIVE_SCAN_BYTES));
}

function toAbsolute(filePath: string, cwd: string | undefined): string {
	if (isAbsolute(filePath)) return filePath;
	return resolve(cwd || process.cwd(), filePath);
}

/** Whether the current session already wrote a companion test for `srcAbs` —
 *  an exact candidate path, or a qualified-name sibling in a candidate dir. */
function sessionWroteCompanion(
	args: TddNewFileGateArgs,
	srcAbs: string,
	candidates: string[],
): boolean {
	if (!args.session) return false;
	const writtenAbs = normalizedWrittenSet(args.session, args.cwd);
	const ext = extname(srcAbs);
	const base = basename(srcAbs, ext);
	const candidateDirs = new Set(candidates.map((c) => dirname(c)));
	for (const written of writtenAbs) {
		if (
			candidateDirs.has(dirname(written)) &&
			isCompanionFileName(basename(written), base, ext)
		) {
			return true;
		}
	}
	return false;
}


function shortest(abs: string, cwd: string | undefined): string {
	if (!cwd) return abs;
	const cwdAbs = resolve(cwd);
	if (abs.startsWith(cwdAbs + "/")) return abs.slice(cwdAbs.length + 1);
	return abs;
}

/** `session.files_written` stores whatever path shape the tool sent. Normalize
 *  to absolute so the comparison with our absolute candidates is reliable. */
function normalizedWrittenSet(
	session: SessionTrajectory,
	cwd: string | undefined,
): Set<string> {
	const out = new Set<string>();
	for (const p of session.files_written) {
		out.add(toAbsolute(p, cwd));
	}
	return out;
}
