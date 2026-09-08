import { wireLiteral, wireNullable, wireString } from "../lib/value-validation.js";
import { parseWire, wireArray, wireNumber, wireObject, wireUnknown } from "../lib/value-validation.js";
// `interlinked harness health` — command-level tests over a small synthetic
// recurrences.jsonl fixture. The aggregation math is pinned in
// src/harness/check-health.test.ts; these verify the streaming read, the
// rendering, and the output-mode contract.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { harnessHealthCommand } from "./harness-health.js";

let dir: string;
let throwNonErrorFromCreateReadStream = false;

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		createReadStream: (...args: Parameters<typeof actual.createReadStream>) => {
			if (throwNonErrorFromCreateReadStream) {
				// Deliberately non-Error throw to exercise the
				// `err instanceof Error ? err.message : String(err)` false arm.
				throw "boom, not an Error object";
			}
			return actual.createReadStream(...args);
		},
	};
});

/** Run `fn` and return everything it wrote to console.log, joined by newlines. */
async function capture(fn: () => Promise<void>): Promise<string> {
	const spy = vi.spyOn(console, "log").mockImplementation(() => {});
	try {
		await fn();
		return spy.mock.calls.map((c) => c.join(" ")).join("\n");
	} finally {
		spy.mockRestore();
	}
}

function writeLog(lines: string[]): void {
	mkdirSync(join(dir, ".interlinked"), { recursive: true });
	writeFileSync(join(dir, ".interlinked", "recurrences.jsonl"), `${lines.join("\n")}\n`, "utf-8");
}

function caughtLine(checkId: string, file: string, message: string, session: string): string {
	return JSON.stringify({
		ts: "2026-06-01T00:00:00.000Z",
		kind: "harness_caught",
		check_id: checkId,
		agent_source: "claude",
		session_id: session,
		file,
		message,
	});
}

/** 12 findings × 6 re-fires each — clears every probation threshold for a
 *  heuristic check id. `agent_thumbprint_prose` is registry-heuristic today. */
function noisyFixtureLines(checkId: string): string[] {
	const lines: string[] = [];
	for (let f = 0; f < 12; f++) {
		for (let r = 0; r < 6; r++) {
			lines.push(caughtLine(checkId, `src/f${f}.ts`, `finding ${f}`, `s-${r % 4}`));
		}
	}
	return lines;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "interlinked-health-"));
	vi.spyOn(process, "cwd").mockReturnValue(dir);
});

afterEach(() => {
	vi.restoreAllMocks();
	rmSync(dir, { recursive: true, force: true });
});

describe("harnessHealthCommand", () => {
	it("reports gracefully when no recurrence log exists yet", async () => {
		const out = await capture(() => harnessHealthCommand({}));
		expect(out).toContain("No recurrence log");
	});

	it("streams the log, skips torn lines, and flags heuristic probation candidates with WHY", async () => {
		writeLog([
			...noisyFixtureLines("agent_thumbprint_prose"),
			'{"ts":"2026-06-01T00:00:00Z","kind":"harness_ca', // torn tail — must not abort
			"",
		]);
		const out = await capture(() => harnessHealthCommand({}));
		expect(out).toContain("agent_thumbprint_prose");
		expect(out).toContain("PROBATION");
		expect(out).toContain("72 events / 12 unique / 4 sessions");
	});

	it("does not flag a proven check id with the same noisy stats", async () => {
		// `typescript` is on the PROVEN_TOOL_CHECKS allow-list.
		writeLog(noisyFixtureLines("typescript"));
		const out = await capture(() => harnessHealthCommand({}));
		expect(out).toContain("typescript");
		expect(out).not.toContain("PROBATION");
	});

	it("--json emits rows sorted by repeat-rate with status + why per check", async () => {
		writeLog([
			...noisyFixtureLines("agent_thumbprint_prose"),
			caughtLine("quiet_check", "src/x.ts", "one-off", "s-1"),
		]);
		const out = await capture(() => harnessHealthCommand({ json: true }));
		const parsed = parseWire(JSON.parse(out), wireObject({ "checks": wireArray(wireObject({ "check_id": wireString, "events": wireNumber, "unique_findings": wireNumber, "sessions": wireNumber, "first_seen": wireString, "last_seen": wireString, "repeat_rate": wireNumber, "determinism": wireNullable(wireLiteral("proven", "heuristic")), "status": wireLiteral("probation-candidate", "healthy", "low-data"), "why": wireString })), "probation_candidates": wireNumber }), "test JSON value");
		expect(parsed.checks.map((c) => c.check_id)).toEqual([
			"agent_thumbprint_prose",
			"quiet_check",
		]);
		expect(parsed.checks[0]?.status).toBe("probation-candidate");
		expect(parsed.checks[0]?.why).toContain("72 events / 12 unique / 4 sessions");
		expect(parsed.checks[1]?.status).toBe("low-data");
		expect(parsed.probation_candidates).toBe(1);
	});

	it("--short is a single summary line", async () => {
		writeLog(noisyFixtureLines("agent_thumbprint_prose"));
		const out = await capture(() => harnessHealthCommand({ short: true }));
		expect(out.trim()).not.toContain("\n");
		expect(out).toContain("1 probation candidate");
	});

	it("--json with no recurrence log emits the empty-state json shape", async () => {
		const out = await capture(() => harnessHealthCommand({ json: true }));
		const parsed = parseWire(JSON.parse(out), wireObject({ "checks": wireArray(wireUnknown), "probation_candidates": wireNumber }), "test JSON value");
		expect(parsed).toEqual({ checks: [], probation_candidates: 0 });
	});

	it("--full renders every check id (no row limit) instead of the normal-mode cap", async () => {
		writeLog([
			...noisyFixtureLines("agent_thumbprint_prose"),
			caughtLine("quiet_check", "src/x.ts", "one-off", "s-1"),
		]);
		const out = await capture(() => harnessHealthCommand({ full: true }));
		expect(out).toContain("agent_thumbprint_prose");
		expect(out).toContain("quiet_check");
		expect(out).not.toContain("more (use --full)");
	});

	it("normal mode truncates past NORMAL_MODE_ROW_LIMIT and prints the '… more' hint", async () => {
		const lines: string[] = [];
		for (let i = 0; i < 30; i++) {
			lines.push(caughtLine(`check_${i}`, "src/x.ts", "one-off", "s-1"));
		}
		writeLog(lines);
		const out = await capture(() => harnessHealthCommand({}));
		expect(out).toContain("… 5 more (use --full)");
	});

	it("renders 'unknown' determinism for a check id with no registry/tool classification", async () => {
		writeLog(noisyFixtureLines("totally_unknown_check_xyz"));
		const out = await capture(() => harnessHealthCommand({}));
		expect(out).toContain("unknown");
	});

	it("renders the 'healthy' status cell for a check with enough events but no probation signal", async () => {
		// `typescript` is a proven check id — never demoted, so a noisy fixture
		// still reads as healthy (not low-data, since events >= LOW_DATA_EVENT_FLOOR).
		writeLog(noisyFixtureLines("typescript"));
		const out = await capture(() => harnessHealthCommand({}));
		expect(out).toContain("healthy");
	});

	it("renders the 'low-data' status cell in normal (non-json) mode", async () => {
		writeLog([caughtLine("quiet_check", "src/x.ts", "one-off", "s-1")]);
		const out = await capture(() => harnessHealthCommand({}));
		expect(out).toContain("low-data");
	});

	it("reports a stringified error when a non-Error value is thrown (err instanceof Error is false)", async () => {
		writeLog([caughtLine("quiet_check", "src/x.ts", "one-off", "s-1")]);
		throwNonErrorFromCreateReadStream = true;
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const priorExitCode = process.exitCode;
		try {
			await harnessHealthCommand({});
			expect(errSpy.mock.calls.map((c) => c.join(" ")).join("\n")).toContain(
				"boom, not an Error object",
			);
			expect(process.exitCode).toBe(1);
		} finally {
			errSpy.mockRestore();
			throwNonErrorFromCreateReadStream = false;
			process.exitCode = priorExitCode;
		}
	});

	it("reports an error when the log path cannot be streamed (e.g. a directory, not a file)", async () => {
		// Make the "log" a directory instead of a file so createReadStream fails
		// (EISDIR) once aggregateHealthFromLog actually tries to read it.
		mkdirSync(join(dir, ".interlinked", "recurrences.jsonl"), { recursive: true });
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const priorExitCode = process.exitCode;
		try {
			await harnessHealthCommand({});
			expect(errSpy.mock.calls.map((c) => c.join(" ")).join("\n")).toContain("Error:");
			expect(process.exitCode).toBe(1);
		} finally {
			errSpy.mockRestore();
			process.exitCode = priorExitCode;
		}
	});
});
