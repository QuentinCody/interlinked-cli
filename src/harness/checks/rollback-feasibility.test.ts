// Coverage-campaign companion for rollback-feasibility.ts (Phase 2, unit
// p2u069). Real end-to-end behavior (untracked/tracked/mixed git states,
// argv-shape adversarial filenames, non-git directories, formatRollbackLine
// display quoting) is pinned by __tests__/rollback-feasibility.integration.test.ts,
// which exercises a real git repo and never hits the "unparseable git status
// entry" branch — no real `git status --porcelain -z` entry is ever shorter
// than 4 bytes (2 status bytes + a space + a >=1-char path). This file adds
// ONLY that one unreachable-via-real-git branch, by mocking `execFileSync`'s
// return value directly (node:child_process — not the module under test).

import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { assessRollbackFeasibility } from "./rollback-feasibility.js";

vi.mock("node:child_process", () => ({
	execFileSync: vi.fn(),
}));

const allowAll = (): boolean => true;

describe("assessRollbackFeasibility — malformed porcelain entry", () => {
	it("P: reports 'unparseable git status entry' when a status entry is shorter than 3 characters", () => {
		// Real `git status --porcelain -z` always emits at least "XY name" (>=4
		// bytes); a 2-byte entry can only happen via a malformed/mocked
		// response, which is exactly the defensive branch this check guards.
		vi.mocked(execFileSync).mockReturnValue("AB\0");
		const result = assessRollbackFeasibility("some-file.txt", "/tmp/repo", allowAll);
		expect(result.safe).toBe(false);
		expect(result.reason).toBe("unparseable git status entry");
	});
});
