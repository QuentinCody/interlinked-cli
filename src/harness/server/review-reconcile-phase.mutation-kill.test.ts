import { makeEvent as makeEventFixture } from "../__tests__/fixtures/evaluator.js";
// Survivor-kill tests for src/harness/server/review-reconcile-phase.ts, sourced
// from `npx tsx src/index.ts mutation survivors --file
// src/harness/server/review-reconcile-phase.ts --json` (57 survivors,
// fleet-r3 W8). Shadow-verified against
// scratch/fleet-r3/receipts/src_harness_server_review-reconcile-phase.ts-shadow-verify.mts.
//
// Placement (CONTRACT-R3): a *.mutation-kill.test.ts beside the companion,
// with a top-level STATIC import of the SUT so the mutation runner's
// graph-scoped test selection picks it up.
//
// Building block: `seedFinding` writes a well-formed Finding straight to
// corpus.jsonl via the real `makeFinding`/`recordFinding` API (bypassing the
// markdown-report parser), giving each test exact control over file/line/
// bug_class/message — the lever most of these mutants need.
import { basename, dirname, join } from "node:path";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Finding, type MakeFindingInput, makeFinding, recordFinding } from "../findings/corpus.js";
import { appendReconciliationTxn } from "../spec/reconciliation.js";
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

// Same INTERLINKED_HOME leak guard as the companion test.ts (2026-08-09):
// recordFinding mirrors to ~/.interlinked/findings-corpus.jsonl unless
// redirected.
let prevInterlinkedHome: string | undefined;
beforeEach(() => {
	prevInterlinkedHome = process.env.INTERLINKED_HOME;
	const fakeHome = mkdtempSync(join(tmpdir(), "recon-mk-fake-home-"));
	roots.push(fakeHome);
	process.env.INTERLINKED_HOME = fakeHome;
});
afterEach(() => {
	if (prevInterlinkedHome === undefined) delete process.env.INTERLINKED_HOME;
	else process.env.INTERLINKED_HOME = prevInterlinkedHome;
});

beforeEach(() => resetReviewReconcileCacheForTesting());

/** A fresh, realpath'd tmp directory with no findings yet. realpath matters
 *  on macOS: tmpdir() lives under a symlinked prefix, and the toRel()
 *  canonicalization would otherwise make an edit path fail to match. */
function freshRepo(): string {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "recon-mk-")));
	roots.push(cwd);
	return cwd;
}

/** Build + record a Finding with exact control over the fields these
 *  mutants key on. `mirrorGlobal: false` skips the cross-repo cache write
 *  (redundant given the INTERLINKED_HOME redirect, but avoids the extra
 *  fs call per fixture). */
function seedFinding(cwd: string, overrides: Partial<MakeFindingInput> = {}): Finding {
	const finding = makeFinding(
		{
			bug_class: "review_seeded",
			message: "seeded finding",
			file: "docs/seed.md",
			line: 1,
			source_runner: "mutation-kill-test",
			...overrides,
		},
		cwd,
	);
	recordFinding(finding, cwd, { mirrorGlobal: false });
	return finding;
}

describe("boundedAdd — cap boundary (kills 7a36fb3e3c38d4bc)", () => {
	// test-contract: invariant — the guard set clears AT the cap, not one add
	// past it; a >= vs > swap shifts the eviction point by one and lets the
	// set grow unbounded by one slot per cycle.
	it("P1: clears exactly on the cap-th add, keeping only the newest key", () => {
		const set = new Set<string>();
		boundedAdd(set, "k0", 2);
		boundedAdd(set, "k1", 2);
		boundedAdd(set, "k2", 2); // this add must trigger the clear (size was 2 >= cap 2)
		expect(set.size).toBe(1);
		expect([...set]).toEqual(["k2"]);
	});
});

describe("isReviewFinding / the .filter(isReviewFinding) call site (kills aba8df2cfa191101, 58175da475)", () => {
	// test-contract: invariant — only bug_class rows carrying the "review_"
	// provenance prefix belong to the review-reconcile surface; anything else
	// ingested into the same corpus (a different detector's row) must never
	// leak into the disputed-ground channel.
	it("P1: a non-review bug_class is excluded from the open set even though the reviewed one is included", () => {
		const cwd = freshRepo();
		const reviewed = seedFinding(cwd, {
			bug_class: "review_included",
			file: "docs/ee.md",
			line: 5,
			message: "REVIEWED_MARK",
		});
		const other = seedFinding(cwd, {
			bug_class: "other_not_review",
			file: "docs/ee2.md",
			line: 6,
			message: "NONREVIEW_MARK",
		});
		const open = openReviewFindings(cwd);
		expect(open.some((f) => f.id === reviewed.id)).toBe(true);
		expect(open.some((f) => f.id === other.id)).toBe(false);
	});
});

describe("openReviewFindings — cache identity (kills 98e623c794d9126, 7122776d65241ab4, 7bc0a7905db4cd64, fad33baedba061a)", () => {
	// test-contract: invariant — a second call for the SAME cwd with no state
	// change must return the identical cached array object, not merely an
	// equal one; that reference is the only externally-observable trace that
	// the single-slot cache actually short-circuited the reload.
	it("P1: repeated calls for the same cwd return the exact same array reference", () => {
		const cwd = freshRepo();
		seedFinding(cwd, { file: "docs/k.md", line: 5, message: "SAMECWD_MARK" });
		const first = openReviewFindings(cwd);
		const second = openReviewFindings(cwd);
		expect(second).toBe(first);
	});

	// test-contract: invariant — the cache key includes the exact cwd STRING,
	// not just the derived mtime signature; two different path strings that
	// happen to resolve to the same physical files (a symlink alias) must
	// still be treated as separate cache slots, matching the module's own
	// "canonicalize at toRel(), not at the cache key" design split.
	it("P2: a symlink alias to the same directory is a distinct cache entry, not a false hit", () => {
		const real = freshRepo();
		seedFinding(real, { file: "docs/alias.md", line: 5, message: "ALIAS_MARK" });
		const alias = join(dirname(real), `alias-${basename(real)}`);
		symlinkSync(real, alias);
		roots.push(alias);

		const viaReal = openReviewFindings(real);
		const viaAlias = openReviewFindings(alias);
		expect(viaAlias).toEqual(viaReal); // same underlying files -> same content
		expect(viaAlias).not.toBe(viaReal); // different cwd string -> must recompute, not hit
	});
});

describe("stateSignature — corpus growth invalidates the cache (kills 1c910dd5a4)", () => {
	// test-contract: invariant — the mtime/size/inode signature the cache key
	// derives from must actually change when the on-disk corpus grows,
	// otherwise a warm daemon serves a stale open-set after a real ingest
	// (the deep-round #13 regression this module was built to close).
	it("P1: a finding added after the first call is visible on the very next call", () => {
		const cwd = freshRepo();
		seedFinding(cwd, { file: "docs/a.md", line: 5, message: "FIRST" });
		const before = openReviewFindings(cwd);
		expect(before).toHaveLength(1);
		seedFinding(cwd, { file: "docs/b.md", line: 6, message: "SECOND" });
		const after = openReviewFindings(cwd);
		expect(after).toHaveLength(2);
	});
});

describe("toRel (kills 5453fae57a096a9e, eaff2b3adb9258c, fe4a7b206c4444aa)", () => {
	// test-contract: invariant — a literal backslash BYTE inside a path
	// segment (not a Windows separator; POSIX allows it in filenames) must be
	// converted to a forward slash, never silently deleted, or an edit path
	// containing one stops matching its own finding's `.file`.
	it("P1: a literal backslash in a path segment normalizes to a slash", () => {
		const cwd = freshRepo();
		seedFinding(cwd, { file: "sub/a/b.md", line: 1, message: "BACKSLASH_MARK" });
		const absPath = join(cwd, "sub", "a\\b.md"); // no real file needed; toRel is pure path math
		const w = disputedGroundWarning(cwd, "sBB", absPath, "read");
		expect(w).toContain("disputed-ground");
	});

	// test-contract: invariant — a resolved relative path that ESCAPES the
	// repo (starts with "..") must be rejected regardless of what its far
	// end looks like; checking the wrong end of the string lets an
	// out-of-repo edit be treated as in-repo.
	it("P2: an out-of-repo path (starts with '..') is rejected even though it doesn't end with '..'", () => {
		const cwd = freshRepo();
		seedFinding(cwd, { file: "../secret.md", line: 1, message: "DOTDOT_MARK" });
		const absPath = join(dirname(cwd), "secret.md"); // one level above cwd -> relative() === "../secret.md"
		const w = disputedGroundWarning(cwd, "sCC", absPath, "read");
		expect(w).toBeNull();
	});

	// test-contract: invariant — the in-repo branch of toRel must return the
	// real computed relative path, not a placeholder; a finding whose `.file`
	// happens to equal a placeholder string must not falsely resolve for an
	// unrelated out-of-repo read.
	it("P3: an out-of-repo read never resolves to a stray literal that happens to match another finding's file", () => {
		const cwd = freshRepo();
		seedFinding(cwd, { file: "Stryker was here!", line: 1, message: "LITERALSTRYKER_MARK" });
		const w = disputedGroundWarning(cwd, "sDD", "/etc/passwd", "read");
		expect(w).toBeNull();
	});
});

describe("overlapsRanges (kills 87d83419ca3f8640, 18871e8c2c8af69b, 0116d66d1631f13e, a576684293218c78)", () => {
	// test-contract: invariant — a line-anchored finding touches when it
	// overlaps ANY edited range (union semantics), not only when it overlaps
	// every range — an editor that touches two disjoint regions must still
	// register a touch for a finding inside either one.
	it("P1: a finding covered by only ONE of several edited ranges is still touched", () => {
		const cwd = freshRepo();
		seedFinding(cwd, { file: "docs/r.md", line: 500, message: "SOME_MARK" });
		recordReviewFindingTouches(cwd, "sR", join(cwd, "docs/r.md"), [
			{ start: 1, end: 5 }, // does not cover line 500
			{ start: 497, end: 503 }, // covers line 500 (with +-3 slack)
		]);
		expect(openReviewFindings(cwd).some((f) => f.file === "docs/r.md")).toBe(false);
	});

	// test-contract: boundary — the lower edge of the +-3 slack window is
	// INCLUSIVE; a line exactly at `start - RANGE_SLACK` must count as
	// covered.
	it("P2: a line exactly at the lower slack boundary counts as covered", () => {
		const cwd = freshRepo();
		seedFinding(cwd, { file: "docs/s.md", line: 1, message: "LOWER_MARK" });
		recordReviewFindingTouches(cwd, "sS", join(cwd, "docs/s.md"), [{ start: 4, end: 10 }]);
		expect(openReviewFindings(cwd).some((f) => f.file === "docs/s.md")).toBe(false);
	});

	// test-contract: boundary — the upper edge of the +-3 slack window is
	// INCLUSIVE; a line exactly at `end + RANGE_SLACK` must count as covered.
	it("P3: a line exactly at the upper slack boundary counts as covered", () => {
		const cwd = freshRepo();
		seedFinding(cwd, { file: "docs/t.md", line: 13, message: "UPPER_MARK" });
		recordReviewFindingTouches(cwd, "sT", join(cwd, "docs/t.md"), [{ start: 4, end: 10 }]);
		expect(openReviewFindings(cwd).some((f) => f.file === "docs/t.md")).toBe(false);
	});

	// test-contract: boundary — a line well past the upper slack window must
	// NOT count as covered; the range check has both a lower and an upper
	// bound, and a single-sided check would touch findings anywhere below
	// infinity.
	it("N1: a line far past the upper slack boundary is NOT covered", () => {
		const cwd = freshRepo();
		seedFinding(cwd, { file: "docs/u.md", line: 1000, message: "FARUPPER_MARK" });
		recordReviewFindingTouches(cwd, "sU", join(cwd, "docs/u.md"), [{ start: 4, end: 10 }]);
		expect(openReviewFindings(cwd).some((f) => f.file === "docs/u.md")).toBe(true);
	});
});

describe("touchApplies (kills 681ddeb99d9394f9, 02f02096b3c4d9fd, db9d4ee935aca503)", () => {
	// test-contract: invariant — an EMPTY edited-ranges array (as opposed to
	// omitted/undefined) is still "no range data": the file-level fallback
	// must apply, matching the doc comment "with no range data the file-level
	// fallback stands".
	it("P1: an explicit empty ranges array still touches via the file-level fallback", () => {
		const cwd = freshRepo();
		seedFinding(cwd, { file: "docs/v.md", line: 5, message: "EMPTYRANGES_MARK" });
		recordReviewFindingTouches(cwd, "sV", join(cwd, "docs/v.md"), []);
		expect(openReviewFindings(cwd).some((f) => f.file === "docs/v.md")).toBe(false);
	});

	// test-contract: boundary — an unanchored finding (line <= 0, including
	// exactly 0) touches on ANY edit regardless of range, per the span
	// contract's "unanchored findings touch on any file edit".
	it("P2: an unanchored finding (line 0) touches even when the edited range doesn't cover 0", () => {
		const cwd = freshRepo();
		seedFinding(cwd, { file: "docs/w.md", line: 0, message: "UNANCHORED_MARK" });
		recordReviewFindingTouches(cwd, "sW", join(cwd, "docs/w.md"), [{ start: 100, end: 200 }]);
		expect(openReviewFindings(cwd).some((f) => f.file === "docs/w.md")).toBe(false);
	});
});

describe("recordReviewFindingTouches (kills 5347fe2e62f0b631, eb503f1ef0f51164, a202e1ad12f3c6a5)", () => {
	// test-contract: invariant — an out-of-repo edit path (toRel resolves to
	// "") must be inert: it must never touch a finding, including one whose
	// `.file` happens to be the empty string.
	it("P1: an out-of-repo edit never touches a finding, even one recorded with file ''", () => {
		const cwd = freshRepo();
		const blank = seedFinding(cwd, { file: "", line: 1, message: "BLANKFILE_MARK" });
		recordReviewFindingTouches(cwd, "sY", "/etc/passwd");
		expect(openReviewFindings(cwd).some((f) => f.id === blank.id)).toBe(true);
	});

	// test-contract: invariant — the once-per-(session,finding) dedup key
	// must be scoped to the actual finding id; two DIFFERENT findings
	// touched by the same session must both register, not have the second
	// one silently absorbed by the first's guard entry.
	it("P2: touching two distinct findings in the same session records both touches", () => {
		const cwd = freshRepo();
		const a = seedFinding(cwd, { file: "docs/za.md", line: 5, message: "KEYA_MARK" });
		const b = seedFinding(cwd, { file: "docs/zb.md", line: 5, message: "KEYB_MARK" });
		recordReviewFindingTouches(cwd, "sZ", join(cwd, "docs/za.md"));
		recordReviewFindingTouches(cwd, "sZ", join(cwd, "docs/zb.md"));
		const open = openReviewFindings(cwd);
		expect(open.some((f) => f.id === a.id)).toBe(false);
		expect(open.some((f) => f.id === b.id)).toBe(false);
	});

	// test-contract: invariant — the once-per-session touch guard survives an
	// external reopen: a finding this session already touched must not be
	// re-touched again this session even after an external `reopened` txn
	// puts it back in the open set (anti-compounding, "Once-per-session
	// guards" in the module header).
	it("P3: a finding this session already touched is not re-touched after an external reopen", () => {
		const cwd = freshRepo();
		const f = seedFinding(cwd, { file: "docs/aa.md", line: 5, message: "REOPEN_MARK" });
		const absPath = join(cwd, "docs/aa.md");
		recordReviewFindingTouches(cwd, "sAA", absPath);
		expect(openReviewFindings(cwd).some((x) => x.id === f.id)).toBe(false);
		appendReconciliationTxn(cwd, {
			finding_id: f.id,
			action: "reopened",
			by: "external",
			ts: "2026-08-14T00:00:00Z",
		});
		expect(openReviewFindings(cwd).some((x) => x.id === f.id)).toBe(true);
		recordReviewFindingTouches(cwd, "sAA", absPath);
		expect(openReviewFindings(cwd).some((x) => x.id === f.id)).toBe(true);
	});
});

describe("disputedGroundWarning — MAX_QUOTED threshold (kills 3e7e9cd97a3ca606, c64517aec6692fe3, 4331b6a096e276bf, 9707c9c754921502, b97e49e6eafaaec7, f4560865d085aeb6)", () => {
	// test-contract: boundary — with exactly ONE open finding (below the
	// MAX_QUOTED=2 cap), the "+N more" suffix must be absent and the else
	// literal must stay empty, not a placeholder string.
	it("P1: one open finding shows neither a '+more' suffix nor a placeholder literal", () => {
		const cwd = freshRepo();
		seedFinding(cwd, { file: "docs/g.md", line: 5, message: "ALPHA_MARK" });
		const w = disputedGroundWarning(cwd, "sG", join(cwd, "docs/g.md"), "read");
		expect(w).not.toBeNull();
		expect(w).not.toContain("more)");
		expect(w).toContain("ALPHA_MARK");
	});

	// test-contract: boundary — with exactly MAX_QUOTED (2) open findings,
	// the count is not > the cap, so the suffix must stay absent; both
	// findings must be quoted and joined with the "; " separator.
	it("P2: exactly two open findings are both quoted, joined by '; ', with no suffix", () => {
		const cwd = freshRepo();
		seedFinding(cwd, { file: "docs/h.md", line: 5, message: "BETA1_MARK" });
		seedFinding(cwd, { file: "docs/h.md", line: 15, message: "BETA2_MARK" });
		const w = disputedGroundWarning(cwd, "sH", join(cwd, "docs/h.md"), "read");
		expect(w).not.toBeNull();
		expect(w).not.toContain("more)");
		expect(w).toContain("; ");
		expect(w).toContain("BETA1_MARK");
		expect(w).toContain("BETA2_MARK");
	});

	// test-contract: boundary — with THREE open findings (over the cap), the
	// suffix must appear with the correct overflow count, and only the first
	// two (slice(0, MAX_QUOTED)) are quoted — the third's own marker text
	// must not appear anywhere in the message.
	it("P3: three open findings quote only the first two and report '+1 more'", () => {
		const cwd = freshRepo();
		seedFinding(cwd, { file: "docs/i.md", line: 5, message: "GAMMA1_MARK" });
		seedFinding(cwd, { file: "docs/i.md", line: 15, message: "GAMMA2_MARK" });
		seedFinding(cwd, { file: "docs/i.md", line: 25, message: "GAMMA3_MARK" });
		const w = disputedGroundWarning(cwd, "sI", join(cwd, "docs/i.md"), "read");
		expect(w).not.toBeNull();
		expect(w).toContain("+1 more)");
		expect(w).toContain("GAMMA1_MARK");
		expect(w).toContain("GAMMA2_MARK");
		expect(w).not.toContain("GAMMA3_MARK");
	});
});

describe("disputedGroundWarning — quoted-entry formatting (kills d2f97d23f00f8060, c164bacd7b90c76b, 658a2a5c1d7e3f9a, 0c913a4e9d9db176, a17b6528b7096cb9, c2c15cc01e563549)", () => {
	// test-contract: invariant — an unanchored finding (line 0) on a ranged
	// read must still be included: the pre-filter's `f.line <= 0` bypass
	// exists specifically so unanchored findings are never accidentally
	// excluded by a range they have no line to overlap.
	it("P1: an unanchored finding is included in a ranged read even though the range doesn't cover line 0", () => {
		const cwd = freshRepo();
		seedFinding(cwd, { file: "docs/unanchored.md", line: 0, message: "UNANCHORED_QUOTE_MARK" });
		const w = disputedGroundWarning(cwd, "sJ", join(cwd, "docs/unanchored.md"), "read", {
			start: 100,
			end: 200,
		});
		expect(w).toContain("disputed-ground");
	});

	// test-contract: invariant — the quoted-entry formatter must actually
	// render the finding's id and message text, not a blanked placeholder;
	// an id/message longer than the slice caps (40/80 chars) must be
	// TRUNCATED, not passed through whole.
	it("P2: a long id and message are truncated in the quoted entry, not passed through whole", () => {
		const cwd = freshRepo();
		const longBugClass = `review_${"very_long_bug_class_segment_".repeat(4)}padding`;
		const longMessage = `LONGMSG_${"x".repeat(90)}`;
		const finding = seedFinding(cwd, {
			bug_class: longBugClass,
			file: "docs/long.md",
			line: 5,
			message: longMessage,
		});
		expect(finding.id.length).toBeGreaterThan(40);
		expect(finding.message.length).toBeGreaterThan(80);
		const w = disputedGroundWarning(cwd, "sK2", join(cwd, "docs/long.md"), "read");
		expect(w).not.toBeNull();
		expect(w).not.toContain(finding.id); // full id must not appear verbatim
		expect(w).not.toContain(finding.message); // full message must not appear verbatim
		expect(w).toContain(finding.id.slice(0, 40));
		expect(w).toContain(finding.message.slice(0, 80));
	});
});

describe("runReviewReconcilePhase (kills 859aed3a169074f8, 599db5c0b8c7af8b, 148df142cbdb069a, 284d2036f057515c)", () => {
	// test-contract: invariant — the guard must skip BOTH touching and
	// warning when the edit is not in the repo, even when the file path
	// itself is a real, valid path pointing at an actual open finding.
	it("P1: editedFileInRepo=false skips both the warning and the touch", () => {
		const cwd = freshRepo();
		seedFinding(cwd, { file: "docs/m.md", line: 5, message: "GUARD_MARK" });
		const decision: { warnings?: string[] } = {};
		runReviewReconcilePhase(cwd, "sM", join(cwd, "docs/m.md"), false, decision);
		expect(decision.warnings).toBeUndefined();
		expect(openReviewFindings(cwd)).toHaveLength(1);
	});

	// test-contract: invariant — the write-phase dedup key must use the
	// literal "write" mode segment as its own channel, distinct from any
	// other mode string; a channel already marked warned under a different
	// mode string must not suppress the write-phase warning.
	it("P2: read and write warnings use separate deduplication channels", () => {
		const cwd = freshRepo();
		seedFinding(cwd, { file: "docs/n.md", line: 5, message: "MODE_MARK" });
		const absPath = join(cwd, "docs/n.md");
		disputedGroundWarning(cwd, "sN", absPath, "read");
		const decision: { warnings?: string[] } = {};
		runReviewReconcilePhase(cwd, "sN", absPath, true, decision);
		expect(decision.warnings?.[0]).toContain("disputed-ground");
	});

	// test-contract: invariant — the phase function must APPEND its warning
	// to a decision object that already carries warnings from an earlier
	// phase, never overwrite the array and discard them.
	it("P3: a pre-existing decision.warnings entry survives the phase's own push", () => {
		const cwd = freshRepo();
		seedFinding(cwd, { file: "docs/o.md", line: 5, message: "PRIOR_MARK" });
		const decision: { warnings?: string[] } = { warnings: ["EXISTING_MARKER"] };
		runReviewReconcilePhase(cwd, "sO", join(cwd, "docs/o.md"), true, decision);
		expect(decision.warnings).toContain("EXISTING_MARKER");
		expect(decision.warnings).toHaveLength(2);
	});
});

describe("scanDisputedGroundRead — event shape guards (kills d46cd1700eb01a4b, 69726be7dc164cab)", () => {
	// test-contract: invariant — only a "Read" tool event reaches the
	// disputed-ground check; any other tool_name must return [] even when
	// tool_input happens to carry a file_path key pointing at a disputed
	// file.
	it("P1: a non-Read tool_name is inert even with a matching file_path present", () => {
		const cwd = freshRepo();
		seedFinding(cwd, { file: "docs/p.md", line: 5, message: "TOOLNAME_MARK" });
		const w = scanDisputedGroundRead({ ...makeEventFixture({ tool_name: undefined, tool_input: undefined }),
			hook_event: "PostToolUse",
			session_id: "sP",
			tool_name: "Bash",
			tool_input: { file_path: join(cwd, "docs/p.md") },
			cwd,
		});
		expect(w).toEqual([]);
	});

	// test-contract: boundary — a Read event with no tool_input at all must
	// degrade gracefully to [] via optional chaining, never throw.
	it("P2: a Read event with no tool_input does not throw and returns []", () => {
		const cwd = freshRepo();
		expect(() =>
			scanDisputedGroundRead({ ...makeEventFixture({ tool_name: undefined, tool_input: undefined }),
				hook_event: "PostToolUse",
				session_id: "sQ",
				tool_name: "Read",
				cwd,
			}),
		).not.toThrow();
		expect(
			scanDisputedGroundRead({ ...makeEventFixture({ tool_name: undefined, tool_input: undefined }),
				hook_event: "PostToolUse",
				session_id: "sQ",
				tool_name: "Read",
				cwd,
			}),
		).toEqual([]);
	});
});

describe("scanDisputedGroundRead — offset/limit range gating (kills 54d2a97dff4297c5, d1d546fa48ca2549, 4fba3388dc3c4ef0, aebd8d870072641f, d30f05ffd841fce1)", () => {
	// test-contract: invariant — with a VALID numeric offset+limit, the read
	// range must actually restrict which findings are disputed: a finding
	// far outside the read window must stay clean.
	it("P1: a valid offset+limit range excludes a finding outside the read window", () => {
		const cwd = freshRepo();
		seedFinding(cwd, { file: "docs/far.md", line: 500, message: "FAR_MARK" });
		const w = scanDisputedGroundRead({ ...makeEventFixture({ tool_name: undefined, tool_input: undefined }),
			hook_event: "PostToolUse",
			session_id: "sA",
			tool_name: "Read",
			tool_input: { file_path: join(cwd, "docs/far.md"), offset: 1, limit: 10 },
			cwd,
		});
		expect(w).toEqual([]);
	});

	// test-contract: boundary — when `limit` is missing (not a number) but
	// `offset` is present, the pair-validity check must fail closed to "no
	// range" (whole-file disputes), not silently compute a range from a
	// missing limit.
	it("P2: a numeric offset with no limit falls back to an unrestricted (whole-read) dispute", () => {
		const cwd = freshRepo();
		seedFinding(cwd, { file: "docs/far2.md", line: 500, message: "FAR2_MARK" });
		const w = scanDisputedGroundRead({ ...makeEventFixture({ tool_name: undefined, tool_input: undefined }),
			hook_event: "PostToolUse",
			session_id: "sB",
			tool_name: "Read",
			tool_input: { file_path: join(cwd, "docs/far2.md"), offset: 1 },
			cwd,
		});
		expect(w[0]).toContain("disputed-ground");
	});

	// test-contract: boundary — the mirror case: `offset` missing, `limit`
	// present, must also fail closed to an unrestricted dispute.
	it("P3: a numeric limit with no offset falls back to an unrestricted (whole-read) dispute", () => {
		const cwd = freshRepo();
		seedFinding(cwd, { file: "docs/far3.md", line: 500, message: "FAR3_MARK" });
		const w = scanDisputedGroundRead({ ...makeEventFixture({ tool_name: undefined, tool_input: undefined }),
			hook_event: "PostToolUse",
			session_id: "sC",
			tool_name: "Read",
			tool_input: { file_path: join(cwd, "docs/far3.md"), limit: 5 },
			cwd,
		});
		expect(w[0]).toContain("disputed-ground");
	});
});

describe("scanDisputedGroundRead — cwd resolution (kills b13478c962b18283, f42b326b9f6915dd, 6ea27e8209289b23, 1e6ce3b6c6efe563, dc96229d0b0db338)", () => {
	// test-contract: invariant — a valid, non-empty `event.cwd` string must
	// be used as-is; it must never be discarded in favor of the daemon's own
	// process.cwd(), which would resolve findings for the wrong repo
	// entirely (round-2 #11).
	it("P1: a valid event.cwd is used over process.cwd(), even when process.cwd() has no findings", () => {
		const seeded = freshRepo();
		seedFinding(seeded, { file: "docs/d.md", line: 5, message: "CWD_MARK" });
		const emptyDir = freshRepo();
		const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(emptyDir);
		try {
			const w = scanDisputedGroundRead({ ...makeEventFixture({ tool_name: undefined, tool_input: undefined }),
				hook_event: "PostToolUse",
				session_id: "sD",
				tool_name: "Read",
				tool_input: { file_path: join(seeded, "docs/d.md") },
				cwd: seeded,
			});
			expect(w[0]).toContain("disputed-ground");
		} finally {
			cwdSpy.mockRestore();
		}
	});
});
