// Kill evidence classes for Stryker kills (antithesis intake §7 steps 2–3;
// Antithesis's mutation skill asks whether a kill came from the intended
// property or from a crash or collateral failure).
//
// `classifyKill` reads the engine's `statusReason` text, never a cause:
//   - timeout   — the engine status says so;
//   - assertion — vitest's matcher grammar (`expected … to …`), `AssertionError`,
//                 or a snapshot mismatch;
//   - exception — a runtime-error message substring (`Cannot read propert…`,
//                 `… is not a function`, …). vitest's `statusReason` omits the
//                 error-class prefix, so the match keys on message text;
//   - unknown   — everything else, never guessed into a bucket.
// The assertion pattern is anchored at the start of the first line and runs
// first, so an assertion whose text quotes a runtime error stays an assertion.
//
// A class is a [heuristic] label: an unrelated assertion can fail, and an
// unexpected exception can correctly expose a real defect. The raw fields
// (`statusReason`, `killedBy`, `testsCompleted`) are the [proven] evidence and
// are retained by `stryker-evidence.ts`; mutation-score semantics do not use
// this module. Stryker's vitest runner bails after the first failing test, so
// `killedBy` usually names one test; `testsCompleted` says how many ran.
//
// Provenance is metadata only: a killing test whose path is mutation-directed
// (`MUTATION_DIRECTED_PATH`) is reported as such, never graded weaker — a
// filename cannot show when or why a test was written.
import { isJsonObject } from "../../lib/json-types.js";
import { MUTATION_DIRECTED_PATH } from "../checks/test-legitimacy.js";

export type KillClass = "assertion" | "exception" | "timeout" | "unknown";

export interface KillEvidenceRow {
	file: string;
	mutantId: string | null;
	status: "Killed" | "Timeout";
	killClass: KillClass;
	/** First line of `statusReason`, capped; null when the engine gave none. */
	reason: string | null;
	/** Killing test files resolved through `report.testFiles`; ids that resolve to no unique file are omitted. */
	killingTestFiles: string[];
	/** Number of `killedBy` ids that did not resolve to a unique test file. */
	unresolvedKillers: number;
	mutationDirectedKiller: boolean;
	testsCompleted: number | null;
}

export const REASON_MAX_CHARS = 200;

// Calibrated on 48,255 kills from 301 saved Stryker reports of this tree (2026-10-05,
// `scratch/kill-census/census.mts`). The matcher-precondition rows are the assertion
// library refusing a wrong-typed actual (`toContain(undefined)`), which is an assertion
// about the value's shape, not a crash in the code under test.
const ASSERTION_PATTERNS: readonly RegExp[] = [
	/^expected .+ to /i,
	/\bAssertionError\b/,
	/^Snapshot .* mismatched/i,
	/is invalid for this assertion/,
	/\.to\w+\(\) expects to receive /,
	/^actual value must be /,
	/^Target cannot be null or undefined/,
	/^promise (?:resolved|rejected) .+ instead of (?:rejecting|resolving)/,
];
const EXCEPTION_SUBSTRINGS: readonly string[] = [
	"Cannot read propert",
	"Cannot set propert",
	"Cannot destructure",
	"Cannot access '",
	"Cannot convert undefined or null to object",
	"is not a function",
	"is not a constructor",
	"is not defined",
	"is not iterable",
	"Maximum call stack size exceeded",
	"Invalid array length",
	"Unexpected end of JSON input",
	"is not valid JSON",
	"argument must be of type",
	"ENOENT: ",
	"EISDIR: ",
	"ENOTDIR: ",
];

export function firstReasonLine(statusReason: unknown): string | null {
	if (typeof statusReason !== "string") return null;
	const line = statusReason.trim().split("\n")[0]?.trim() ?? "";
	if (line === "") return null;
	return line.length <= REASON_MAX_CHARS ? line : `${line.slice(0, REASON_MAX_CHARS)}…`;
}

/** The message class of one kill. Statuses other than Killed / Timeout are not kills and classify as unknown. */
export function classifyKill(status: string, statusReason: unknown): KillClass {
	if (status === "Timeout") return "timeout";
	if (status !== "Killed") return "unknown";
	const line = firstReasonLine(statusReason);
	if (line === null) return "unknown";
	if (ASSERTION_PATTERNS.some((pattern) => pattern.test(line))) return "assertion";
	if (EXCEPTION_SUBSTRINGS.some((needle) => line.includes(needle))) return "exception";
	return "unknown";
}

/** Test id → test file, keeping only ids that occur in exactly one file entry. */
function testFileIndex(report: Record<string, unknown>): Map<string, string> {
	const seen = new Map<string, string | null>();
	if (!isJsonObject(report.testFiles)) return new Map();
	for (const [path, file] of Object.entries(report.testFiles)) {
		if (!isJsonObject(file) || !Array.isArray(file.tests)) continue;
		for (const test of file.tests) {
			if (!isJsonObject(test) || typeof test.id !== "string") continue;
			seen.set(test.id, seen.has(test.id) ? null : path);
		}
	}
	return new Map([...seen].filter((entry): entry is [string, string] => entry[1] !== null));
}

function killRow(file: string, mutant: Record<string, unknown>, tests: Map<string, string>): KillEvidenceRow | null {
	const status = mutant.status;
	if (status !== "Killed" && status !== "Timeout") return null;
	const ids = Array.isArray(mutant.killedBy) ? mutant.killedBy.filter((id): id is string => typeof id === "string") : [];
	const killingTestFiles = [...new Set(ids.flatMap((id) => tests.get(id) ?? []))].sort();
	const completed = mutant.testsCompleted;
	const testsCompleted = typeof completed === "number" && Number.isFinite(completed) ? completed : null;
	const mutantId = typeof mutant.id === "string" ? mutant.id : null;
	const unresolvedKillers = ids.filter((id) => !tests.has(id)).length;
	const mutationDirectedKiller = killingTestFiles.some((path) => MUTATION_DIRECTED_PATH.test(path));
	const killClass = classifyKill(status, mutant.statusReason);
	const reason = firstReasonLine(mutant.statusReason);
	return { file, mutantId, status, killClass, reason, killingTestFiles, unresolvedKillers, mutationDirectedKiller, testsCompleted };
}

function fileKillRows(file: string, entry: unknown, tests: Map<string, string>): KillEvidenceRow[] {
	if (!isJsonObject(entry) || !Array.isArray(entry.mutants)) return [];
	return entry.mutants.flatMap((mutant) => (isJsonObject(mutant) ? (killRow(file, mutant, tests) ?? []) : []));
}

/** One row per Killed / Timeout mutant of a Stryker mutation-testing-report-schema report. */
export function killEvidenceOf(report: unknown): KillEvidenceRow[] {
	if (!isJsonObject(report) || !isJsonObject(report.files)) return [];
	const tests = testFileIndex(report);
	return Object.entries(report.files).flatMap(([file, entry]) => fileKillRows(file, entry, tests));
}
