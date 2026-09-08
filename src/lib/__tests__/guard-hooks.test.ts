import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({
	existsSync: vi.fn(),
	readFileSync: vi.fn(),
	writeFileSync: vi.fn(),
	mkdirSync: vi.fn(),
	unlinkSync: vi.fn(),
	chmodSync: vi.fn(),
	renameSync: vi.fn(),
}));

import { getGuardHookStatus, installGuardHook, uninstallGuardHook } from "../guard-hooks.js";

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockMkdirSync = vi.mocked(mkdirSync);
const mockUnlinkSync = vi.mocked(unlinkSync);
const mockChmodSync = vi.mocked(chmodSync);
const mockRenameSync = vi.mocked(renameSync);

beforeEach(() => {
	vi.clearAllMocks();
});

describe("installGuardHook", () => {
	it("installs pre-commit hook in empty hooks dir", () => {
		mockExistsSync.mockImplementation((path) => {
			const p = String(path);
			if (p.endsWith("hooks")) return true; // hooks dir exists
			return false; // no existing hook
		});

		const result = installGuardHook("/test/repo", "pre-commit");

		expect(result.installed).toBe(true);
		expect(result.backed_up).toBeUndefined();
		expect(mockWriteFileSync).toHaveBeenCalledWith(
			"/test/repo/.git/hooks/pre-commit",
			expect.stringContaining("# interlinked-guard"),
		);
		expect(mockChmodSync).toHaveBeenCalledWith("/test/repo/.git/hooks/pre-commit", 0o755);
	});

	it("creates hooks directory if it does not exist", () => {
		mockExistsSync.mockReturnValue(false);

		installGuardHook("/test/repo", "pre-commit");

		expect(mockMkdirSync).toHaveBeenCalledWith("/test/repo/.git/hooks", { recursive: true });
	});

	it("backs up existing hook and creates wrapper", () => {
		mockExistsSync.mockImplementation((path) => {
			const p = String(path);
			if (p.endsWith("hooks")) return true;
			if (p.endsWith("pre-commit")) return true; // existing hook
			return false;
		});
		mockReadFileSync.mockReturnValue("#!/bin/sh\necho original hook");

		const result = installGuardHook("/test/repo", "pre-commit");

		expect(result.installed).toBe(true);
		expect(result.backed_up).toBe("/test/repo/.git/hooks/pre-commit.interlinked-orig");
		expect(mockRenameSync).toHaveBeenCalledWith(
			"/test/repo/.git/hooks/pre-commit",
			"/test/repo/.git/hooks/pre-commit.interlinked-orig",
		);
		// Wrapper should contain interlinked-guard marker
		const writtenContent = mockWriteFileSync.mock.calls[0]?.[1];
		expect(writtenContent).toContain("# interlinked-guard");
	});

	it("is idempotent — does not reinstall if already present", () => {
		mockExistsSync.mockImplementation((path) => {
			const p = String(path);
			if (p.endsWith("hooks")) return true;
			if (p.endsWith("pre-commit")) return true;
			return false;
		});
		mockReadFileSync.mockReturnValue("#!/bin/sh\n# interlinked-guard\nsome content");

		const result = installGuardHook("/test/repo", "pre-commit");

		expect(result.installed).toBe(false);
		expect(mockWriteFileSync).not.toHaveBeenCalled();
	});

	it("installs pre-push hook", () => {
		mockExistsSync.mockImplementation((path) => {
			const p = String(path);
			if (p.endsWith("hooks")) return true;
			return false;
		});

		const result = installGuardHook("/test/repo", "pre-push");

		expect(result.installed).toBe(true);
		expect(mockWriteFileSync).toHaveBeenCalledWith(
			"/test/repo/.git/hooks/pre-push",
			expect.stringContaining("# interlinked-guard"),
		);
	});
});

describe("uninstallGuardHook", () => {
	it("removes guard hook", () => {
		mockExistsSync.mockImplementation((path) => {
			const p = String(path);
			if (p.endsWith("pre-commit")) return true;
			return false; // no backup
		});
		mockReadFileSync.mockReturnValue("#!/bin/sh\n# interlinked-guard\nsome content");

		const result = uninstallGuardHook("/test/repo", "pre-commit");

		expect(result.removed).toBe(true);
		expect(mockUnlinkSync).toHaveBeenCalledWith("/test/repo/.git/hooks/pre-commit");
	});

	it("restores original hook from backup", () => {
		mockExistsSync.mockReturnValue(true);
		mockReadFileSync.mockReturnValue("#!/bin/sh\n# interlinked-guard\nsome content");

		const result = uninstallGuardHook("/test/repo", "pre-commit");

		expect(result.removed).toBe(true);
		expect(result.restored).toBe("/test/repo/.git/hooks/pre-commit");
		expect(mockRenameSync).toHaveBeenCalledWith(
			"/test/repo/.git/hooks/pre-commit.interlinked-orig",
			"/test/repo/.git/hooks/pre-commit",
		);
	});

	it("returns removed=false when no hook exists", () => {
		mockExistsSync.mockReturnValue(false);

		const result = uninstallGuardHook("/test/repo", "pre-commit");

		expect(result.removed).toBe(false);
		expect(mockUnlinkSync).not.toHaveBeenCalled();
	});

	it("returns removed=false when hook is not ours", () => {
		mockExistsSync.mockImplementation((path) => {
			const p = String(path);
			if (p.endsWith("pre-commit")) return true;
			return false;
		});
		mockReadFileSync.mockReturnValue("#!/bin/sh\necho not our hook");

		const result = uninstallGuardHook("/test/repo", "pre-commit");

		expect(result.removed).toBe(false);
		expect(mockUnlinkSync).not.toHaveBeenCalled();
	});
});

describe("getGuardHookStatus", () => {
	it("detects installed hooks", () => {
		mockExistsSync.mockReturnValue(true);
		mockReadFileSync.mockReturnValue("#!/bin/sh\n# interlinked-guard\ncontent");

		const status = getGuardHookStatus("/test/repo");

		expect(status.pre_commit).toBe(true);
		expect(status.pre_push).toBe(true);
	});

	it("detects missing hooks", () => {
		mockExistsSync.mockReturnValue(false);

		const status = getGuardHookStatus("/test/repo");

		expect(status.pre_commit).toBe(false);
		expect(status.pre_push).toBe(false);
	});

	it("detects non-guard hooks as not installed", () => {
		mockExistsSync.mockReturnValue(true);
		mockReadFileSync.mockReturnValue("#!/bin/sh\necho different hook");

		const status = getGuardHookStatus("/test/repo");

		expect(status.pre_commit).toBe(false);
		expect(status.pre_push).toBe(false);
	});

	it("treats an unreadable hook file as not installed", () => {
		mockExistsSync.mockReturnValue(true);
		mockReadFileSync.mockImplementation(() => {
			throw new Error("EACCES: permission denied");
		});

		const status = getGuardHookStatus("/test/repo");

		expect(status.pre_commit).toBe(false);
		expect(status.pre_push).toBe(false);
	});
});
