// Mutation-kill companion for checkpoints.ts.
//
// Targets the 58 mutants recorded as "survived" for src/lib/checkpoints.ts in
// .interlinked/mutation-manifest.json (generation 1846). No companion test
// file existed for this module before this one.
//
// `git`, `isGitRepo`, `readCheckpointsFile`, and `writeCheckpointsFile` are
// unexported module-private helpers, so their survivors are targeted
// indirectly through the exported functions that call them (createCheckpoint
// for git()/isGitRepo(), listCheckpoints for readCheckpointsFile(),
// pruneCheckpoints for writeCheckpointsFile()) rather than imported directly.
//
// `node:child_process` is mocked so no test spawns a real git process; every
// git-touching test drives execSync's mock by exact command string. Every
// test resolves `checkpoints.json` under a fresh mkdtemp directory (via an
// explicit `cwd`), and `process.cwd()` is spied to a separate, unseeded decoy
// directory for the whole file so any `cwd || process.cwd()` /
// `cwd && process.cwd()` mutant reads from empty/wrong state instead of the
// seeded fixture.
//
// Ten survivors are structurally equivalent (no test targets them; each has
// a one-line argument at its describe/it site or in the notes below):
//   - writeCheckpointsFile: `!existsSync(dir)` -> `true` (4d81341260dccbfe).
//     `mkdirSync(dir, { recursive: true })` is a no-op on an already-existing
//     dir (Node fs semantics: no throw, no metadata change), so calling it
//     unconditionally vs. only-when-missing is unobservable.
//   - listCheckpoints: `opts.limit > 0` -> `>=` (34a9dbaa4005a44d), and
//     pruneCheckpoints: `opts.keep_latest > 0` -> `>=` (dac763a62bdd372a) and
//     `opts.older_than_days > 0` -> `>=` (acd3c65d2aa74f14). All three sit
//     behind a `opts?.X && opts.X > 0` truthy guard, which excludes the only
//     value (0) where `>` and `>=` diverge — reachable values are never 0.
//   - rewindToCheckpoint: second `opts?.force` OptionalChaining
//     (72b5a47cff86b912) is reached only after the first `opts?.force`
//     (guarding `!opts?.force`) already proved opts truthy, so `.force` vs
//     `?.force` are identical there; and `.filter(Boolean)` on the stash-list
//     split (49f83ab5f2151b13) only removes `""` entries, which can never
//     satisfy the loop's `.includes(nonEmptySubstring)` match anyway.
//   - compareCheckpoints: `let diffSummary = ""` (ce444ca1c9245c2a) is
//     unconditionally overwritten by either the try or catch branch before
//     any read — the initializer's value is dead.
//   - pruneCheckpoints: the discarded `_removedIds` Set's `.map((c) => c.id)`
//     (90c10b8abc8dd02a) feeds a value that is never read (see the adjacent
//     comment: cleanup is intentionally skipped).
//   - shouldAutoCheckpoint: `session_start`/`session_end` mapping values
//     emptied (e32af5eb3e44100b, cc93f9fa43eb8875) — both are identity
//     mappings (key === value), and `mapping[eventType] || eventType`
//     recovers the original value whenever eventType is exactly that key,
//     the only case where the mutated entry is ever looked up.
//
// NOTE (real bug, flagged per the fleet-r3 contract, not fixed here — this
// wave is tests-only): archiveCheckpoints's over-`max_stash_count` branch
// archives from a NEWEST-FIRST sort while counting down, which archives the
// *newest* excess stash first and leaves older ones restorable — the
// opposite of the usual "trim the oldest first" intent. Verified by direct
// simulation (see the "archives exactly the checkpoint..." test below, whose
// asserted values reflect this actual behavior, not the presumably-intended
// one).

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ execSync: vi.fn() }));

import {
	archiveCheckpoints,
	compareCheckpoints,
	createCheckpoint,
	getCheckpoint,
	listCheckpoints,
	pruneCheckpoints,
	rewindToCheckpoint,
} from "./checkpoints.js";
import type { Checkpoint } from "./checkpoints.js";

const execSyncMock = vi.mocked(execSync);

// ===========================================
// Fixture helpers
// ===========================================

const createdDirs: string[] = [];

function mkTmp(): string {
	const dir = mkdtempSync(join(tmpdir(), "checkpoints-mutkill-"));
	createdDirs.push(dir);
	return dir;
}

function checkpointsPathFor(dir: string): string {
	return join(dir, ".interlinked", "checkpoints.json");
}

function seedCheckpoints(dir: string, checkpoints: Checkpoint[]): void {
	mkdirSync(join(dir, ".interlinked"), { recursive: true });
	writeFileSync(checkpointsPathFor(dir), JSON.stringify(checkpoints, null, 2));
}

function readCheckpointsRaw(dir: string): Checkpoint[] {
	// This file is only ever written by seedCheckpoints/writeCheckpointsFile in
	// this same test, both of which serialize Checkpoint[].
	// SAFETY: the cast just restores the type JSON.parse erases.
	return JSON.parse(readFileSync(checkpointsPathFor(dir), "utf-8")) as Checkpoint[];
}

// Builds an execSync mock from an exact-command -> response map. A key
// ending in "*" matches any command with that prefix (used for the one
// command whose exact text embeds a randomly-generated id). Anything else
// throws loudly instead of returning a silently-wrong default, so a test
// gap surfaces as a failure rather than a false pass.
function gitCommandMock(responses: Record<string, string>): (cmd: string) => string {
	const prefixes = Object.entries(responses)
		.filter(([key]) => key.endsWith("*"))
		.map(([key, value]) => [key.slice(0, -1), value] as const);
	return (cmd: string) => {
		const command = String(cmd);
		const exactMatch = responses[command];
		if (exactMatch !== undefined) return exactMatch;
		const prefixMatch = prefixes.find(([prefix]) => command.startsWith(prefix));
		if (prefixMatch) return prefixMatch[1];
		throw new Error(`unexpected git command in test: ${command}`);
	};
}

function mkCheckpoint(overrides: Partial<Checkpoint> & { id: string }): Checkpoint {
	return {
		id: overrides.id,
		session_id: overrides.session_id ?? "sess-default",
		agent: overrides.agent ?? "agent-default",
		message: overrides.message ?? "msg-default",
		timestamp: overrides.timestamp ?? new Date().toISOString(),
		base_commit: overrides.base_commit ?? "commit-default",
		trigger: overrides.trigger ?? "manual",
		files_changed: overrides.files_changed ?? [],
		stash_ref: overrides.stash_ref,
		restorable: overrides.restorable ?? true,
		metadata: overrides.metadata,
	};
}

// Fixed instant for the whole file (vi.useFakeTimers()): every Date.now() /
// new Date() call below resolves against this value, not the real clock, so
// the "3 days ago" / "exactly at cutoff" fixtures are deterministic and
// immune to real-time drift or slow-machine flake.
const FIXED_NOW = Date.UTC(2026, 0, 10, 12, 0, 0);

let tmpDecoy: string;

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(FIXED_NOW);
	vi.stubEnv("INTERLINKED_DATA_DIR", "");
	vi.stubEnv("INTERLINKED_HOME", "");
	execSyncMock.mockReset();
	tmpDecoy = mkTmp();
	// Default cwd() answer for the whole file: an unseeded decoy directory.
	// Any `cwd || process.cwd()` mutant that starts using process.cwd()
	// instead of an explicit opts.cwd reads/writes here instead of the
	// seeded fixture dir, which every test's assertions can detect.
	vi.spyOn(process, "cwd").mockReturnValue(tmpDecoy);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	for (const dir of createdDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ===========================================
// createCheckpoint (covers git(), isGitRepo(), and createCheckpoint's own survivors)
// ===========================================

describe("createCheckpoint", () => {
	// test-contract: public-api — createCheckpoint must resolve `cwd` from
	// opts.cwd (not process.cwd()) whenever opts.cwd is provided, must invoke
	// git() with the exact shell-safe options object, must build the stash
	// push/pop commands from the generated id and metadata, and must return
	// the full persisted Checkpoint shape (not a stripped/empty object).
	it("resolves opts.cwd, issues the exact git commands, and returns the full checkpoint", () => {
		const tmpA = mkTmp();

		execSyncMock.mockImplementation(
			gitCommandMock({
				"git rev-parse --git-dir": "",
				"git rev-parse HEAD": "headcommit123",
				"git diff --name-only HEAD": "",
				"git ls-files --others --exclude-standard": "",
				"git stash push*": "",
				"git stash list -1 --format=%H": "stashhash456",
				"git stash pop": "",
			}),
		);

		const result = createCheckpoint({
			sessionId: "sess-1",
			agent: "agent-1",
			message: "test checkpoint",
			trigger: "manual",
			cwd: tmpA,
		});

		expect(result).toEqual({
			id: expect.stringMatching(/^[0-9a-f]{12}$/),
			session_id: "sess-1",
			agent: "agent-1",
			message: "test checkpoint",
			timestamp: expect.any(String),
			base_commit: "headcommit123",
			trigger: "manual",
			files_changed: [],
			stash_ref: "stashhash456",
			restorable: true,
			metadata: undefined,
		});

		// isGitRepo's probe is always the first git() call — pins the exact
		// options object git() builds around execSync.
		expect(execSyncMock.mock.calls[0]).toEqual([
			"git rev-parse --git-dir",
			{ cwd: tmpA, encoding: "utf-8", timeout: 10000, stdio: ["pipe", "pipe", "pipe"] },
		]);

		// every git() call in this run must be routed through opts.cwd
		expect(
			execSyncMock.mock.calls.every(([, opts]) => opts?.cwd === tmpA),
		).toBe(true);

		const expectedStashMeta = JSON.stringify({
			id: result.id,
			session_id: "sess-1",
			agent: "agent-1",
			trigger: "manual",
		});
		const expectedPushCmd = `git stash push --include-untracked -m "interlinked:checkpoint:${result.id}:${expectedStashMeta}"`;
		expect(execSyncMock.mock.calls.some(([cmd]) => cmd === expectedPushCmd)).toBe(true);
		expect(execSyncMock.mock.calls.some(([cmd]) => cmd === "git stash pop")).toBe(true);
	});
});

// ===========================================
// listCheckpoints
// ===========================================

describe("listCheckpoints", () => {
	// test-contract: public-api — opts.cwd must take priority over
	// process.cwd(), and a non-positive `limit` (still truthy, e.g. -1) must
	// NOT reach `checkpoints.slice(0, limit)` — a negative end index would
	// silently drop the last element instead of leaving the list untouched.
	it("reads from opts.cwd and ignores a non-positive limit", () => {
		const tmpA = mkTmp();
		const now = Date.now();
		seedCheckpoints(tmpA, [
			mkCheckpoint({ id: "cp-a", timestamp: new Date(now - 1000).toISOString() }),
			mkCheckpoint({ id: "cp-b", timestamp: new Date(now - 2000).toISOString() }),
		]);

		const result = listCheckpoints({ cwd: tmpA, limit: -1 });

		expect(result.map((c) => c.id)).toEqual(["cp-a", "cp-b"]);
	});

	// test-contract: invariant — a corrupt checkpoints.json (JSON.parse
	// throws) must be treated as an empty list, not as a placeholder/sentinel
	// value that then flows into the caller's filter/sort pipeline.
	it("treats a corrupt checkpoints.json as an empty list", () => {
		const tmpA = mkTmp();
		mkdirSync(join(tmpA, ".interlinked"), { recursive: true });
		writeFileSync(checkpointsPathFor(tmpA), "not valid json {");

		const result = listCheckpoints({ cwd: tmpA });

		expect(result).toEqual([]);
	});
});

// ===========================================
// getCheckpoint
// ===========================================

describe("getCheckpoint", () => {
	// test-contract: public-api — the `cwd` positional param must take
	// priority over process.cwd().
	it("resolves the provided cwd rather than process.cwd()", () => {
		const tmpA = mkTmp();
		const target = mkCheckpoint({ id: "cp-target" });
		seedCheckpoints(tmpA, [target, mkCheckpoint({ id: "cp-other" })]);

		const result = getCheckpoint("cp-target", tmpA);

		expect(result).toEqual(target);
	});
});

// ===========================================
// rewindToCheckpoint
// ===========================================

describe("rewindToCheckpoint", () => {
	// test-contract: public-api — opts.cwd must take priority over
	// process.cwd(); a matching, restorable checkpoint on a clean tree must
	// resolve successfully with the stash applied.
	it("rewinds via opts.cwd when the tree is clean and a matching stash exists", () => {
		const tmpA = mkTmp();
		seedCheckpoints(tmpA, [
			mkCheckpoint({ id: "cp1", base_commit: "head1", restorable: true, files_changed: ["a.ts"] }),
		]);

		execSyncMock.mockImplementation(
			gitCommandMock({
				"git rev-parse --git-dir": "",
				"git status --porcelain": "",
				"git rev-parse HEAD": "head1",
				"git stash list --format=%gd:%s": "stash@{0}:interlinked:checkpoint:cp1:{}",
				"git stash apply stash@{0}": "",
			}),
		);

		const result = rewindToCheckpoint("cp1", { cwd: tmpA });

		expect(result).toEqual({ success: true, files_restored: ["a.ts"], warning: undefined });
	});

	// test-contract: public-api — with opts entirely omitted, `!opts?.force`
	// must be a safe optional read, not a `!opts.force` crash on the
	// undefined opts object; the caller-facing error must still be the
	// documented "uncommitted changes" message, not a TypeError.
	it("reports the uncommitted-changes error (not a TypeError) when opts is omitted", () => {
		const tmpA = mkTmp();
		vi.spyOn(process, "cwd").mockReturnValue(tmpA);
		seedCheckpoints(tmpA, [mkCheckpoint({ id: "cp2", restorable: true })]);

		execSyncMock.mockImplementation(
			gitCommandMock({
				"git rev-parse --git-dir": "",
				"git status --porcelain": "M file.ts\n",
			}),
		);

		expect(() => rewindToCheckpoint("cp2")).toThrow("Working tree has uncommitted changes");
	});

	// test-contract: invariant — the reset-working-tree branch requires BOTH
	// hasChanges and force; with hasChanges false it must never call
	// `git checkout -- .`, even when force:true is passed.
	it("does not reset the tree when there are no uncommitted changes, even with force:true", () => {
		const tmpA = mkTmp();
		seedCheckpoints(tmpA, [mkCheckpoint({ id: "cp3", base_commit: "head3", restorable: true })]);

		execSyncMock.mockImplementation(
			gitCommandMock({
				"git rev-parse --git-dir": "",
				"git status --porcelain": "",
				"git rev-parse HEAD": "head3",
				"git checkout -- .": "",
				"git clean -fd": "",
				"git stash list --format=%gd:%s": "stash@{0}:interlinked:checkpoint:cp3:{}",
				"git stash apply stash@{0}": "",
			}),
		);

		const result = rewindToCheckpoint("cp3", { cwd: tmpA, force: true });

		expect(result.success).toBe(true);
		expect(execSyncMock.mock.calls.some(([cmd]) => cmd === "git checkout -- .")).toBe(false);
	});
});

// ===========================================
// compareCheckpoints
// ===========================================

describe("compareCheckpoints", () => {
	// test-contract: public-api — the `cwd` param must take priority over
	// process.cwd(), and the `git diff --stat` command must be built from the
	// exact from/to base_commit values.
	it("resolves cwd and issues the exact git diff --stat command", () => {
		const tmpA = mkTmp();
		seedCheckpoints(tmpA, [
			mkCheckpoint({ id: "cp-from", base_commit: "commitFrom" }),
			mkCheckpoint({ id: "cp-to", base_commit: "commitTo" }),
		]);

		execSyncMock.mockImplementation(
			gitCommandMock({
				"git diff --stat commitFrom..commitTo": "2 files changed, 10 insertions(+)",
			}),
		);

		const result = compareCheckpoints("cp-from", "cp-to", tmpA);

		expect(result.diff_summary).toBe("2 files changed, 10 insertions(+)");
		expect(
			execSyncMock.mock.calls.some(([cmd]) => cmd === "git diff --stat commitFrom..commitTo"),
		).toBe(true);
	});
});

// ===========================================
// pruneCheckpoints (covers writeCheckpointsFile's survivors too)
// ===========================================

describe("pruneCheckpoints", () => {
	// test-contract: invariant — checkpoints must be sorted newest-first
	// before keep_latest slices the array; a dropped or broken comparator
	// keeps an arbitrary (file-insertion-order) survivor instead of the
	// actually-newest one. Verified against Node's real Array.sort behavior
	// for a no-op/undefined/addition comparator on this exact fixture.
	it("keeps the newest checkpoint when keep_latest:1 is applied to an unsorted file", () => {
		const tmpA = mkTmp();
		const now = Date.now();
		seedCheckpoints(tmpA, [
			mkCheckpoint({ id: "oldest", timestamp: new Date(now - 3 * 3600_000).toISOString() }),
			mkCheckpoint({ id: "newest", timestamp: new Date(now - 1 * 3600_000).toISOString() }),
			mkCheckpoint({ id: "middle", timestamp: new Date(now - 2 * 3600_000).toISOString() }),
		]);

		const removed = pruneCheckpoints({ cwd: tmpA, keep_latest: 1 });

		expect(removed).toBe(2);
		expect(readCheckpointsRaw(tmpA).map((c) => c.id)).toEqual(["newest"]);
	});

	// test-contract: boundary — keep_latest must be guarded to positive
	// values only; a negative-but-truthy keep_latest must not reach
	// `checkpoints.slice(0, keep_latest)`, which silently drops everything
	// via a negative end index.
	it("ignores a negative keep_latest", () => {
		const tmpA = mkTmp();
		seedCheckpoints(tmpA, [
			mkCheckpoint({ id: "a" }),
			mkCheckpoint({ id: "b" }),
			mkCheckpoint({ id: "c" }),
		]);

		const removed = pruneCheckpoints({ cwd: tmpA, keep_latest: -5 });

		expect(removed).toBe(0);
	});

	// test-contract: boundary — same guard shape as keep_latest: a
	// negative-but-truthy older_than_days must not reach the cutoff filter,
	// which would otherwise compute a future cutoff and drop everything.
	it("ignores a negative older_than_days", () => {
		const tmpA = mkTmp();
		seedCheckpoints(tmpA, [
			mkCheckpoint({ id: "a", timestamp: new Date().toISOString() }),
			mkCheckpoint({ id: "b", timestamp: new Date().toISOString() }),
		]);

		const removed = pruneCheckpoints({ cwd: tmpA, older_than_days: -1 });

		expect(removed).toBe(0);
	});

	// test-contract: invariant — the cutoff must be older_than_days * 24h in
	// full; any dropped factor in the ms-conversion chain
	// (* 24 * 60 * 60 * 1000) shrinks the window to seconds/minutes and would
	// incorrectly prune a checkpoint that is well inside the real window.
	it("keeps a 3-day-old checkpoint under an explicit 7-day window", () => {
		const tmpA = mkTmp();
		seedCheckpoints(tmpA, [
			mkCheckpoint({ id: "recent", timestamp: new Date(Date.now() - 3 * 86_400_000).toISOString() }),
		]);

		const removed = pruneCheckpoints({ cwd: tmpA, older_than_days: 7 });

		expect(removed).toBe(0);
	});

	// test-contract: boundary — the age filter must keep a checkpoint that is
	// exactly AT the cutoff (>=), not only ones strictly newer than it.
	it("keeps a checkpoint exactly at the cutoff boundary", () => {
		const tmpA = mkTmp();
		const cutoff = FIXED_NOW - 1 * 86_400_000;
		seedCheckpoints(tmpA, [mkCheckpoint({ id: "boundary", timestamp: new Date(cutoff).toISOString() })]);

		const removed = pruneCheckpoints({ cwd: tmpA, older_than_days: 1 });

		expect(removed).toBe(0);
	});

	// test-contract: invariant — writing to a data dir with multiple missing
	// path segments must create the full chain via
	// `mkdirSync(dir, { recursive: true })`; a dropped `recursive` option or
	// an inverted existsSync guard throws ENOENT instead of succeeding.
	it("creates a multi-level-missing data directory before writing", () => {
		const tmpRoot = mkTmp();
		const nestedCwd = join(tmpRoot, "nested", "deep", "path");

		expect(() => pruneCheckpoints({ cwd: nestedCwd })).not.toThrow();

		const path = checkpointsPathFor(nestedCwd);
		expect(existsSync(path)).toBe(true);
		expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual([]);
	});
});

// ===========================================
// archiveCheckpoints
// ===========================================

describe("archiveCheckpoints", () => {
	// test-contract: invariant — with older_than_days omitted (defaults to 7
	// via `|| 7`), the full day->ms conversion chain must be intact; any
	// dropped factor shrinks the window to minutes and would archive a
	// checkpoint that is well inside the real 7-day window.
	it("keeps a 3-day-old restorable checkpoint under the default 7-day window", () => {
		const tmpA = mkTmp();
		seedCheckpoints(tmpA, [
			mkCheckpoint({
				id: "recent",
				restorable: true,
				timestamp: new Date(Date.now() - 3 * 86_400_000).toISOString(),
			}),
		]);

		const result = archiveCheckpoints({ cwd: tmpA });

		expect(result).toEqual({ archived: 0 });
		expect(readCheckpointsRaw(tmpA).find((c) => c.id === "recent")?.restorable).toBe(true);
	});

	// test-contract: boundary — `opts?.older_than_days || 7` must use the
	// caller's value when one is given; forcing the whole expression to
	// `true` (coerces to 1 in the multiplication) archives a checkpoint that
	// is well inside a real, explicitly-requested 30-day window.
	it("honors an explicit older_than_days rather than forcing a 1-day window", () => {
		const tmpA = mkTmp();
		seedCheckpoints(tmpA, [
			mkCheckpoint({
				id: "ten-days",
				restorable: true,
				timestamp: new Date(Date.now() - 10 * 86_400_000).toISOString(),
			}),
		]);

		const result = archiveCheckpoints({ cwd: tmpA, older_than_days: 30 });

		expect(result).toEqual({ archived: 0 });
		expect(readCheckpointsRaw(tmpA).find((c) => c.id === "ten-days")?.restorable).toBe(true);
	});

	// test-contract: invariant — when over max_stash_count, the function must
	// archive from a newest-first sort, counting only restorable checkpoints
	// toward the initial limit. Expected values below were cross-checked with
	// a standalone Node simulation of the real (sort, undefined-comparator,
	// addition-comparator, and restorable-filter-dropped) variants — a
	// dropped sort, a broken comparator, or counting the non-restorable row
	// toward the limit each archive a different, wrong checkpoint than this.
	it("archives exactly the checkpoint the real newest-first over-limit walk selects", () => {
		const tmpA = mkTmp();
		const now = Date.now();
		seedCheckpoints(tmpA, [
			mkCheckpoint({ id: "A", restorable: true, timestamp: new Date(now - 3 * 3600_000).toISOString() }),
			mkCheckpoint({ id: "B", restorable: true, timestamp: new Date(now - 1 * 3600_000).toISOString() }),
			mkCheckpoint({ id: "C", restorable: true, timestamp: new Date(now - 2 * 3600_000).toISOString() }),
			mkCheckpoint({ id: "D", restorable: false, timestamp: new Date(now - 5 * 3600_000).toISOString() }),
		]);

		const result = archiveCheckpoints({ cwd: tmpA, max_stash_count: 2 });

		expect(result).toEqual({ archived: 1 });
		expect(readCheckpointsRaw(tmpA).map((c) => ({ id: c.id, restorable: c.restorable }))).toEqual([
			{ id: "A", restorable: true },
			{ id: "B", restorable: false },
			{ id: "C", restorable: true },
			{ id: "D", restorable: false },
		]);
	});

	// test-contract: boundary — the age filter must archive a checkpoint that
	// is strictly OLDER than cutoff, not one exactly AT the cutoff.
	it("keeps a checkpoint exactly at the age cutoff boundary", () => {
		const tmpA = mkTmp();
		const cutoff = FIXED_NOW - 1 * 86_400_000;
		seedCheckpoints(tmpA, [
			mkCheckpoint({ id: "boundary", restorable: true, timestamp: new Date(cutoff).toISOString() }),
		]);

		const result = archiveCheckpoints({ cwd: tmpA, older_than_days: 1, max_stash_count: 100 });

		expect(result).toEqual({ archived: 0 });
	});
});
