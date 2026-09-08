// Companion unit tests for trigram-git.ts targeting the branches the two
// existing integration files (trigram-git.integration.test.ts,
// __tests__/trigram-git.integration.test.ts) don't reach with real git:
// the non-fatal catches around the two `--others` sub-discoveries, the
// scratch/ over-cap truncation in boundScratchCandidates(), and a
// permission error mid filesystem-walk fallback.
//
// node:child_process and node:fs are wrapped with vi.fn(actual.<fn>) —
// call-through by default (real git, real fs) for every test — so only the
// one dependency call each test cares about is overridden. This mocks
// trigram-git.ts's two dependencies, never the SUT module itself.
//
// The shared `repo` fixture also carries one UNTRACKED root file
// (untracked.md) that is never `git add`-ed. It is invisible to both
// `git ls-files -z` (tracked) and the two pathspec-scoped `--others --
// .interlinked/hooks/` / `--others -- scratch/` calls (wrong directory), but
// IS visible to the filesystem-walk fallback (walkDir has no pathspec — it
// walks everything under cwd). That asymmetry is what makes the two
// non-fatal-catch tests below discriminating: if either inner catch were
// removed, the simulated failure would escape to the outer catch and return
// walkDir's output instead, which would include untracked.md and so no
// longer equal ["tracked.ts"] — the fixture would betray a silently-deleted
// catch instead of returning the same list either way.

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, execSync: vi.fn(actual.execSync) };
});
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, statSync: vi.fn(actual.statSync), readdirSync: vi.fn(actual.readdirSync) };
});

import { getTrackedFiles } from "./trigram-git.js";

let actualExecSync: typeof execSync;
let actualReaddirSync: typeof readdirSync;
let repo: string;

function git(args: string): void {
	execSync(`git ${args}`, { cwd: repo, stdio: "pipe" });
}

beforeEach(async () => {
	const cp = await vi.importActual<typeof import("node:child_process")>("node:child_process");
	actualExecSync = cp.execSync;
	const fsActual = await vi.importActual<typeof import("node:fs")>("node:fs");
	actualReaddirSync = fsActual.readdirSync;
	// SAFETY: importActual returns the genuine node:child_process/node:fs
	// module, so each cast below just restates the (identical) type that
	// `typeof execSync` / `typeof readdirSync` already infer — it exists only
	// to satisfy the mock's overload-erased parameter type.
	vi.mocked(execSync).mockImplementation(actualExecSync);
	// SAFETY: fsActual.statSync is the real implementation (see above).
	vi.mocked(statSync).mockImplementation(fsActual.statSync);
	// SAFETY: actualReaddirSync is the real implementation (see above).
	vi.mocked(readdirSync).mockImplementation(
		actualReaddirSync,
	);

	repo = mkdtempSync(join(tmpdir(), "trigram-git-unit-"));
	git("init -q");
	git("config user.email t@example.com");
	git("config user.name t");
	git("config commit.gpgsign false");
	writeFileSync(join(repo, "tracked.ts"), "export const a = 1;\n");
	git("add -A");
	git("commit -q -m init");
	// Deliberately left untracked — see the header doc-comment above.
	writeFileSync(join(repo, "untracked.md"), "# u\n");
});

afterEach(() => {
	vi.mocked(execSync).mockReset();
	vi.mocked(statSync).mockReset();
	vi.mocked(readdirSync).mockReset();
	rmSync(repo, { recursive: true, force: true });
});

describe("getTrackedFiles — non-fatal sub-discovery failures", () => {
	it("swallows a failing .interlinked/hooks/ discovery and still returns the tracked files", () => {
		vi.mocked(execSync).mockImplementation(((cmd: string, opts?: unknown) => {
			if (cmd.includes(".interlinked/hooks/")) throw new Error("simulated git failure");
			// SAFETY: `opts` here is always the ExecSyncOptions object this same
			// module passed in — we only intercept the command string above.
			return actualExecSync(cmd, opts as Parameters<typeof execSync>[1]);
		}));

		expect(getTrackedFiles(repo)).toEqual(["tracked.ts"]);
	});

	it("swallows a failing scratch/ discovery and still returns the tracked files", () => {
		vi.mocked(execSync).mockImplementation(((cmd: string, opts?: unknown) => {
			if (cmd.includes("-- scratch/")) throw new Error("simulated git failure");
			// SAFETY: see the equivalent cast in the test above.
			return actualExecSync(cmd, opts as Parameters<typeof execSync>[1]);
		}));

		expect(getTrackedFiles(repo)).toEqual(["tracked.ts"]);
	});
});

describe("getTrackedFiles — scratch/ over the index cap", () => {
	it("keeps only the newest 2000 scratch/ candidates and reports the truncation count", () => {
		const REAL_COUNT = 2000;
		const MISSING_COUNT = 10;
		mkdirSync(join(repo, "scratch"), { recursive: true });

		const names: string[] = [];
		for (let i = 0; i < REAL_COUNT; i++) {
			const name = `scratch/gen-${String(i).padStart(4, "0")}.ts`;
			writeFileSync(join(repo, name), "// x\n");
			names.push(name);
		}
		// These entries are reported by (fabricated) git but never created on
		// disk, so statSync() throws for each one — exercising the "unstattable
		// → mtime stays 0 → sorts oldest, dropped first" catch branch.
		for (let i = 0; i < MISSING_COUNT; i++) {
			names.push(`scratch/gen-missing-${i}.ts`);
		}

		vi.mocked(execSync).mockImplementation(((cmd: string, opts?: unknown) => {
			if (cmd.includes("-- scratch/")) return Buffer.from(`${names.join("\0")}\0`);
			// SAFETY: see the equivalent cast in the sub-discovery tests above.
			return actualExecSync(cmd, opts as Parameters<typeof execSync>[1]);
		}));
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		const files = getTrackedFiles(repo);
		const scratchFiles = files.filter((f) => f.startsWith("scratch/gen-"));

		expect(scratchFiles).toHaveLength(REAL_COUNT);
		expect(scratchFiles).toContain("scratch/gen-0000.ts");
		expect(scratchFiles).toContain("scratch/gen-1999.ts");
		expect(scratchFiles).not.toContain("scratch/gen-missing-0.ts");
		expect(stderrSpy).toHaveBeenCalledWith(
			"[interlinked:index] scratch/ over cap: indexing newest 2000 of 2010 code files (10 older ones skipped)\n",
		);

		stderrSpy.mockRestore();
	});
});

describe("getTrackedFiles — filesystem-walk fallback error handling", () => {
	let walkDir: string;

	beforeEach(() => {
		walkDir = mkdtempSync(join(tmpdir(), "trigram-git-walk-"));
		writeFileSync(join(walkDir, "ok.ts"), "export {};\n");
		mkdirSync(join(walkDir, "locked"), { recursive: true });
		writeFileSync(join(walkDir, "locked", "secret.ts"), "export {};\n");
	});

	afterEach(() => {
		rmSync(walkDir, { recursive: true, force: true });
	});

	it("skips an unreadable subdirectory during the walk but keeps sibling files", () => {
		vi.mocked(readdirSync).mockImplementation(((path: unknown, opts?: unknown) => {
			if (String(path) === join(walkDir, "locked")) {
				throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
			}
			// SAFETY: `path`/`opts` here are always what this same module passed
			// in — we only intercept the one "locked" subdirectory path above.
			return actualReaddirSync(path as Parameters<typeof readdirSync>[0], opts as Parameters<typeof readdirSync>[1]);
		}));

		// `walkDir` was never `git init`-ed, so getTrackedFiles falls back to
		// the filesystem walk, which is where the mocked readdirSync throws.
		const files = getTrackedFiles(walkDir);

		expect(files).toContain("ok.ts");
		expect(files.some((f) => f.includes("locked"))).toBe(false);
	});
});
