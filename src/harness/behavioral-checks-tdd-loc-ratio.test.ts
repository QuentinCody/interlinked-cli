// Companion unit tests for `behavioral-checks-tdd-loc-ratio.ts`'s
// `gitNumstatDelta`, targeting the two fallback catches that the sibling
// `__tests__/behavioral-checks-tdd.integration.test.ts` file (which drives
// most of this module's behavior through real git repos) never forces:
// the outer catch (git unavailable / not a repo at all) and the inner catch
// (the tracked diff succeeds but the untracked-file listing fails after it).
//
// node:child_process is wrapped with vi.fn(actual.execSync) — call-through
// by default (real git) — so the second test can selectively fail just the
// `git ls-files --others` call while every other git invocation still runs
// for real. This mocks a dependency of the module under test, never the
// module itself.

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, execSync: vi.fn(actual.execSync) };
});

import { execSync } from "node:child_process";
import { gitNumstatDelta } from "./behavioral-checks-tdd-loc-ratio.js";

let actualExecSync: typeof execSync;
const tmpDirs: string[] = [];

afterEach(() => {
	vi.mocked(execSync).mockReset();
	for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("gitNumstatDelta — outer catch (no repo at all)", () => {
	// test-contract: bug — gitNumstatDelta must degrade to a zero delta, not
	// throw, when cwd is not inside any git working tree (the tracked-diff
	// call itself fails before any accumulation happens).
	it("returns a zero delta instead of throwing when cwd has no git repository", () => {
		const dir = mkdtempSync(join(tmpdir(), "numstat-no-repo-"));
		tmpDirs.push(dir);

		expect(gitNumstatDelta(dir)).toEqual({ prodLoc: 0, testLoc: 0 });
	});
});

describe("gitNumstatDelta — inner catch (untracked listing fails after tracked succeeds)", () => {
	// test-contract: bug — when the tracked diff already succeeded and ONLY
	// the untracked-file listing fails afterward, the partial tracked totals
	// must be returned (not zero, and not the untracked file's lines, which
	// prove the failing call was never actually counted).
	it("falls back to the tracked-only totals, excluding the untracked file", async () => {
		const cp = await vi.importActual<typeof import("node:child_process")>("node:child_process");
		actualExecSync = cp.execSync;

		const dir = mkdtempSync(join(tmpdir(), "numstat-partial-"));
		tmpDirs.push(dir);
		const runGit = (cmd: string): void => {
			actualExecSync(cmd, { cwd: dir, stdio: "pipe" });
		};
		runGit("git init -q");
		runGit('git config user.email "t@example.com"');
		runGit('git config user.name "t"');

		const tracked = join(dir, "tracked.ts");
		writeFileSync(tracked, "a\nb\nc\n");
		runGit("git add tracked.ts");
		runGit('git commit -q -m base');
		// 3 tracked lines added → numstat reports "3\t0\ttracked.ts".
		writeFileSync(tracked, "a\nb\nc\nd\ne\nf\n");

		// A new untracked prod file that WOULD add 41 lines if the untracked
		// listing succeeded — it must NOT show up in the result below.
		writeFileSync(join(dir, "untracked.ts"), "x\n".repeat(40));

		vi.mocked(execSync).mockImplementation((...args: Parameters<typeof execSync>) => {
			const [cmd] = args;
			if (cmd.includes("ls-files")) throw new Error("simulated git failure");
			return actualExecSync(...args);
		});

		expect(gitNumstatDelta(dir)).toEqual({ prodLoc: 3, testLoc: 0 });
	});
});
