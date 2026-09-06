// ===========================================
// Tests — project-wide sweep phase: transient-debt retirement
// ===========================================
// `runProjectWideSweepPhase` is already exercised end-to-end through the
// barrel in `post-tool-file-checks-phases.test.ts`. What no case there reaches
// is the RETIREMENT log: those runs sweep against a `/repo` fixture that owns
// no obligation ledger, so `sweepExpiredTransientDebts` returns an empty list
// and the reporting arm never runs.
//
// These cases give the phase a real ledger in a temp repo with one open
// transient debt, then hand it a whole-project tsc verdict that no longer
// reports the debt's diagnostic — the only evidence that retires a debt — and
// pin the line the daemon prints back.
//
// Only `runProjectWideChecksAsync` is stubbed (a real sweep would shell out to
// tsc); the ledger, the expiry rules and the formatter are the real ones.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { appendDebtTxn, readOpenTransientDebts } from "../obligation-ledger-io.js";
import { runProjectWideChecksAsync } from "../quality-checks.js";
import type { GuardRulesConfig, HarnessDecision } from "../types.js";
import type { PerFileCheckCtx } from "./post-tool-file-checks.js";
import { runProjectWideSweepPhase } from "./post-tool-project-wide-sweep.js";
import type { ServerRuntime } from "./runtime-context.js";

vi.mock("../quality-checks.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../quality-checks.js")>();
	return { ...actual, runProjectWideChecksAsync: vi.fn() };
});

// SAFETY: the vi.mock factory above replaced this export with vi.fn(), so the
// live binding really is a Mock; the declared type is the un-mocked signature.
const mRunProjectWide = runProjectWideChecksAsync as unknown as Mock;

let root = "";
let logs: string[] = [];

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "interlinked-sweep-"));
	mkdirSync(join(root, ".interlinked"), { recursive: true });
	logs = [];
	mRunProjectWide.mockReset();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Minimal runtime — the phase reads only these five fields.
 *  SAFETY: the full ServerRuntime declares ~30 daemon-scoped managers this
 *  code path never touches; the cast is confined to this fixture. */
function makeCtx(): ServerRuntime {
	return {
		cwd: root,
		interlinkedDir: join(root, ".interlinked"),
		// SAFETY: the phase reads only `rules.project_wide_checks`; the rest of
		// GuardRulesConfig is unreachable from this code path.
		rules: { project_wide_checks: { enabled: true } } as unknown as GuardRulesConfig,
		projectWideSweepState: {
			recordFileChecked: vi.fn(),
			recordEdit: vi.fn(() => true),
		},
		log: (msg: string) => void logs.push(msg),
		// SAFETY: see the field list above — every other ServerRuntime member is
		// unreachable from `runProjectWideSweepPhase`.
	} as unknown as ServerRuntime;
}

/** SAFETY: the phase reads `allCheckResults`, `projectWideSweepFired` and
 *  `markPhase` only; the other accumulator fields are inert here. */
function makeAcc(): PerFileCheckCtx {
	return {
		postStartMs: 0,
		allCheckResults: [],
		checksRan: [],
		postToolMetrics: [],
		markPhase: vi.fn(),
		projectWideSweepFired: false,
		recurrenceCursor: 0,
		// SAFETY: the accumulator's remaining fields are written by sibling
		// phases this test never runs.
	} as unknown as PerFileCheckCtx;
}

function openTransientDebt(file: string, detector?: string): void {
	appendDebtTxn(root, {
		op: "open",
		kind: "transient",
		file,
		contentHash: "h",
		sessionId: "s1",
		atMs: 1,
		...(detector === undefined ? {} : { detector }),
	});
}

/** A clean whole-project tsc verdict: tsc ran, nothing reproduces. */
function cleanTscSweep(): void {
	mRunProjectWide.mockResolvedValue({ findings: [], toolsRun: ["tsc"], elapsedMs: 12 });
}

describe("runProjectWideSweepPhase — transient-debt retirement", () => {
	it("names each retired debt by file and detector in the daemon log", async () => {
		openTransientDebt("src/a.ts", "TS18048");
		cleanTscSweep();

		await runProjectWideSweepPhase(
			makeCtx(),
			join(root, "src", "a.ts"),
			true,
			false,
			{ decision: "allow" },
			makeAcc(),
		);

		expect(logs).toContain(
			"Transient debt: expired 1 debt(s) a clean project typecheck no longer reproduces: src/a.ts [TS18048]",
		);
		expect(readOpenTransientDebts(root)).toEqual([]);
	});

	it("renders a debt that recorded no detector as `?` rather than dropping it", async () => {
		openTransientDebt("src/b.ts");
		cleanTscSweep();

		await runProjectWideSweepPhase(
			makeCtx(),
			join(root, "src", "b.ts"),
			true,
			false,
			{ decision: "allow" },
			makeAcc(),
		);

		expect(logs).toContain(
			"Transient debt: expired 1 debt(s) a clean project typecheck no longer reproduces: src/b.ts [?]",
		);
	});

	it("keeps a debt whose diagnostic the sweep still reports, and logs no retirement", async () => {
		openTransientDebt("src/a.ts", "TS18048");
		mRunProjectWide.mockResolvedValue({
			findings: [{ name: "typescript", severity: "error", file: "src/a.ts", message: "TS18048: still here" }],
			toolsRun: ["tsc"],
			elapsedMs: 20,
		});
		const decision: HarnessDecision = { decision: "allow" };

		await runProjectWideSweepPhase(
			makeCtx(),
			join(root, "src", "a.ts"),
			true,
			false,
			decision,
			makeAcc(),
		);

		expect(logs.filter((l) => l.startsWith("Transient debt:"))).toEqual([]);
		expect(readOpenTransientDebts(root).map((d) => d.detector)).toEqual(["TS18048"]);
	});
});
