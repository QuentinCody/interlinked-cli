import { makeMinimalEvent as completeEventFixture, makeSession as completeSessionFixture } from "./__tests__/fixtures/evaluator.js";
// Mutation-kill campaign (wave 27) — targets survived mutants in
// mutation-kill-evidence-stop-check.ts per .interlinked/mutation-manifest.json.
// Companion to mutation-kill-evidence-stop-check.test.ts (which already covers
// the check's headline behaviors); this file adds exact-observable assertions
// that distinguish the specific surviving mutants. No real git process, no
// real fs beyond the mocked node:fs/node:child_process below (both are
// fully-faked modules — no spawn, no disk I/O actually happens).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	checkMutationKillEvidence,
	detectMutationKillEvidenceGaps,
	formatMutationKillEvidenceWarning,
	type MutationKillEvidenceHit,
} from "./mutation-kill-evidence-stop-check.js";
import type { ServerRuntime } from "./server/runtime-context.js";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
vi.mock("node:fs", () => ({ existsSync: vi.fn(), readFileSync: vi.fn() }));

const mockExecFileSync = vi.mocked(execFileSync);
const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);

const CWD = "/repo";
const SHA = "deadbeef";

/** A test-case opener with an adjacent, valid `// test-contract:` marker. */
function markedCase(name: string): string {
	return (
		"// test-contract: bug — kills the boundary mutant\n" +
		`it("${name}", () => { expect(1).toBe(1); });\n`
	);
}

/** A test-case opener with NO adjacent contract marker. */
function unmarkedCase(name: string): string {
	return `it("${name}", () => { expect(1).toBe(1); });\n`;
}

beforeEach(() => {
	vi.clearAllMocks();
});

// ── defaultGitShow — real git-show default reader ──────────────────────────
// (mutants: c9cef827/b01390dd/a4aeeeb0/3964a06a/25127d15/7fa8faae/b9e6a757/
//  d77ff5d8/e5eaf50b/c5edd79b/d66b871/137ed3c)

describe("defaultGitShow — real default reader (gitShow left uninjected)", () => {
	// test-contract: bug — pins the exact argv/options the real reader shells
	// out with; also kills the two BlockStatement mutants that would skip the
	// execFileSync call entirely (the assertion would then see zero calls).
	it("shells out with git -C <cwd> show <ref>, encoding utf-8, GIT_TIMEOUT_MS, ignore/pipe/ignore stdio", () => {
		mockExecFileSync.mockReturnValueOnce("");
		const abs = "/repo/src/checks/foo.mutation-kill.test.ts";
		const hits = detectMutationKillEvidenceGaps({
			filesWritten: new Set([abs]),
			fileWriteTimes: new Map(),
			gitHeadSha: SHA,
			cwd: CWD,
			readFile: () => unmarkedCase("kills mutant A"),
			loadMutationManifest: () => null,
		});
		expect(mockExecFileSync).toHaveBeenCalledWith(
			"git",
			["-C", CWD, "show", `${SHA}:src/checks/foo.mutation-kill.test.ts`],
			{ encoding: "utf-8", timeout: 1_500, stdio: ["ignore", "pipe", "ignore"] },
		);
		expect(hits).toHaveLength(1); // sanity: the mocked call actually fed the detector
	});
});

// ── defaultReadFile — real fs-backed default reader ─────────────────────────
// (mutant: fe80036a — existsSync(absPath) -> true)

describe("defaultReadFile — real default reader (readFile left uninjected)", () => {
	// test-contract: bug — an absent file must short-circuit to null via
	// existsSync, never reaching readFileSync at all.
	it("never calls readFileSync when existsSync says the file is absent — zero hits", () => {
		mockExistsSync.mockReturnValue(false);
		mockReadFileSync.mockReturnValue(unmarkedCase("mutant"));
		const abs = "/repo/src/checks/foo.mutation-kill.test.ts";
		const hits = detectMutationKillEvidenceGaps({
			filesWritten: new Set([abs]),
			fileWriteTimes: new Map(),
			gitHeadSha: SHA,
			cwd: CWD,
			gitShow: () => "",
			loadMutationManifest: () => null,
		});
		expect(hits).toEqual([]);
		expect(mockReadFileSync).not.toHaveBeenCalled();
	});
});

// ── detectMutationKillEvidenceGaps — internal mutants ───────────────────────

describe("detectMutationKillEvidenceGaps — seen.has(abs) dedup guard", () => {
	// test-contract: bug — d89141353570aa75 (seen.has(abs) -> false)
	it("two filesWritten entries resolving to the same abs path count once, not twice", () => {
		const relEntry = "src/checks/foo.mutation-kill.test.ts";
		const absEntry = "/repo/src/checks/foo.mutation-kill.test.ts";
		const hits = detectMutationKillEvidenceGaps({
			filesWritten: new Set([relEntry, absEntry]),
			fileWriteTimes: new Map([
				[relEntry, "2026-08-14T10:00:00.000Z"],
				[absEntry, "2026-08-14T10:00:00.000Z"],
			]),
			gitHeadSha: SHA,
			cwd: CWD,
			gitShow: () => "",
			readFile: () => unmarkedCase("mutant"),
			loadMutationManifest: () => null,
		});
		expect(hits).toHaveLength(1);
	});
});

describe("detectMutationKillEvidenceGaps — posix conversion of relPath", () => {
	// test-contract: bug — 91f25753b (the second "/" replacement literal,
	// feeding hit.file) must CONVERT backslashes, not strip them.
	it("backslashes in the resolved relative path become '/', not empty, in hit.file", () => {
		const entry = "/repo/src\\checks\\foo.mutation-kill.test.ts";
		const hits = detectMutationKillEvidenceGaps({
			filesWritten: new Set([entry]),
			fileWriteTimes: new Map([[entry, "2026-08-14T10:00:00.000Z"]]),
			gitHeadSha: SHA,
			cwd: CWD,
			gitShow: () => "",
			readFile: () => unmarkedCase("mutant"),
			loadMutationManifest: () => null,
		});
		expect(hits).toHaveLength(1);
		expect(hits[0]?.file).toBe("src/checks/foo.mutation-kill.test.ts");
	});
});

describe("detectMutationKillEvidenceGaps — currentContent===null skip guard", () => {
	// test-contract: bug — 01261e76194b202b (currentContent === null -> false)
	it("a deleted/unreadable file (readFile -> null) is skipped, not treated as empty content", () => {
		const abs = "/repo/src/checks/foo.mutation-kill.test.ts";
		const hits = detectMutationKillEvidenceGaps({
			filesWritten: new Set([abs]),
			fileWriteTimes: new Map([[abs, "2026-08-14T10:00:00.000Z"]]),
			gitHeadSha: SHA,
			cwd: CWD,
			gitShow: () => "",
			readFile: () => null,
			loadMutationManifest: () => null,
		});
		expect(hits).toEqual([]);
	});
});

describe("detectMutationKillEvidenceGaps — measurementMs lazy memoization", () => {
	// test-contract: bug — 65a195d608efc624 (measurementMs === undefined -> true)
	it("loadMutationManifest is called at most once per detector run across multiple qualifying files", () => {
		const abs1 = "/repo/src/checks/a.mutation-kill.test.ts";
		const abs2 = "/repo/src/checks/b.mutation-kill.test.ts";
		const loadManifest = vi.fn(() => ({ authoritativeAt: "2026-08-14T12:00:00.000Z" }));
		const hits = detectMutationKillEvidenceGaps({
			filesWritten: new Set([abs1, abs2]),
			fileWriteTimes: new Map([
				[abs1, "2026-08-14T10:00:00.000Z"],
				[abs2, "2026-08-14T10:00:00.000Z"],
			]),
			gitHeadSha: SHA,
			cwd: CWD,
			gitShow: () => "",
			readFile: () => unmarkedCase("mutant"),
			loadMutationManifest: loadManifest,
		});
		expect(loadManifest).toHaveBeenCalledTimes(1);
		// Both files still got a correct, fresh-measurement verdict from the
		// ONE cached read — memoization must not also break the result itself.
		expect(hits).toHaveLength(2);
		expect(hits.every((h) => h.staleMeasurement === false)).toBe(true);
	});
});

describe("detectMutationKillEvidenceGaps — fileWriteTimes fallback (entry ?? abs)", () => {
	// test-contract: bug — c16361f55b19f7cb (?? -> &&) must still fall back to
	// the abs-keyed write time when the raw entry key is absent.
	it("falls back to the abs-keyed write time when the raw entry string isn't a key", () => {
		const relEntry = "src/checks/foo.mutation-kill.test.ts";
		const abs = "/repo/src/checks/foo.mutation-kill.test.ts";
		const hits = detectMutationKillEvidenceGaps({
			filesWritten: new Set([relEntry]),
			fileWriteTimes: new Map([[abs, "2026-08-14T10:00:00.000Z"]]), // keyed by ABS only
			gitHeadSha: SHA,
			cwd: CWD,
			gitShow: () => "",
			readFile: () => markedCase("mutant"), // marked ⇒ isolates the staleness signal
			loadMutationManifest: () => null, // no manifest ⇒ measurementMs stays null
		});
		expect(hits).toHaveLength(1);
		expect(hits[0]?.staleMeasurement).toBe(true);
	});
});

describe("detectMutationKillEvidenceGaps — measurementMs===null branch", () => {
	// test-contract: bug — 87bc9177a0c2774b (measurementMs === null -> false).
	// Epoch-zero write time exposes it: null coerces to 0 in `<`, so the OR's
	// second branch alone would wrongly read as "not stale".
	it("no manifest at all is stale even at an epoch-zero write time", () => {
		const abs = "/repo/src/checks/foo.mutation-kill.test.ts";
		const hits = detectMutationKillEvidenceGaps({
			filesWritten: new Set([abs]),
			fileWriteTimes: new Map([[abs, "1970-01-01T00:00:00.000Z"]]), // writeMs = 0
			gitHeadSha: SHA,
			cwd: CWD,
			gitShow: () => "",
			readFile: () => markedCase("mutant"),
			loadMutationManifest: () => null,
		});
		expect(hits).toHaveLength(1);
		expect(hits[0]?.staleMeasurement).toBe(true);
	});
});

describe("detectMutationKillEvidenceGaps — measurementMs < writeMs strictness", () => {
	// test-contract: bug — 432221a66cb0af34 (< -> <=)
	it("a measurement exactly AT the write time counts as fresh, not stale", () => {
		const abs = "/repo/src/checks/foo.mutation-kill.test.ts";
		const ts = "2026-08-14T10:00:00.000Z";
		const hits = detectMutationKillEvidenceGaps({
			filesWritten: new Set([abs]),
			fileWriteTimes: new Map([[abs, ts]]),
			gitHeadSha: SHA,
			cwd: CWD,
			gitShow: () => "",
			readFile: () => markedCase("mutant"),
			loadMutationManifest: () => ({ authoritativeAt: ts }), // identical timestamp
		});
		expect(hits).toEqual([]);
	});
});

describe("newMissingContractCount + its filter predicate — introduced-only counting", () => {
	// test-contract: bug — kills 3bd3d70297ebfc05 (current's .filter removed)
	// and 66dc5781c95a900f (the shared filter predicate always false) at once:
	// either mutant makes an UNRELATED broad-truthiness finding or a
	// pre-existing case miscount as a "new missing contract".
	it("counts exactly the genuinely-new unmarked case among mixed finding types", () => {
		const abs = "/repo/src/checks/foo.mutation-kill.test.ts";
		const baselineContent = "expect(x).toBeTruthy();\n" + unmarkedCase("kills mutant A");
		const currentContent = baselineContent + unmarkedCase("kills mutant B");
		const hits = detectMutationKillEvidenceGaps({
			filesWritten: new Set([abs]),
			fileWriteTimes: new Map([[abs, "2026-08-14T10:00:00.000Z"]]),
			gitHeadSha: SHA,
			cwd: CWD,
			gitShow: () => baselineContent,
			readFile: () => currentContent,
			loadMutationManifest: () => ({ authoritativeAt: "2026-08-14T12:00:00.000Z" }), // fresh
		});
		expect(hits).toHaveLength(1);
		expect(hits[0]?.missingContractCount).toBe(1);
		expect(hits[0]?.staleMeasurement).toBe(false);
	});
});

describe("MISSING_CONTRACT_PREFIX constant — module-level string literal", () => {
	// test-contract: bug — f7b188d91165a383 (the prefix literal -> "") would
	// make the filter's startsWith("") match EVERY finding, so an unrelated
	// broad-truthiness line would wrongly count as a missing contract gap.
	it("an unrelated non-missing-contract finding never counts as a contract gap", () => {
		const abs = "/repo/src/checks/foo.mutation-kill.test.ts";
		const currentContent = markedCase("kills mutant A") + "expect(x).toBeTruthy();\n";
		const hits = detectMutationKillEvidenceGaps({
			filesWritten: new Set([abs]),
			fileWriteTimes: new Map([[abs, "2026-08-14T10:00:00.000Z"]]),
			gitHeadSha: SHA,
			cwd: CWD,
			gitShow: () => "",
			readFile: () => currentContent,
			loadMutationManifest: () => ({ authoritativeAt: "2026-08-14T12:00:00.000Z" }), // fresh
		});
		expect(hits).toEqual([]);
	});
});

// ── formatMutationKillEvidenceWarning — truncation ──────────────────────────

describe("formatMutationKillEvidenceWarning — truncation slice + boundary", () => {
	function hit(i: number): MutationKillEvidenceHit {
		return {
			file: `src/checks/f${i}.mutation-kill.test.ts`,
			newCaseCount: 1,
			staleMeasurement: true,
			missingContractCount: 0,
		};
	}

	// test-contract: bug — c149d2caac03c06a (hits.slice(0, MAX_SHOWN) -> hits)
	it("shows only the first 5 hits — later files are absent from the body", () => {
		const hits = Array.from({ length: 7 }, (_, i) => hit(i));
		const warning = formatMutationKillEvidenceWarning(hits) ?? "";
		expect(warning).toContain("f0.mutation-kill.test.ts");
		expect(warning).toContain("f4.mutation-kill.test.ts");
		expect(warning).not.toContain("f5.mutation-kill.test.ts");
		expect(warning).not.toContain("f6.mutation-kill.test.ts");
	});

	// test-contract: bug — 0761d02e6973265e (hits.length > MAX_SHOWN -> true)
	// and 40f5a33e1ec6065f (the "" else-branch -> "Stryker was here!")
	it("no truncation suffix or filler text when hits.length is under the cap", () => {
		const hits = Array.from({ length: 3 }, (_, i) => hit(i));
		const warning = formatMutationKillEvidenceWarning(hits) ?? "";
		expect(warning).not.toMatch(/\.\.\.and/);
		expect(warning).not.toContain("Stryker was here!");
	});

	// test-contract: bug — 1293b801f6099b16 (> -> >=) at the exact boundary
	it("no truncation suffix at the exact cap boundary (5 hits)", () => {
		const hits = Array.from({ length: 5 }, (_, i) => hit(i));
		const warning = formatMutationKillEvidenceWarning(hits) ?? "";
		expect(warning).not.toMatch(/\.\.\.and/);
		expect(warning).not.toContain("Stryker was here!");
	});
});

describe("formatMutationKillEvidenceWarning — literal text integrity", () => {
	// test-contract: bug — 549c9978536d444e / 51bd060f7ee951b / 9c589acef4084 /
	// 390b049700b7ab90 / e621107312e7743b (static fragments -> "") and
	// 6b39f98218ca21f7 ("\n" join separator -> "")
	it("preserves the exact static header/closing fragments and the newline join between hits", () => {
		const hits: MutationKillEvidenceHit[] = [
			{
				file: "src/checks/foo.mutation-kill.test.ts",
				newCaseCount: 2,
				staleMeasurement: true,
				missingContractCount: 0,
			},
			{
				file: "src/checks/bar.mutation-kill.test.ts",
				newCaseCount: 1,
				staleMeasurement: false,
				missingContractCount: 1,
			},
		];
		const warning = formatMutationKillEvidenceWarning(hits) ?? "";
		expect(warning).toContain(
			"file(s) (*.mutation-kill.* / *.mutation-hardening.* / *.survivors?.*) carrying newly-",
		);
		expect(warning).toContain(
			"A new case in one of these files is a claim that it kills a mutant — that claim is only ",
		);
		expect(warning).toContain(
			"as good as the measurement or marker behind it. Re-run the mutation measurement for the ",
		);
		expect(warning).toContain(
			"file(s) these tests target, or add a `// test-contract: <kind> — <rationale>` marker above ",
		);
		expect(warning).toContain("each case, before stopping.");
		expect(warning).toContain(
			"src/checks/foo.mutation-kill.test.ts: +2 new case(s) — no mutation measurement since this edit\n" +
				"  - src/checks/bar.mutation-kill.test.ts",
		);
	});
});

describe("formatMutationKillEvidenceWarning — per-hit reason assembly", () => {
	// test-contract: bug — 36858ed662b602e5 (reasons: string[] = [] -> seeded
	// array) and 8a07d5c4/fab188a5 (missingContractCount>0 forced true/>=0)
	it("a stale-only hit reports ONLY the staleness reason, no seeded/extra text", () => {
		const warning =
			formatMutationKillEvidenceWarning([
				{
					file: "src/checks/foo.mutation-kill.test.ts",
					newCaseCount: 1,
					staleMeasurement: true,
					missingContractCount: 0,
				},
			]) ?? "";
		expect(warning).toContain(
			"src/checks/foo.mutation-kill.test.ts: +1 new case(s) — no mutation measurement since this edit",
		);
		expect(warning).not.toContain("Stryker was here");
		expect(warning).not.toContain("missing a test-contract marker");
	});

	// test-contract: bug — c0d13bb192daa9ed (h.staleMeasurement -> true)
	it("a contract-gap-only hit reports ONLY that reason, not the staleness reason", () => {
		const warning =
			formatMutationKillEvidenceWarning([
				{
					file: "src/checks/foo.mutation-kill.test.ts",
					newCaseCount: 1,
					staleMeasurement: false,
					missingContractCount: 2,
				},
			]) ?? "";
		expect(warning).toContain(
			"src/checks/foo.mutation-kill.test.ts: +1 new case(s) — 2 new case(s) missing a test-contract marker",
		);
		expect(warning).not.toContain("no mutation measurement since this edit");
	});

	// test-contract: bug — 43de468b99e95515 ("; " join separator -> "")
	it("both reasons present join with '; ', not concatenated bare", () => {
		const warning =
			formatMutationKillEvidenceWarning([
				{
					file: "src/checks/foo.mutation-kill.test.ts",
					newCaseCount: 2,
					staleMeasurement: true,
					missingContractCount: 1,
				},
			]) ?? "";
		expect(warning).toContain(
			"no mutation measurement since this edit; 1 new case(s) missing a test-contract marker",
		);
	});
});

// ── checkMutationKillEvidence ────────────────────────────────────────────────

describe("checkMutationKillEvidence — event.cwd fallback (|| not &&)", () => {
	// test-contract: bug — 450f351f14a6f950 (event.cwd || ctx.cwd -> &&). With
	// event.cwd absent, `&&` short-circuits to undefined, which throws inside
	// path.resolve() before the (mocked, no-op) fs/child_process layer is even
	// reached; `||` correctly falls back to ctx.cwd and completes cleanly.
	it("falls back to ctx.cwd when event.cwd is absent, not short-circuiting to undefined", () => {
		const abs = "/repo/src/checks/foo.mutation-kill.test.ts";
		// SAFETY: the check reads only `cwd` and `log` off the runtime.
		const ctx = { cwd: "/repo", log: vi.fn() } as unknown as ServerRuntime;
		// SAFETY: the check reads only `cwd` off the event (deliberately absent here).
		const event = ({ ...completeEventFixture(), ...{ session_id: "S" } }); // no cwd field
		// SAFETY: the check reads only these four trajectory fields.
		const session = ({ ...completeSessionFixture(), ...{
			session_id: "S",
			files_written: new Set([abs]),
			file_write_times: new Map([[abs, "2026-08-14T10:00:00.000Z"]]),
			git_session_baseline: { head_sha: SHA, modified: new Set<string>(), staged: new Set<string>(), untracked: new Set<string>() },
		} });
		expect(() => checkMutationKillEvidence(ctx, event, session)).not.toThrow();
	});
});

describe("checkMutationKillEvidence — ctx.log message", () => {
	// test-contract: bug — e80e0cbe0a89f9dd (the log template -> ``)
	it("logs the exact 'Verify-before-stop: mutation-kill-evidence (<n> file(s))' line", () => {
		const abs = "/repo/src/checks/foo.mutation-kill.test.ts";
		const log = vi.fn();
		// SAFETY: the check reads only `cwd` and `log` off the runtime.
		const ctx = { cwd: "/repo", log } as unknown as ServerRuntime;
		// SAFETY: the check reads only `cwd` off the event.
		const event = ({ ...completeEventFixture(), ...{ cwd: "/repo", session_id: "S" } });
		// SAFETY: the check reads only these four trajectory fields.
		const session = ({ ...completeSessionFixture(), ...{
			session_id: "S",
			files_written: new Set([abs]),
			file_write_times: new Map([[abs, "2026-08-14T10:00:00.000Z"]]),
			git_session_baseline: { head_sha: SHA, modified: new Set<string>(), staged: new Set<string>(), untracked: new Set<string>() },
		} });
		mockExistsSync.mockReturnValue(true);
		mockReadFileSync.mockReturnValue(unmarkedCase("mutant"));
		mockExecFileSync.mockReturnValue("");
		const result = checkMutationKillEvidence(ctx, event, session);
		expect(log).toHaveBeenCalledWith("Verify-before-stop: mutation-kill-evidence (1 file(s))");
		expect(result).toContain("incomplete kill evidence");
	});
});

describe("checkMutationKillEvidence — warning===null short-circuit", () => {
	// test-contract: bug — 92c1c3fff22cf5f7 (warning === null -> false)
	it("no hits ⇒ ctx.log is never called", () => {
		const abs = "/repo/src/checks/foo.mutation-kill.test.ts";
		const log = vi.fn();
		// SAFETY: the check reads only `cwd` and `log` off the runtime.
		const ctx = { cwd: "/repo", log } as unknown as ServerRuntime;
		// SAFETY: the check reads only `cwd` off the event.
		const event = ({ ...completeEventFixture(), ...{ cwd: "/repo", session_id: "S" } });
		// SAFETY: the check reads only these four trajectory fields.
		const session = ({ ...completeSessionFixture(), ...{
			session_id: "S",
			files_written: new Set([abs]),
			file_write_times: new Map([[abs, "2026-08-14T10:00:00.000Z"]]),
			git_session_baseline: { head_sha: SHA, modified: new Set<string>(), staged: new Set<string>(), untracked: new Set<string>() },
		} });
		mockExistsSync.mockReturnValue(false); // file "absent" ⇒ readFile → null ⇒ zero hits
		const result = checkMutationKillEvidence(ctx, event, session);
		expect(result).toBeNull();
		expect(log).not.toHaveBeenCalled();
	});
});
