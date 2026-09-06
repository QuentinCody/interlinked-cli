// Coverage tail for config-loosening-gate.ts's two failure-path catches: the
// sibling `.integration.test.ts` and `.mutation-kill-w27.test.ts` companions
// exercise `readHeadVersion` and `readDiskContent` through a nonzero exit /
// absent-file guard, but not through the underlying syscall itself throwing —
// `readHeadVersion`'s outer try/catch around both `spawnSync` calls, and
// `readDiskContent`'s catch around `readFileSync`.
//
// Every spawnSync (git) and fs (existsSync/readFileSync) call is mocked — no
// real process spawns, no real disk I/O — matching the sibling
// mutation-kill-w27 companion's convention for testing this same module.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readDiskContent, readHeadVersion } from "./config-loosening-gate.js";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
vi.mock("node:fs", () => ({ existsSync: vi.fn(), readFileSync: vi.fn() }));

const mockSpawn = vi.mocked(spawnSync);
const mockExists = vi.mocked(existsSync);
const mockReadFile = vi.mocked(readFileSync);

beforeEach(() => {
	vi.resetAllMocks();
});

afterEach(() => {
	vi.clearAllMocks();
});

describe("readHeadVersion — spawnSync throws", () => {
	it("returns \"\" when the git rev-parse spawnSync call itself throws, not just exits non-zero", () => {
		mockSpawn.mockImplementation(() => {
			throw new Error("spawnSync git ENOMEM (simulated)");
		});
		expect(readHeadVersion("tsconfig.json")).toBe("");
	});
});

describe("readDiskContent — readFileSync throws", () => {
	it("returns null when readFileSync throws despite existsSync reporting the path present", () => {
		mockExists.mockReturnValue(true);
		mockReadFile.mockImplementation(() => {
			throw new Error("EACCES: permission denied (simulated)");
		});
		expect(readDiskContent("/some/tsconfig.json", undefined)).toBeNull();
	});
});
