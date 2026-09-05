import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { SpecLedger } from "../spec/ledger.js";
import type { HarnessDecision, SessionTrajectory } from "../types.js";
import type { PerFileCheckCtx } from "./post-tool-file-checks.js";
import type { ServerRuntime } from "./runtime-context.js";
import { prerefreshSpecLedger, runSpecLedgerPhase } from "./spec-ledger-phase.js";

const PLAN = [
	"# Plan",
	"## The seven bets",
	"| **B1** | a |",
	"| **B2** | b |",
	"| **B3** | c |",
	"| **B4** | d |",
	"| **B5** | e |",
	"| **B6** | f |",
	"| **B7** | g |",
].join("\n");

const README = "# README\nThe composition of six bets does the work.\n";

function makeFixture(): {
	root: string;
	ctx: ServerRuntime;
	session: SessionTrajectory;
	decision: HarnessDecision;
	acc: PerFileCheckCtx;
} {
	const root = mkdtempSync(join(tmpdir(), "spec-phase-"));
	writeFileSync(join(root, "PLAN.md"), PLAN);
	writeFileSync(join(root, "README.md"), README);
	// SAFETY: the phase reads only cwd/rules/log/specLedger from the runtime
	// and pending_completions/tool_call_count/spec_drift_outstanding from the
	// session — a minimal fixture keeps this test independent of the full
	// server bootstrap (same pattern as post-tool-file-checks-phases.test.ts).
	const ctx = {
		cwd: root,
		rules: { spec_checks: { enabled: true } },
		log: () => {},
		specLedger: null,
	} as unknown as ServerRuntime;
	const session = {
		pending_completions: new Map(),
		tool_call_count: 3,
	} as unknown as SessionTrajectory;
	const decision: HarnessDecision = { decision: "allow" };
	// SAFETY: the phase touches only allCheckResults/checksRan on the
	// accumulator; the remaining PerFileCheckCtx fields are unused here.
	const acc = {
		allCheckResults: [],
		checksRan: [],
	} as unknown as PerFileCheckCtx;
	return { root, ctx, session, decision, acc };
}

describe("runSpecLedgerPhase", () => {
	const fixtures: string[] = [];
	afterAll(() => {
		for (const root of fixtures) rmSync(root, { recursive: true, force: true });
	});

	it("resolves in-root symlink aliases to the walked ledger key (round-2 #13)", async () => {
		const { mkdirSync: mkdir, symlinkSync } = await import("node:fs");
		const { root, ctx, session, decision, acc } = makeFixture();
		fixtures.push(root);
		mkdir(join(root, "docs"), { recursive: true });
		writeFileSync(join(root, "docs", "a.md"), "# A\n| X-01 | a |\n| X-02 | b |");
		symlinkSync(join(root, "docs"), join(root, "alias"), "dir");
		// Refresh through the real path AND the alias: canonicalization must
		// yield ONE ledger key (docs/a.md), not a duplicate alias/a.md (#13).
		prerefreshSpecLedger(ctx, [
			join(root, "docs", "a.md"),
			join(root, "alias", "a.md"),
		]);
		const ledger = ctx.specLedger as { fileList(): string[] } | null | undefined;
		const keys = ledger?.fileList() ?? [];
		// The alias resolved to the real path: docs/a.md present exactly once,
		// no duplicate alias/a.md key.
		expect(keys).toContain("docs/a.md");
		expect(keys.filter((k) => k.endsWith("a.md"))).toEqual(["docs/a.md"]);
		// Also exercises the canonicalPath fallback branch: a not-on-disk path
		// → realpath throws → lexical key. The phase must not throw.
		expect(() =>
			runSpecLedgerPhase(ctx, join(root, "gone.md"), true, session, decision, acc),
		).not.toThrow();
	});

	it("prerefreshSpecLedger evaluates a multi-file patch against final state (deep-round #3)", () => {
		const { root, ctx, session, decision, acc } = makeFixture();
		fixtures.push(root);
		// One patch fixes BOTH sides: plan gains a 7th bet, README updates
		// six→seven. Evaluated against final state, there is no drift — without
		// the pre-pass, processing README first would compare it to the stale
		// 6-bet plan and warn spuriously.
		writeFileSync(
			join(root, "PLAN.md"),
			"## The seven bets\n| B1 | a |\n| B2 | b |\n| B3 | c |\n| B4 | d |\n| B5 | e |\n| B6 | f |\n| B7 | g |",
		);
		writeFileSync(join(root, "README.md"), "# README\nThe composition of seven bets.\n");
		prerefreshSpecLedger(ctx, [join(root, "PLAN.md"), join(root, "README.md")]);
		runSpecLedgerPhase(ctx, join(root, "README.md"), true, session, decision, acc);
		expect(decision.warnings ?? []).toEqual([]);
	});

	it("editing the registry file records heuristic drift without imposing sibling obligations", () => {
		const { root, ctx, session, decision, acc } = makeFixture();
		fixtures.push(root);
		runSpecLedgerPhase(ctx, join(root, "PLAN.md"), true, session, decision, acc);
		expect(decision.warnings?.some((w) => w.includes("six bets"))).toBe(true);
		expect(decision.warnings?.[0]).toContain("[interlinked:spec-drift]");
		expect(acc.checksRan).toContain("spec_ledger");
		expect(acc.allCheckResults[0]).toEqual(
			expect.objectContaining({ source: "spec", severity: "warning" }),
		);
		// A heuristic binding is review evidence, not an obligation to edit a sibling.
		const keys = [...session.pending_completions.keys()];
		expect(keys.some((k) => k.startsWith("spec:count_claim_drift:README.md"))).toBe(
			false,
		);
		expect(session.spec_drift_outstanding?.length).toBeGreaterThan(0);
	});

	it("does nothing for non-markdown edits, disabled config, or out-of-repo files", () => {
		const { root, ctx, session, decision, acc } = makeFixture();
		fixtures.push(root);
		runSpecLedgerPhase(ctx, join(root, "code.ts"), true, session, decision, acc);
		expect(decision.warnings).toBeUndefined();

		const disabled = makeFixture();
		fixtures.push(disabled.root);
		// SAFETY: minimal fixture — see above.
		(disabled.ctx as { rules: { spec_checks: { enabled: boolean } } }).rules =
			{ spec_checks: { enabled: false } };
		runSpecLedgerPhase(
			disabled.ctx,
			join(disabled.root, "PLAN.md"),
			true,
			disabled.session,
			disabled.decision,
			disabled.acc,
		);
		expect(disabled.decision.warnings).toBeUndefined();

		const outOfRepo = makeFixture();
		fixtures.push(outOfRepo.root);
		runSpecLedgerPhase(
			outOfRepo.ctx,
			join(outOfRepo.root, "PLAN.md"),
			false,
			outOfRepo.session,
			outOfRepo.decision,
			outOfRepo.acc,
		);
		expect(outOfRepo.decision.warnings).toBeUndefined();
	});

	it("an unrelated markdown edit never erases the outstanding stash (round-4 #1)", () => {
		const { root, ctx, session, decision, acc } = makeFixture();
		fixtures.push(root);
		runSpecLedgerPhase(ctx, join(root, "PLAN.md"), true, session, decision, acc);
		expect(session.spec_drift_outstanding?.length).toBeGreaterThan(0);
		// Now edit an unrelated markdown file with no findings of its own.
		writeFileSync(join(root, "NOTES.md"), "# Notes\nplain text\n");
		const decision2: HarnessDecision = { decision: "allow" };
		runSpecLedgerPhase(ctx, join(root, "NOTES.md"), true, session, decision2, acc);
		expect(decision2.warnings).toBeUndefined();
		expect(
			session.spec_drift_outstanding?.some((f) => f.file === "README.md"),
		).toBe(true);
	});

	it("clears the stash when the drift is resolved and never throws on fs errors", () => {
		const { root, ctx, session, decision, acc } = makeFixture();
		fixtures.push(root);
		writeFileSync(join(root, "README.md"), "# README\nSeven bets now.\n");
		runSpecLedgerPhase(ctx, join(root, "README.md"), true, session, decision, acc);
		expect(session.spec_drift_outstanding).toEqual([]);
		expect(decision.warnings).toBeUndefined();
		// Deleted file mid-flight: the phase logs and moves on.
		runSpecLedgerPhase(
			ctx,
			join(root, "GONE.md"),
			true,
			session,
			decision,
			acc,
		);
		expect(decision.warnings).toBeUndefined();
	});

	it("tags a fully-deterministic finding [proven] (declared_fact_drift) vs the heuristic default", () => {
		const { root, ctx, session, decision, acc } = makeFixture();
		fixtures.push(root);
		writeFileSync(join(root, "FACTS.md"), "<!-- fact:cap -->500<!-- /fact:cap -->\n");
		writeFileSync(join(root, "SIBLING.md"), "<!-- fact:cap -->800<!-- /fact:cap -->\n");
		runSpecLedgerPhase(ctx, join(root, "FACTS.md"), true, session, decision, acc);
		expect(decision.warnings?.some((w) => w.includes("[proven]"))).toBe(true);
		expect(
			acc.allCheckResults.some(
				(r) => r.name === "spec_declared_fact_drift" && r.determinism === "fully_deterministic",
			),
		).toBe(true);
	});

	it("caps per-edit warnings at 5 and appends an overflow summary line", () => {
		const { root, ctx, session, decision, acc } = makeFixture();
		fixtures.push(root);
		const marks = ["m1", "m2", "m3", "m4", "m5", "m6"];
		const central = marks.map((m) => `<!-- fact:${m} -->500<!-- /fact:${m} -->`).join("\n");
		writeFileSync(join(root, "CENTRAL.md"), central);
		for (const m of marks) {
			writeFileSync(join(root, `sib-${m}.md`), `<!-- fact:${m} -->999<!-- /fact:${m} -->\n`);
		}
		runSpecLedgerPhase(ctx, join(root, "CENTRAL.md"), true, session, decision, acc);
		// 6 marks x 2 sites (central + sibling) each = 12 findings scoped to
		// CENTRAL.md (6 anchored there directly, 6 anchored in siblings whose
		// relatedFiles include it). First 5 become warnings, the rest one summary line.
		expect(decision.warnings?.length).toBe(6);
		expect(decision.warnings?.[5]).toContain("…and 7 more cross-file finding(s)");
	});

	it("skips a sibling completion for a finding anchored in the edited file itself", () => {
		const { root, ctx, session, decision, acc } = makeFixture();
		fixtures.push(root);
		writeFileSync(join(root, "FACTS.md"), "<!-- fact:cap -->500<!-- /fact:cap -->\n");
		writeFileSync(join(root, "SIBLING.md"), "<!-- fact:cap -->800<!-- /fact:cap -->\n");
		runSpecLedgerPhase(ctx, join(root, "FACTS.md"), true, session, decision, acc);
		const keys = [...session.pending_completions.keys()];
		// The only finding is anchored in FACTS.md itself (the edited file) — no
		// sibling obligation is recorded for it.
		expect(keys.some((k) => k.includes(":FACTS.md:"))).toBe(false);
	});

	it("logs (does not throw) when readFileSync fails on the edited file after the '..' guard passes", () => {
		const { root, ctx, session, decision, acc } = makeFixture();
		fixtures.push(root);
		const log = vi.fn();
		(ctx as unknown as { log: typeof log }).log = log;
		// A directory named *.md exists (passes isSpecEligibleFile + realpath
		// resolves, so toLedgerPath never hits the ".." guard) but readFileSync
		// throws EISDIR — exercising the genuine catch path, not the path-gone
		// early return the ".." guard produces for a never-existed path.
		mkdirSync(join(root, "DIR.md"));
		expect(() =>
			runSpecLedgerPhase(ctx, join(root, "DIR.md"), true, session, decision, acc),
		).not.toThrow();
		expect(log).toHaveBeenCalledOnce();
		expect(log.mock.calls[0]?.[0]).toContain("Spec-ledger phase error:");
	});

	it("stringifies a non-Error throw in the phase catch (instanceof-Error false branch)", () => {
		const { root, ctx, session, decision, acc } = makeFixture();
		fixtures.push(root);
		writeFileSync(join(root, "X.md"), "# X\n");
		const log = vi.fn();
		const fakeLedger = {
			refreshFile: () => {
				throw "not-an-error-instance";
			},
		} as unknown as SpecLedger;
		(ctx as unknown as { log: typeof log }).log = log;
		(ctx as unknown as { specLedger: SpecLedger | null }).specLedger = fakeLedger;
		expect(() =>
			runSpecLedgerPhase(ctx, join(root, "X.md"), true, session, decision, acc),
		).not.toThrow();
		expect(log).toHaveBeenCalledOnce();
		expect(log.mock.calls[0]?.[0]).toContain("Spec-ledger phase error: not-an-error-instance");
	});
});

describe("runSpecLedgerPhase — decision.warnings already populated (?? not re-initialized)", () => {
	const fixtures: string[] = [];
	afterAll(() => {
		for (const root of fixtures) rmSync(root, { recursive: true, force: true });
	});

	it("appends onto an existing warnings array instead of replacing it", () => {
		const { root, ctx, session, acc } = makeFixture();
		fixtures.push(root);
		writeFileSync(join(root, "FACTS.md"), "<!-- fact:cap -->500<!-- /fact:cap -->\n");
		writeFileSync(join(root, "SIBLING.md"), "<!-- fact:cap -->800<!-- /fact:cap -->\n");
		const decision: HarnessDecision = { decision: "allow", warnings: ["PRE-EXISTING"] };
		runSpecLedgerPhase(ctx, join(root, "FACTS.md"), true, session, decision, acc);
		expect(decision.warnings?.[0]).toBe("PRE-EXISTING");
		expect(decision.warnings?.length).toBeGreaterThan(1);
	});
});

describe("prerefreshSpecLedger — early-return branches", () => {
	const fixtures: string[] = [];
	afterAll(() => {
		for (const root of fixtures) rmSync(root, { recursive: true, force: true });
	});

	it("no-ops when spec_checks.enabled is explicitly false, even with 2+ md paths", () => {
		const { root, ctx } = makeFixture();
		fixtures.push(root);
		(ctx as unknown as { rules: { spec_checks: { enabled: boolean } } }).rules = {
			spec_checks: { enabled: false },
		};
		writeFileSync(join(root, "A.md"), "# A\n");
		writeFileSync(join(root, "B.md"), "# B\n");
		prerefreshSpecLedger(ctx, [join(root, "A.md"), join(root, "B.md")]);
		expect(ctx.specLedger).toBeNull();
	});

	it("no-ops for a single-file (or empty) path list — needs no pre-pass", () => {
		const { root, ctx } = makeFixture();
		fixtures.push(root);
		writeFileSync(join(root, "A.md"), "# A\n");
		prerefreshSpecLedger(ctx, [join(root, "A.md")]);
		expect(ctx.specLedger).toBeNull();
		prerefreshSpecLedger(ctx, []);
		expect(ctx.specLedger).toBeNull();
	});

	it("skips a resolved path outside the repo root (rel starts with '..')", () => {
		const { root, ctx } = makeFixture();
		fixtures.push(root);
		const outsideRoot = mkdtempSync(join(tmpdir(), "spec-phase-outside-"));
		fixtures.push(outsideRoot);
		writeFileSync(join(outsideRoot, "OUTSIDE.md"), "# Outside\n");
		writeFileSync(join(root, "A.md"), "# A\n");
		expect(() =>
			prerefreshSpecLedger(ctx, [join(root, "A.md"), join(outsideRoot, "OUTSIDE.md")]),
		).not.toThrow();
		const ledger = ctx.specLedger as { fileList(): string[] } | null | undefined;
		expect(ledger?.fileList() ?? []).toContain("A.md");
		expect((ledger?.fileList() ?? []).some((k) => k.includes("OUTSIDE.md"))).toBe(false);
	});
});

describe("prerefreshSpecLedger — outer catch (drop-on-delete removeFile, and its own failure)", () => {
	const fixtures: string[] = [];
	afterAll(() => {
		for (const root of fixtures) rmSync(root, { recursive: true, force: true });
	});

	it("drops a path whose readFileSync fails mid-patch (removeFile called and succeeds)", () => {
		const { root, ctx } = makeFixture();
		fixtures.push(root);
		writeFileSync(join(root, "A.md"), "# A\n");
		mkdirSync(join(root, "B.md"));
		expect(() =>
			prerefreshSpecLedger(ctx, [join(root, "A.md"), join(root, "B.md")]),
		).not.toThrow();
		const ledger = ctx.specLedger as { fileList(): string[] } | null | undefined;
		// B.md's EISDIR read failure hit removeFile — never recorded in the ledger.
		expect(ledger?.fileList() ?? []).not.toContain("B.md");
		expect(ledger?.fileList() ?? []).toContain("A.md");
	});

	it("outer catch fires (and logs) when removeFile itself throws a real Error", () => {
		const { root, ctx } = makeFixture();
		fixtures.push(root);
		const log = vi.fn();
		(ctx as unknown as { log: typeof log }).log = log;
		const fakeLedger = {
			refreshFile: () => {
				throw new Error("refresh boom");
			},
			removeFile: () => {
				throw new Error("remove boom");
			},
		} as unknown as SpecLedger;
		(ctx as unknown as { specLedger: SpecLedger | null }).specLedger = fakeLedger;
		writeFileSync(join(root, "A.md"), "# A\n");
		writeFileSync(join(root, "B.md"), "# B\n");
		expect(() => prerefreshSpecLedger(ctx, [join(root, "A.md"), join(root, "B.md")])).not.toThrow();
		expect(log).toHaveBeenCalledOnce();
		expect(log.mock.calls[0]?.[0]).toContain("Spec-ledger pre-refresh error: remove boom");
	});

	it("outer catch stringifies a non-Error thrown by removeFile (instanceof-Error false branch)", () => {
		const { root, ctx } = makeFixture();
		fixtures.push(root);
		const log = vi.fn();
		(ctx as unknown as { log: typeof log }).log = log;
		const fakeLedger = {
			refreshFile: () => {
				throw new Error("refresh boom");
			},
			removeFile: () => {
				throw "remove-non-error";
			},
		} as unknown as SpecLedger;
		(ctx as unknown as { specLedger: SpecLedger | null }).specLedger = fakeLedger;
		writeFileSync(join(root, "A.md"), "# A\n");
		writeFileSync(join(root, "B.md"), "# B\n");
		expect(() => prerefreshSpecLedger(ctx, [join(root, "A.md"), join(root, "B.md")])).not.toThrow();
		expect(log).toHaveBeenCalledOnce();
		expect(log.mock.calls[0]?.[0]).toContain("Spec-ledger pre-refresh error: remove-non-error");
	});
});
