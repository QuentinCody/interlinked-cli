import { makeMinimalEvent as completeEventFixture } from "./__tests__/fixtures/evaluator.js";
// Companion tests for the two ranges the wider fixture-leak suites (the
// integration test, the two mutation-kill waves) leave uncovered:
//
//   - `loadTrackedTestContents`'s own `git ls-files` catch (the tracked-file
//     listing, as opposed to `listUntracked`'s catch, which every existing
//     "not a git repo" test already exercises via the earlier call).
//   - `checkFixtureLeaks`, the Stop-wiring entry point — never exercised for
//     real anywhere else: `server/lifecycle-stop-warnings.test.ts` vi.mocks
//     this whole module and hand-writes a lookalike body instead of calling
//     the genuine export (see that file's own history comment).
//
// Strategy: `listUntracked` and `loadTrackedTestContents` both shell out via
// the same imported `execSync`, so to isolate the SECOND call's catch branch
// (git ls-files, no `--others`) from the first, node:child_process is
// wrapped so a test can inject a per-command override while every other
// test (and every helper below) keeps hitting the real `git` binary. This
// mocks a dependency of the module under test, not the module itself; vitest
// can't `vi.spyOn` an ESM named export directly ("module namespace is not
// configurable"), so the wrapper is the supported route to the same effect.

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerRuntime } from "./server/runtime-context.js";
import type { HarnessEvent } from "./types.js";
import { checkFixtureLeaks, detectFixtureLeaks } from "./fixture-leak.js";

let execSyncOverride: ((cmd: string) => string) | null = null;

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		execSync: (cmd: string, opts?: Parameters<typeof actual.execSync>[1]) => {
			if (execSyncOverride) return execSyncOverride(cmd);
			return actual.execSync(cmd, opts);
		},
	};
});

function fakeCtx(log: (msg: string) => void): ServerRuntime {
	// SAFETY: checkFixtureLeaks only reads ctx.cwd and calls ctx.log; every
	// other ServerRuntime field is irrelevant to this pure-orchestration fn.
	return { cwd: "/unused", log } as unknown as ServerRuntime;
}

function fakeEvent(cwd: string): HarnessEvent {
	// SAFETY: checkFixtureLeaks only reads event.cwd; other HarnessEvent
	// fields are irrelevant to this fixture.
	return ({ ...completeEventFixture(), ...{ hook_event: "Stop", session_id: "s1", agent_source: "claude", cwd } });
}

// ─── loadTrackedTestContents's own catch (line 109) ─────────────────────────

describe("detectFixtureLeaks — tracked-file listing failure", () => {
	afterEach(() => {
		execSyncOverride = null;
	});

	it("returns no leaks when the untracked listing succeeds but the tracked listing fails", () => {
		// The untracked-file call (`git ls-files --others ...`) reports a
		// candidate fixture; the tracked-file call (plain `git ls-files`,
		// which feeds loadTrackedTestContents) throws. detectFixtureLeaks can
		// only ever attribute a leak to a *tracked* test file, so this proves
		// the catch at line 109 falls through to an empty Map rather than
		// throwing out of detectFixtureLeaks itself.
		execSyncOverride = (cmd: string) => {
			if (cmd.includes("--others")) return "src/lib/_leftover.ts\n";
			throw new Error("git ls-files failed");
		};

		expect(detectFixtureLeaks("/irrelevant-cwd")).toEqual([]);
	});
});

// ─── checkFixtureLeaks (lines 154-159) ───────────────────────────────────────

describe("checkFixtureLeaks", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fixture-leak-stop-"));
		execSync("git init -q", { cwd: dir });
		execSync("git config user.email t@example.com", { cwd: dir });
		execSync("git config user.name Test", { cwd: dir });
		execSync("git commit --allow-empty -q -m initial", { cwd: dir });
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns null and logs nothing when there are no leaks", () => {
		const logLines: string[] = [];
		const result = checkFixtureLeaks(fakeCtx((m) => logLines.push(m)), fakeEvent(dir));

		expect(result).toBeNull();
		expect(logLines).toEqual([]);
	});

	it("returns the formatted warning and logs the leak count when leaks exist", () => {
		const testPath = join(dir, "src/__tests__/x.test.ts");
		mkdirSync(join(dir, "src/__tests__"), { recursive: true });
		writeFileSync(
			testPath,
			'const F = "_case_a.ts";\nfunction writeFixture(){}\n',
		);
		execSync("git add src/__tests__/x.test.ts", { cwd: dir });
		execSync('git commit -q -m "add test"', { cwd: dir });
		mkdirSync(join(dir, "src/lib"), { recursive: true });
		writeFileSync(join(dir, "src/lib/_case_a.ts"), "export const X = 1;\n");

		const logLines: string[] = [];
		const result = checkFixtureLeaks(fakeCtx((m) => logLines.push(m)), fakeEvent(dir));

		expect(result).toContain("src/lib/_case_a.ts");
		expect(result).toContain("src/__tests__/x.test.ts");
		expect(logLines).toEqual(["Verify-before-stop: fixture-leaks (1)"]);
	});

	it("falls back to ctx.cwd when the event carries no cwd", () => {
		const logLines: string[] = [];
		// SAFETY: no cwd field at all, so checkFixtureLeaks must use `ctx.cwd`;
		// other HarnessEvent fields are irrelevant to this fixture.
		const event = ({ ...completeEventFixture(), ...{ hook_event: "Stop", session_id: "s1", agent_source: "claude" } });
		// SAFETY: only cwd and log are read by checkFixtureLeaks.
		const ctx = { cwd: dir, log: (m: string) => logLines.push(m) } as unknown as ServerRuntime;

		const result = checkFixtureLeaks(ctx, event);

		expect(result).toBeNull();
		expect(logLines).toEqual([]);
	});
});
