import { makeMinimalEvent as completeEventFixture, makeSession as completeSessionFixture } from "./__tests__/fixtures/evaluator.js";
// Tests for the mutation-kill-evidence Stop nudge
// (docs/design/luna-gate-audit-2026-08-14.md §3(b)). The detector is pure
// given its injected git-show / file-read / manifest-load functions; the
// formatter is a pure string builder. No real git process, no real fs.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	checkMutationKillEvidence,
	detectMutationKillEvidenceGaps,
	formatMutationKillEvidenceWarning,
	type MutationKillEvidenceHit,
} from "./mutation-kill-evidence-stop-check.js";
import { writeSurvivorsIndex } from "./mutation/survivors-index.js";
import type { ServerRuntime } from "./server/runtime-context.js";
import { recordStopDigestState } from "./stop-digest-state.js";

const CWD = "/repo";
const SHA = "deadbeef";
const KILL_FILE = "/repo/src/checks/foo.mutation-kill.test.ts";
const KILL_FILE_REL = "src/checks/foo.mutation-kill.test.ts";
const SURVIVORS_FILE = "/repo/src/checks/bar.survivors.test.ts";
const PLAIN_TEST_FILE = "/repo/src/checks/foo.test.ts";
const PLAIN_TEST_FILE_REL = "src/checks/foo.test.ts";

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

interface DetectFixtureOpts {
	current: Record<string, string>;
	baseline?: Record<string, string>;
	writeTimes?: Record<string, string>;
	gitHeadSha: string | undefined;
	manifestAuthoritativeAt?: string;
}

/** Drives `detectMutationKillEvidenceGaps` with fully in-memory fakes — no
 *  real git process, no real filesystem. `baseline` keys are REPO-RELATIVE
 *  paths (what `git show <sha>:<relPath>` would be asked for); a key absent
 *  from `baseline` mirrors "path not present in that tree" (null), matching
 *  a file that did not exist at session start. */
function detect(opts: DetectFixtureOpts): MutationKillEvidenceHit[] {
	const baseline = opts.baseline ?? {};
	return detectMutationKillEvidenceGaps({
		filesWritten: new Set(Object.keys(opts.current)),
		fileWriteTimes: new Map(Object.entries(opts.writeTimes ?? {})),
		gitHeadSha: opts.gitHeadSha,
		cwd: CWD,
		gitShow: (_cwd, ref) => {
			const relPath = ref.slice(ref.indexOf(":") + 1);
			return relPath in baseline ? (baseline[relPath] ?? null) : null;
		},
		readFile: (abs) => opts.current[abs] ?? null,
		loadMutationManifest: () =>
			opts.manifestAuthoritativeAt === undefined
				? null
				: { authoritativeAt: opts.manifestAuthoritativeAt },
	});
}

// ─── detector: positive (must fire) ────────────────────────────────────────

describe("detectMutationKillEvidenceGaps — positive (must fire)", () => {
	it("fires when a new case is added and no manifest exists at all", () => {
		const hits = detect({
			current: { [KILL_FILE]: markedCase("kills mutant A") },
			baseline: { [KILL_FILE_REL]: "" },
			writeTimes: { [KILL_FILE]: "2026-08-14T10:00:00.000Z" },
			gitHeadSha: SHA,
		});
		expect(hits).toHaveLength(1);
		expect(hits[0]?.file).toBe(KILL_FILE_REL);
		expect(hits[0]?.newCaseCount).toBe(1);
		expect(hits[0]?.staleMeasurement).toBe(true);
		expect(hits[0]?.missingContractCount).toBe(0);
	});

	it("fires when the manifest's last measurement predates this session's write", () => {
		const hits = detect({
			current: { [KILL_FILE]: markedCase("kills mutant A") },
			baseline: { [KILL_FILE_REL]: "" },
			writeTimes: { [KILL_FILE]: "2026-08-14T10:00:00.000Z" },
			gitHeadSha: SHA,
			manifestAuthoritativeAt: "2026-08-01T00:00:00.000Z", // before the write
		});
		expect(hits).toHaveLength(1);
		expect(hits[0]?.staleMeasurement).toBe(true);
	});

	it("fires on a FRESH measurement when the new case lacks a test-contract marker", () => {
		const hits = detect({
			current: { [KILL_FILE]: unmarkedCase("kills mutant A") },
			baseline: { [KILL_FILE_REL]: "" },
			writeTimes: { [KILL_FILE]: "2026-08-14T10:00:00.000Z" },
			gitHeadSha: SHA,
			manifestAuthoritativeAt: "2026-08-14T12:00:00.000Z", // AFTER the write — fresh
		});
		expect(hits).toHaveLength(1);
		expect(hits[0]?.staleMeasurement).toBe(false);
		expect(hits[0]?.missingContractCount).toBe(1);
	});

	it("fires for a brand-new .survivors.test.ts file absent from the HEAD tree", () => {
		const hits = detect({
			current: { [SURVIVORS_FILE]: markedCase("kills mutant B") },
			baseline: {}, // path absent from HEAD tree — new file this session
			writeTimes: { [SURVIVORS_FILE]: "2026-08-14T10:00:00.000Z" },
			gitHeadSha: SHA,
		});
		expect(hits).toHaveLength(1);
		expect(hits[0]?.newCaseCount).toBe(1);
	});

	it("counts newCaseCount as the delta, not the raw total, when cases pre-existed", () => {
		const baselineContent = markedCase("kills mutant A");
		const currentContent = baselineContent + markedCase("kills mutant B");
		const hits = detect({
			current: { [KILL_FILE]: currentContent },
			baseline: { [KILL_FILE_REL]: baselineContent },
			writeTimes: { [KILL_FILE]: "2026-08-14T10:00:00.000Z" },
			gitHeadSha: SHA,
		});
		expect(hits).toHaveLength(1);
		expect(hits[0]?.newCaseCount).toBe(1); // 2 total minus 1 pre-existing
	});
});

// ─── detector: negative (must not fire) ────────────────────────────────────

describe("detectMutationKillEvidenceGaps — negative (must not fire)", () => {
	it("does not fire on a drive-by maintenance edit that adds zero new cases", () => {
		const existing = markedCase("kills mutant A");
		const hits = detect({
			current: { [KILL_FILE]: existing.replace("kills mutant A", "kills mutant A (renamed)") },
			baseline: { [KILL_FILE_REL]: existing },
			writeTimes: { [KILL_FILE]: "2026-08-14T10:00:00.000Z" },
			gitHeadSha: SHA,
			// No manifest at all — would fire on staleness alone if the
			// new-case AND-gate were not enforced first.
		});
		expect(hits).toEqual([]);
	});

	it("does not fire when the new case is marked AND the measurement is fresh", () => {
		const hits = detect({
			current: { [KILL_FILE]: markedCase("kills mutant A") },
			baseline: { [KILL_FILE_REL]: "" },
			writeTimes: { [KILL_FILE]: "2026-08-14T10:00:00.000Z" },
			gitHeadSha: SHA,
			manifestAuthoritativeAt: "2026-08-14T12:00:00.000Z",
		});
		expect(hits).toEqual([]);
	});

	it("does not fire on a plain (non-mutation-directed) test file", () => {
		const hits = detect({
			current: { [PLAIN_TEST_FILE]: unmarkedCase("does something") },
			baseline: { [PLAIN_TEST_FILE_REL]: "" },
			writeTimes: { [PLAIN_TEST_FILE]: "2026-08-14T10:00:00.000Z" },
			gitHeadSha: SHA,
		});
		expect(hits).toEqual([]);
	});

	it("does not fire when no git HEAD sha is available (non-git / capture failure)", () => {
		const hits = detect({
			current: { [KILL_FILE]: unmarkedCase("kills mutant A") },
			baseline: { [KILL_FILE_REL]: "" },
			writeTimes: { [KILL_FILE]: "2026-08-14T10:00:00.000Z" },
			gitHeadSha: undefined,
		});
		expect(hits).toEqual([]);
	});

	it("does not fire on a non-JS/TS file even if its name matches the mutation-directed pattern", () => {
		const hits = detect({
			current: { "/repo/src/checks/foo.mutation-kill.test.py": unmarkedCase("kills mutant A") },
			baseline: { "src/checks/foo.mutation-kill.test.py": "" },
			writeTimes: { "/repo/src/checks/foo.mutation-kill.test.py": "2026-08-14T10:00:00.000Z" },
			gitHeadSha: SHA,
		});
		expect(hits).toEqual([]);
	});
});

// ─── formatter ──────────────────────────────────────────────────────────────

describe("formatMutationKillEvidenceWarning", () => {
	it("returns null for an empty hit list", () => {
		expect(formatMutationKillEvidenceWarning([])).toBeNull();
	});

	it("names the file, the new-case count, and the specific evidence gap(s), and never claims to block", () => {
		const warning = formatMutationKillEvidenceWarning([
			{
				file: KILL_FILE_REL,
				newCaseCount: 2,
				staleMeasurement: true,
				missingContractCount: 1,
			},
		]);
		expect(warning).not.toBeNull();
		expect(warning).toContain("[interlinked:mutation-kill-evidence]");
		expect(warning).toContain(KILL_FILE_REL);
		expect(warning).toContain("+2 new case(s)");
		expect(warning).toContain("no mutation measurement since this edit");
		expect(warning).toContain("1 new case(s) missing a test-contract marker");
		expect(warning).not.toMatch(/\bblock/i);
	});

	it("truncates beyond the max-shown cap with an '...and N more' suffix", () => {
		const hits: MutationKillEvidenceHit[] = Array.from({ length: 7 }, (_, i) => ({
			file: `src/checks/f${i}.mutation-kill.test.ts`,
			newCaseCount: 1,
			staleMeasurement: true,
			missingContractCount: 0,
		}));
		const warning = formatMutationKillEvidenceWarning(hits);
		expect(warning).toContain("...and 2 more");
	});
});

// ─── the default reader is the SIDECAR, never the 44MB manifest ────────────
//
// These exercise the REAL default (`loadMutationManifest` left uninjected), so
// they pin the 2026-08-16 memory fix: the detector must get its measurement
// timestamp from `.interlinked/mutation-survivors-index.json`. A regression that
// pointed this back at `loadManifest` would re-introduce the ~1.7GB per-Stop
// parse that killed the daemon.

describe("detectMutationKillEvidenceGaps — sidecar-backed default reader", () => {
	const dirs: string[] = [];

	function repoWithSidecar(index: { authoritativeAt: string; generation: number } | null): string {
		const cwd = mkdtempSync(join(tmpdir(), "kill-evidence-"));
		dirs.push(cwd);
		const interlinkedDir = join(cwd, ".interlinked");
		mkdirSync(interlinkedDir, { recursive: true });
		if (index !== null) {
			writeSurvivorsIndex(
				interlinkedDir,
				{
					version: 1,
					generation: index.generation,
					authoritativeAt: index.authoritativeAt,
					engine: "stryker",
					engineVersion: "1",
					dependencyGraphVersion: "1",
					environmentHash: "test",
					files: {},
				},
				index.authoritativeAt,
			);
		}
		return cwd;
	}

	function detectIn(cwd: string, writeTime: string): MutationKillEvidenceHit[] {
		const rel = "src/checks/foo.mutation-kill.test.ts";
		const abs = join(cwd, rel);
		return detectMutationKillEvidenceGaps({
			filesWritten: new Set([abs]),
			fileWriteTimes: new Map([[abs, writeTime]]),
			gitHeadSha: SHA,
			cwd,
			gitShow: () => "",
			readFile: () => markedCase("kills mutant A"),
			// loadMutationManifest intentionally NOT injected — the real default runs.
		});
	}

	afterEach(() => {
		while (dirs.length > 0) {
			const dir = dirs.pop();
			if (dir) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("P1: reads authoritativeAt from the sidecar — a measurement AFTER the edit is not stale", () => {
		const cwd = repoWithSidecar({ authoritativeAt: "2026-08-16T12:00:00.000Z", generation: 3 });
		const hits = detectIn(cwd, "2026-08-16T10:00:00.000Z");
		expect(hits).toHaveLength(0);
	});

	it("P2: fires when the sidecar's measurement predates the edit", () => {
		const cwd = repoWithSidecar({ authoritativeAt: "2026-08-16T08:00:00.000Z", generation: 3 });
		const hits = detectIn(cwd, "2026-08-16T10:00:00.000Z");
		expect(hits).toHaveLength(1);
		expect(hits[0]?.staleMeasurement).toBe(true);
	});

	it("N1: an ABSENT sidecar reads as 'never measured' — silent backfill path, no throw", () => {
		const cwd = repoWithSidecar(null);
		const hits = detectIn(cwd, "2026-08-16T10:00:00.000Z");
		expect(hits).toHaveLength(1);
		expect(hits[0]?.staleMeasurement).toBe(true);
	});

	// PIPELINE AWARENESS (2026-08-16): a measurement already owed and reported
	// must not re-print its full explanation at the next Stop.
	function writeKillFile(cwd: string): void {
		const dir = join(cwd, "src", "checks");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "foo.mutation-kill.test.ts"), markedCase("kills A"));
	}

	function checkIn(cwd: string): string | null {
		const rel = "src/checks/foo.mutation-kill.test.ts";
		const abs = join(cwd, rel);
		return checkMutationKillEvidence(
			// SAFETY: the check reads only `cwd` and `log` off the runtime.
			{ cwd, log: () => {} } as unknown as ServerRuntime,
			// SAFETY: the check reads only `cwd` and `session_id` off the event.
			({ ...completeEventFixture(), ...{ cwd, session_id: "S" } }),
			// SAFETY: the check reads only these four trajectory fields.
			({ ...completeSessionFixture(), ...{
				session_id: "S",
				files_written: new Set([abs]),
				file_write_times: new Map([[abs, "2026-08-16T10:00:00.000Z"]]),
				git_session_baseline: { head_sha: SHA, modified: new Set(), staged: new Set(), untracked: new Set() },
			} }),
		);
	}

	it("P3: prints the FULL nudge at the first stop of a session", () => {
		const cwd = repoWithSidecar(null);
		writeKillFile(cwd);
		expect(checkIn(cwd)).toContain("incomplete kill evidence");
	});

	it("P4: compresses to ONE acknowledgment line once the tag was reported before", () => {
		const cwd = repoWithSidecar(null);
		writeKillFile(cwd);
		recordStopDigestState({
			interlinkedDir: join(cwd, ".interlinked"),
			sessionId: "S",
			tags: ["mutation-kill-evidence"],
		});
		const line = checkIn(cwd) ?? "";
		expect(line).toContain("still awaiting measurement (reported at previous stop)");
		expect(line).not.toContain("incomplete kill evidence");
	});

	it("N3: another session's reported tag does not compress THIS session's nudge", () => {
		const cwd = repoWithSidecar(null);
		writeKillFile(cwd);
		recordStopDigestState({
			interlinkedDir: join(cwd, ".interlinked"),
			sessionId: "OTHER",
			tags: ["mutation-kill-evidence"],
		});
		expect(checkIn(cwd)).toContain("incomplete kill evidence");
	});

	it("N2: never reads mutation-manifest.json — a manifest alone leaves it unmeasured", () => {
		const cwd = repoWithSidecar(null);
		// A fat manifest whose measurement postdates the edit. If the detector
		// still read the manifest, this would suppress the hit; it must not.
		writeFileSync(
			join(cwd, ".interlinked", "mutation-manifest.json"),
			JSON.stringify({
				version: 1,
				generation: 9,
				authoritativeAt: "2026-08-16T23:00:00.000Z",
				engine: "stryker",
				engineVersion: "1",
				dependencyGraphVersion: "1",
				environmentHash: "test",
				files: {},
			}),
			"utf-8",
		);
		const hits = detectIn(cwd, "2026-08-16T10:00:00.000Z");
		expect(hits[0]?.staleMeasurement).toBe(true);
	});
});

describe("detectMutationKillEvidenceGaps — real fs default readFile", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("N4: skips an unreadable mutation-directed path (defaultReadFile catches the I/O error)", () => {
		const cwd = mkdtempSync(join(tmpdir(), "kill-evidence-defaultread-"));
		dirs.push(cwd);
		const rel = "foo.mutation-kill.test.ts";
		// A directory, not a file: existsSync is true but readFileSync throws
		// (EISDIR), exercising defaultReadFile's catch — distinct from the
		// "file doesn't exist" case, which never reaches readFileSync at all.
		mkdirSync(join(cwd, rel));
		// readFile is NOT injected here — the real defaultReadFile runs.
		const hits = detectMutationKillEvidenceGaps({
			filesWritten: new Set([rel]),
			fileWriteTimes: new Map(),
			gitHeadSha: SHA,
			cwd,
		});
		expect(hits).toEqual([]);
	});
});
