// ===========================================
// Characterize-before-touch gate (plan 25, lane 1)
// ===========================================
// The brownfield sibling of the new-file TDD gate: editing an EXISTING source
// file that sits on the untested-files list means no test pins its current
// behavior — so the edit is a behavior change with no safety net, which is
// exactly what makes legacy refactors dangerous. The gate asks for a
// characterization test FIRST (capture what the code does today with
// exact-value assertions), then the change lands against that net.
//
// Posture ladders with the enforcement mode (strict=block, balanced=warn,
// lenient=off) via `structural_checks.characterize_mode`. The untested list
// shrinks as files gain tests (adopt + the SessionEnd auto-fold maintain it),
// so the gate's reach shrinks with the debt — the goal end-state is a list,
// and therefore a gate, that never fires.
//
// Bypasses: the same `// interlinked-tdd: exempt` file-level directive the
// new-file gate honors (read from the ON-DISK file head — the exemption is a
// property of the file, not of one edit), and lenient/off mode.

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { loadUntestedFilesBaseline } from "../tested-file-policy.js";
import type { GuardRulesConfig, HarnessDecision, HarnessEvent, SessionTrajectory } from "../types.js";
import { companionTestCandidates } from "./companion-test.js";

const SOURCE_EXT_RE = /\.(ts|tsx|py)$/;
const TEST_PATH_RE =
	/(\.test\.tsx?|\.spec\.tsx?)$|(^|\/)__tests__\/|(^|\/)test_[^/]+\.py$|_test\.py$|(^|\/)tests\//;
/** Bytes of the on-disk head scanned for the exempt directive (matches the
 *  new-file gate's convention of a first-lines marker). */
const EXEMPT_SCAN_BYTES = 400;

type CharacterizeMode = "block" | "warn"| "off";

interface CharacterizeGateArgs {
	filePath: string;
	cwd?: string | undefined;
	session: SessionTrajectory | undefined;
	mode: CharacterizeMode | undefined;
}

function toAbsolute(p: string, cwd: string): string {
	return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

function repoRelativePosix(abs: string, cwd: string): string {
	return relative(cwd, abs).split(sep).join("/");
}

function onDiskHeadHasExempt(abs: string): boolean {
	try {
		return readFileSync(abs, "utf-8").slice(0, EXEMPT_SCAN_BYTES).includes("interlinked-tdd: exempt");
	} catch {
		return false; // unreadable head → no exemption evidence
	}
}

/** Python companion conventions (plan 25 parity): pytest's `test_<base>.py`
 *  beside the file, `<base>_test.py`, and a sibling or parent `tests/` dir. */
function pyCompanionCandidates(abs: string): string[] {
	const dir = abs.slice(0, abs.lastIndexOf(sep));
	const base = abs.slice(abs.lastIndexOf(sep) + 1).replace(/\.py$/i, "");
	const parent = dir.slice(0, dir.lastIndexOf(sep));
	return [
		resolve(dir, `test_${base}.py`),
		resolve(dir, `${base}_test.py`),
		resolve(dir, "tests", `test_${base}.py`),
		resolve(parent, "tests", `test_${base}.py`),
	];
}

function companionSatisfied(
	abs: string,
	projectRoot: string,
	session: SessionTrajectory | undefined,
): { satisfied: boolean; candidates: string[] } {
	const candidates = /\.py$/i.test(abs)
		? pyCompanionCandidates(abs)
		: companionTestCandidates(abs, projectRoot);
	for (const candidate of candidates) {
		if (existsSync(candidate)) return { satisfied: true, candidates };
	}
	if (session?.files_written) {
		const written = new Set<string>();
		for (const w of session.files_written) written.add(toAbsolute(w, projectRoot));
		for (const candidate of candidates) {
			if (written.has(resolve(candidate))) return { satisfied: true, candidates };
		}
	}
	return { satisfied: false, candidates };
}

/**
 * Core decision. Returns null when the gate does not apply; a `block` decision
 * in block mode; an allow-with-warning in warn mode.
 */
export function evaluateCharacterizeBeforeTouch(args: CharacterizeGateArgs): HarnessDecision | null {
	if (args.mode === "off" || args.mode === undefined) return null;
	if (!args.filePath || !SOURCE_EXT_RE.test(args.filePath)) return null;
	if (TEST_PATH_RE.test(args.filePath.split(sep).join("/"))) return null;

	const cwd = args.cwd || process.cwd();
	const abs = toAbsolute(args.filePath, cwd);
	// A file absent from disk is a CREATION — the new-file TDD gate owns that.
	if (!existsSync(abs)) return null;

	const baseline = loadUntestedFilesBaseline(cwd);
	if (!baseline) return null;
	const rel = repoRelativePosix(abs, cwd);
	if (!baseline.files.has(rel)) return null;

	if (onDiskHeadHasExempt(abs)) return null;

	const { satisfied, candidates } = companionSatisfied(abs, cwd, args.session);
	if (satisfied) return null;

	const shortCandidates = candidates.map((c) => repoRelativePosix(resolve(c), cwd)).join(", ");
	const body =
		`editing untested legacy file "${rel}" — it is on the untested-files list ` +
		`(.interlinked/untested-files-baseline.json), so NO test pins its current behavior. ` +
		`Write a characterization test FIRST: capture what the code does TODAY with ` +
		`exact-value assertions (searched: ${shortCandidates}), then make the change against ` +
		`that safety net — that is what keeps a refactor a refactor. Once the file has a ` +
		`companion, drop it from the untested list. File-level escape for genuinely ` +
		`untestable surfaces: "// interlinked-tdd: exempt" in the first lines. ` +
		`Posture: strict blocks, balanced warns, lenient off (interlinked mode <name>).`;

	if (args.mode === "block") {
		return {
			decision: "block",
			reason: `BLOCKED: ${body}`,
			rule_id: "characterize_before_touch",
			severity: "high",
			category: "tdd",
		};
	}
	return {
		decision: "allow",
		warnings: [`[interlinked:characterize] ${body}`],
		rule_id: "characterize_before_touch",
		severity: "low",
		category: "tdd",
	};
}

/** Event-shaped wrapper for the pre-tool pipeline: resolves the target path
 *  from the tool input and the mode from config (default "warn"). */
export function evaluateCharacterizeForEvent(
	event: HarnessEvent,
	rules: GuardRulesConfig,
	session: SessionTrajectory | undefined,
): HarnessDecision | null {
	const toolInput = event.tool_input ?? {};
	// SAFETY: hook payloads type tool_input values as unknown; both path keys
	// are strings when present, and non-strings fall through to "" (no gate).
	const filePath = (toolInput.file_path as string) || (toolInput.path as string) || "";
	const mode = rules.structural_checks.characterize_mode ?? "warn";
	return evaluateCharacterizeBeforeTouch({
		filePath,
		cwd: event.cwd,
		session,
		mode,
	});
}
