import { makeEvent as makeEventFixture } from "../__tests__/fixtures/evaluator.js";
import { nonNull } from "../../lib/non-null.js";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ingestReviewReport } from "../../commands/findings.js";
import { findingsCorpusPath, loadFindings } from "../findings/corpus.js";
import {
	loadReconciliation,
	reconciliationStateOf,
} from "../spec/reconciliation.js";
import {
	boundedAdd,
	disputedGroundWarning,
	openReviewFindings,
	recordReviewFindingTouches,
	resetReviewReconcileCacheForTesting,
	runReviewReconcilePhase,
	scanDisputedGroundRead,
} from "./review-reconcile-phase.js";

const roots: string[] = [];
afterEach(() => {
	for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

// `repoWithFindings` calls `ingestReviewReport` → `upsertFinding` →
// `recordFinding`, which mirrors every finding into
// `~/.interlinked/findings-corpus.jsonl` unless `INTERLINKED_HOME` redirects it.
// A tmp `cwd` is NOT enough: cwd governs only the per-repo corpus, while the
// global mirror resolves its own path and swallows every error, so the leak is
// silent and the test still passes. Measured 2026-08-09: this file alone
// appended 16 rows to the real user corpus per run. Same fix as
// `src/commands/findings.test.ts`.
let prevInterlinkedHome: string | undefined;
beforeEach(() => {
	prevInterlinkedHome = process.env.INTERLINKED_HOME;
	const fakeHome = mkdtempSync(join(tmpdir(), "recon-fake-home-"));
	roots.push(fakeHome);
	process.env.INTERLINKED_HOME = fakeHome;
});
afterEach(() => {
	if (prevInterlinkedHome === undefined) delete process.env.INTERLINKED_HOME;
	else process.env.INTERLINKED_HOME = prevInterlinkedHome;
});

beforeEach(() => resetReviewReconcileCacheForTesting());

function repoWithFindings(): string {
	// realpath: macOS tmpdir is a symlink (/var → /private/var); the read
	// scanner compares against process.cwd(), which returns the real path.
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "recon-phase-")));
	roots.push(cwd);
	const report = join(cwd, "review.md");
	writeFileSync(
		report,
		"1. [high] [docs/plan.md:5] The commit ordering is wrong.\n2. [low] Unanchored judgment.\nTOTAL: 2\n",
	);
	ingestReviewReport(report, "sol", cwd);
	return cwd;
}

describe("boundedAdd (round-2 #36)", () => {
	it("clears the set at the cap so it cannot grow unbounded", () => {
		const set = new Set<string>();
		for (let i = 0; i < 5; i++) boundedAdd(set, `k${i}`, 3);
		// At size 3 the 4th add cleared it; final size ≤ cap.
		expect(set.size).toBeLessThanOrEqual(3);
		expect(set.has("k4")).toBe(true);
	});
});

describe("review reconciliation hooks", () => {
	it("invalidates its cache when an external process changes the state files (deep-round #13)", () => {
		const cwd = repoWithFindings();
		expect(openReviewFindings(cwd)).toHaveLength(2); // warm the cache
		// Simulate an external `interlinked findings ack` process: append a
		// reconciliation txn directly, changing the sidecar's mtime.
		const first = nonNull(openReviewFindings(cwd)[0]);
		// Small delay so mtimeMs actually advances, then ack out-of-band.
		const recon = join(cwd, ".interlinked", "findings", "reconciliation.jsonl");
		writeFileSync(
			recon,
			`${JSON.stringify({ finding_id: first.id, action: "acked", by: "ext", ts: "2026-07-16T00:00:00Z" })}\n`,
		);
		// Next read sees the new mtime and reloads — the acked finding is gone.
		expect(openReviewFindings(cwd).some((f) => f.id === first.id)).toBe(false);
	});

	it("an edit to the finding's file records a touch (never 'resolved')", () => {
		const cwd = repoWithFindings();
		expect(openReviewFindings(cwd)).toHaveLength(2);
		recordReviewFindingTouches(cwd, "s1", join(cwd, "docs/plan.md"));
		const recon = loadReconciliation(cwd);
		const anchored = openReviewFindings(cwd);
		// The anchored finding left the open set; the unanchored one remains.
		expect(anchored).toHaveLength(1);
		expect(anchored[0]?.file).not.toBe("docs/plan.md");
		const touchedId = [...recon.keys()][0];
		expect(touchedId && reconciliationStateOf(recon, touchedId)).toBe("touched");
	});

	it("disputed-ground warns once per session+MODE+file (round-5 #5)", () => {
		const cwd = repoWithFindings();
		const w1 = disputedGroundWarning(cwd, "s1", join(cwd, "docs/plan.md"), "read");
		expect(w1).toContain("disputed-ground");
		expect(w1).toContain("docs/plan.md");
		expect(w1).toContain("ack");
		// An earlier read must NOT swallow the later, more consequential
		// write warning — separate anti-compounding channels.
		expect(
			disputedGroundWarning(cwd, "s1", join(cwd, "docs/plan.md"), "write"),
		).toContain("building on disputed ground");
		// But each channel nags at most once.
		expect(
			disputedGroundWarning(cwd, "s1", join(cwd, "docs/plan.md"), "read"),
		).toBeNull();
		expect(
			disputedGroundWarning(cwd, "s1", join(cwd, "docs/plan.md"), "write"),
		).toBeNull();
	});

	it("a ranged read only disputes findings its range overlaps (round-5 #6)", () => {
		const cwd = repoWithFindings();
		// Finding cites docs/plan.md:5 — a read of lines 100-200 is clean.
		expect(
			disputedGroundWarning(cwd, "s7", join(cwd, "docs/plan.md"), "read", {
				start: 100,
				end: 200,
			}),
		).toBeNull();
		// A read covering line 5 warns.
		expect(
			disputedGroundWarning(cwd, "s7", join(cwd, "docs/plan.md"), "read", {
				start: 1,
				end: 20,
			}),
		).toContain("disputed-ground");
	});

	it("span-aware touches skip line-anchored findings outside edited ranges (round-5 #1)", () => {
		const cwd = repoWithFindings();
		// Edit far from the cited line 5: the anchored finding stays open.
		recordReviewFindingTouches(cwd, "s8", join(cwd, "docs/plan.md"), [
			{ start: 400, end: 420 },
		]);
		expect(openReviewFindings(cwd).some((f) => f.file === "docs/plan.md")).toBe(
			true,
		);
		// An overlapping edit (±3 slack) records the touch.
		recordReviewFindingTouches(cwd, "s8", join(cwd, "docs/plan.md"), [
			{ start: 4, end: 6 },
		]);
		expect(openReviewFindings(cwd).some((f) => f.file === "docs/plan.md")).toBe(
			false,
		);
	});

	it("the write phase touches findings and appends one warning", () => {
		const cwd = repoWithFindings();
		const decision: { warnings?: string[] } = {};
		runReviewReconcilePhase(cwd, "s1", join(cwd, "docs/plan.md"), true, decision);
		expect(decision.warnings?.[0]).toContain("disputed-ground");
		expect(openReviewFindings(cwd).some((f) => f.file === "docs/plan.md")).toBe(false);
		// Out-of-repo / non-repo edits are inert.
		const d2: { warnings?: string[] } = {};
		runReviewReconcilePhase(cwd, "s1", "", false, d2);
		expect(d2.warnings).toBeUndefined();
	});

	it("the read scanner warns via the PostToolUse evaluator shape", () => {
		const cwd = repoWithFindings();
		// SPY, not process.chdir(): chdir THROWS in a worker thread
		// ("process.chdir() is not supported in workers"), and Stryker's vitest
		// runner pins its own pool, so a real chdir here fails the mutation dry
		// run for any file whose graph-selected test scope includes this one.
		// scanDisputedGroundRead falls back to `process.cwd()` when the event
		// carries no `cwd`, so the spy exercises the same path.
		const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cwd);
		try {
			const warnings = scanDisputedGroundRead({ ...makeEventFixture({ tool_name: undefined, tool_input: undefined }),
				hook_event: "PostToolUse",
				session_id: "s9",
				tool_name: "Read",
				tool_input: { file_path: join(cwd, "docs/plan.md") },
			});
			expect(warnings[0]).toContain("reading from disputed ground");
			expect(
				scanDisputedGroundRead({ ...makeEventFixture({ tool_name: undefined, tool_input: undefined }),
					hook_event: "PostToolUse",
					session_id: "s9",
					tool_name: "Bash",
					tool_input: { command: "ls" },
				}),
			).toEqual([]);
		} finally {
			cwdSpy.mockRestore();
		}
	});

	it("reports nothing instead of throwing when the corpus itself is unreadable", () => {
		const cwd = realpathSync(mkdtempSync(join(tmpdir(), "recon-unreadable-")));
		roots.push(cwd);
		// A directory where the corpus file belongs: the loader's existsSync gate
		// passes and the read then fails — the real unreadable-corpus fault.
		mkdirSync(findingsCorpusPath(cwd), { recursive: true });
		expect(() => loadFindings(cwd)).toThrow(/EISDIR/);
		expect(openReviewFindings(cwd)).toEqual([]);
		expect(
			disputedGroundWarning(cwd, "s-unreadable", join(cwd, "docs/plan.md"), "read"),
		).toBeNull();
	});

	it("stays silent for clean files, out-of-repo paths, and empty corpora", () => {
		const cwd = repoWithFindings();
		expect(disputedGroundWarning(cwd, "s1", join(cwd, "other.md"), "read")).toBeNull();
		expect(disputedGroundWarning(cwd, "s1", "/etc/passwd", "read")).toBeNull();
		const empty = mkdtempSync(join(tmpdir(), "recon-empty-"));
		roots.push(empty);
		expect(
			disputedGroundWarning(empty, "s1", join(empty, "a.md"), "read"),
		).toBeNull();
	});
});
