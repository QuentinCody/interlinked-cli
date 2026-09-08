import { makeSession as completeSessionFixture, makeMinimalEvent as completeEventFixture } from "./__tests__/fixtures/evaluator.js";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeGuardRules } from "./evaluator/__tests__/fixtures.js";
import type { FoldKind, FoldOutcome } from "./baseline-autofold-folds.js";

const mocks = vi.hoisted(() => ({
	foldCoverage: vi.fn<typeof import("./baseline-autofold-folds.js").foldCoverage>(),
	foldUntestedFiles: vi.fn<typeof import("./baseline-autofold-folds.js").foldUntestedFiles>(),
	foldLargeFiles: vi.fn<typeof import("./baseline-autofold-folds.js").foldLargeFiles>(),
	toRepoRelative: vi.fn<typeof import("./baseline-autofold-folds.js").toRepoRelative>(),
}));

vi.mock("./baseline-autofold-folds.js", () => ({
	foldCoverage: mocks.foldCoverage,
	foldUntestedFiles: mocks.foldUntestedFiles,
	foldLargeFiles: mocks.foldLargeFiles,
	toRepoRelative: mocks.toRepoRelative,
}));

import {
	BASELINE_FOLD_LOG_REL,
	runBaselineAutoFold,
	runSessionEndBaselineAutoFold,
	sessionStartMs,
} from "./baseline-autofold.js";
import type { HarnessEvent, SessionTrajectory } from "./types.js";

function noChangeOutcome(kind: FoldKind): FoldOutcome {
	return { kind, changed: 0, refused: 0, skipped: "no-change", details: [], dryRun: false };
}

describe("sessionStartMs", () => {
	it("parses a defined started_at instead of collapsing it to '' (?? -> && mutant)", () => {
		const iso = "2026-01-01T00:00:00.000Z";
		const session = ({ ...completeSessionFixture(), ...{ started_at: iso } });
		expect(sessionStartMs(session)).toBe(Date.parse(iso));
		expect(sessionStartMs(session)).not.toBe(0);
	});

	it("does not throw for an undefined session (kills removed optional chaining)", () => {
		expect(() => sessionStartMs(undefined)).not.toThrow();
		expect(sessionStartMs(undefined)).toBe(0);
	});
});

describe("runBaselineAutoFold", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "autofold-"));
		mocks.foldCoverage.mockReset();
		mocks.foldUntestedFiles.mockReset();
		mocks.foldLargeFiles.mockReset();
		mocks.toRepoRelative.mockReset();
		mocks.toRepoRelative.mockImplementation((_cwd, files) => [...files]);
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("invokes each fold with its full args object, not an emptied one", () => {
		mocks.foldCoverage.mockReturnValue(noChangeOutcome("coverage"));
		mocks.foldUntestedFiles.mockReturnValue(noChangeOutcome("untested_files"));
		mocks.foldLargeFiles.mockReturnValue(noChangeOutcome("large_files"));

		runBaselineAutoFold({
			cwd,
			sessionId: "s1",
			touched: ["a.ts"],
			sessionStartMs: 12345,
			dryRun: false,
		});

		expect(mocks.foldCoverage).toHaveBeenCalledTimes(1);
		expect(mocks.foldCoverage).toHaveBeenCalledWith({
			cwd,
			interlinkedDir: join(cwd, ".interlinked"),
			sessionStartMs: 12345,
			dryRun: false,
		});

		expect(mocks.foldLargeFiles).toHaveBeenCalledTimes(1);
		expect(mocks.foldLargeFiles).toHaveBeenCalledWith({
			cwd,
			touched: ["a.ts"],
			dryRun: false,
		});
	});

	it("labels a budget-exhausted fold with its real kind, not empty strings", () => {
		mocks.foldCoverage.mockReturnValue(noChangeOutcome("coverage"));
		mocks.foldUntestedFiles.mockReturnValue(noChangeOutcome("untested_files"));
		mocks.foldLargeFiles.mockReturnValue(noChangeOutcome("large_files"));

		let call = 0;
		const now = () => {
			call += 1;
			// First call establishes startedMs=0; every later call is already past
			// the (tiny) deadline, so every fold is skipped via budgetedOutcome(kind).
			return call === 1 ? 0 : 999_999;
		};

		const result = runBaselineAutoFold({
			cwd,
			sessionId: "s1",
			touched: [],
			sessionStartMs: 0,
			dryRun: false,
			budgetMs: 10,
			now,
		});

		expect(result.outcomes.map((o) => o.kind)).toEqual([
			"coverage",
			// coverage_edit joined the fold plan in 2379f19 (edit-baseline gained
			// an always-on SessionEnd producer).
			"coverage_edit",
			"untested_files",
			"large_files",
		]);
		for (const outcome of result.outcomes) {
			expect(outcome.skipped).toBe("budget");
		}
		expect(mocks.foldCoverage).not.toHaveBeenCalled();
	});

	it("uses opts.budgetMs verbatim even when it is truthy (?? -> && on the budget)", () => {
		mocks.foldCoverage.mockReturnValue(noChangeOutcome("coverage"));
		mocks.foldUntestedFiles.mockReturnValue(noChangeOutcome("untested_files"));
		mocks.foldLargeFiles.mockReturnValue(noChangeOutcome("large_files"));

		let call = 0;
		const now = () => {
			call += 1;
			// startedMs = 0. With budgetMs:1000 kept verbatim (??), deadline=1000, so
			// the second call (1500) is already past it and every fold is skipped.
			// The && mutant discards 1000 and falls back to DEFAULT_AUTOFOLD_BUDGET_MS
			// (2000), so deadline=2000 and 1500 is still inside budget -> folds run.
			return call === 1 ? 0 : 1500;
		};

		runBaselineAutoFold({
			cwd,
			sessionId: "s1",
			touched: [],
			sessionStartMs: 0,
			dryRun: false,
			budgetMs: 1000,
			now,
		});

		expect(mocks.foldCoverage).not.toHaveBeenCalled();
	});

	it("converts a thrown fold into the exact no-change skip shape", () => {
		mocks.foldCoverage.mockImplementation(() => {
			throw new Error("boom");
		});
		mocks.foldUntestedFiles.mockReturnValue(noChangeOutcome("untested_files"));
		mocks.foldLargeFiles.mockReturnValue(noChangeOutcome("large_files"));

		const result = runBaselineAutoFold({
			cwd,
			sessionId: "s1",
			touched: [],
			sessionStartMs: 0,
			dryRun: false,
		});

		expect(result.outcomes[0]).toEqual({
			kind: "coverage",
			changed: 0,
			refused: 0,
			skipped: "no-change",
			details: [],
			dryRun: false,
		});
	});
});

describe("runSessionEndBaselineAutoFold", () => {
	let cwd: string;
	let logs: string[];

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "autofold-end-"));
		logs = [];
		mocks.foldCoverage.mockReset();
		mocks.foldUntestedFiles.mockReset();
		mocks.foldLargeFiles.mockReset();
		mocks.toRepoRelative.mockReset();
		mocks.toRepoRelative.mockImplementation((_cwd, files) => [...files]);
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	function baseOpts(
		overrides: {
			session?: SessionTrajectory | undefined;
			event?: HarnessEvent;
		} = {},
	) {
		return {
			cwd,
			rules: makeGuardRules(),
			log: (msg: string) => logs.push(msg),
			event: overrides.event ?? (({ ...completeEventFixture(), ...{ session_id: "s1", dry_run: false } })),
			session: overrides.session,
		};
	}

	it("does not throw when session is undefined (kills removed optional chaining)", () => {
		mocks.foldCoverage.mockReturnValue(noChangeOutcome("coverage"));
		mocks.foldUntestedFiles.mockReturnValue(noChangeOutcome("untested_files"));
		mocks.foldLargeFiles.mockReturnValue(noChangeOutcome("large_files"));

		const result = runSessionEndBaselineAutoFold(baseOpts());

		expect(result).toEqual([]);
		expect(logs.some((l) => l.includes("failed"))).toBe(false);
	});

	it("folds an empty file list when there is no session", () => {
		mocks.foldCoverage.mockReturnValue(noChangeOutcome("coverage"));
		mocks.foldUntestedFiles.mockReturnValue(noChangeOutcome("untested_files"));
		mocks.foldLargeFiles.mockReturnValue(noChangeOutcome("large_files"));

		runSessionEndBaselineAutoFold(baseOpts());

		expect(mocks.toRepoRelative).toHaveBeenCalledTimes(1);
		expect(mocks.toRepoRelative).toHaveBeenCalledWith(cwd, []);
	});

	it('falls back the session id to "unknown" and writes it to the audit row (not-a-dry-run write)', () => {
		mocks.foldCoverage.mockReturnValue({
			kind: "coverage",
			changed: 1,
			refused: 0,
			skipped: null,
			details: ["x"],
			dryRun: false,
		});
		mocks.foldUntestedFiles.mockReturnValue(noChangeOutcome("untested_files"));
		mocks.foldLargeFiles.mockReturnValue(noChangeOutcome("large_files"));

		runSessionEndBaselineAutoFold(
			baseOpts({ event: ({ ...completeEventFixture(), ...{ session_id: "", dry_run: false } }) }),
		);

		const logPath = join(cwd, BASELINE_FOLD_LOG_REL);
		expect(existsSync(logPath)).toBe(true);
		const firstLine = readFileSync(logPath, "utf-8").trim().split("\n")[0] ?? "";
		const row = JSON.parse(firstLine);
		expect(row.session).toBe("unknown");
	});
});
