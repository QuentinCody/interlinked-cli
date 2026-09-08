import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../../lib/non-null.js";

// ===========================================
// Response shape interfaces
// ===========================================

interface GuardInstallOutput {
	mode: string;
	pre_commit: { installed: boolean };
}

interface GuardCheckOutput {
	clean: boolean;
	conflicts: Array<{
		file: string;
		reserved_by: string;
		reservation_pattern: string;
	}>;
	files_checked: number;
}

interface GuardStatusOutput {
	mode: string;
	hooks: { pre_commit: boolean; pre_push: boolean };
	git_repo: boolean;
}

interface GuardUninstallOutput {
	mode: string;
}

// ===========================================
// Mocks
// ===========================================

const mockCallTool = vi.fn();

vi.mock("../../lib/api-client.js", () => ({
	getClient: vi.fn(() => ({
		callTool: mockCallTool,
	})),
}));

const mockReadLocalConfig = vi.fn(() => ({
	agent_name: "my-agent",
	guard_mode: "warn",
}));
const mockUpdateLocalConfig = vi.fn();
const mockGetConfigDir = vi.fn(() => "/test/.interlinked");

vi.mock("../../lib/config.js", () => ({
	readLocalConfig: () => mockReadLocalConfig(),
	updateLocalConfig: (...args: unknown[]) => mockUpdateLocalConfig(...args),
	getConfigDir: () => mockGetConfigDir(),
}));

const mockIsGitRepo = vi.fn(() => true);
const mockGetStagedFiles = vi.fn(() : string[] => []);
const mockGetGitToplevel = vi.fn(() => "/test/repo");

vi.mock("../../lib/git-utils.js", () => ({
	isGitRepo: () => mockIsGitRepo(),
	getStagedFiles: () => mockGetStagedFiles(),
	getGitToplevel: () => mockGetGitToplevel(),
}));

const mockInstallGuardHook = vi.fn().mockReturnValue({ installed: true });
const mockUninstallGuardHook = vi.fn().mockReturnValue({ removed: true });
const mockGetGuardHookStatus = vi.fn().mockReturnValue({ pre_commit: false, pre_push: false });

vi.mock("../../lib/guard-hooks.js", () => ({
	installGuardHook: mockInstallGuardHook,
	uninstallGuardHook: mockUninstallGuardHook,
	getGuardHookStatus: mockGetGuardHookStatus,
	GUARD_CACHE_FILE: "guard-cache.json",
}));

// Mock fs for cache read/write
vi.mock("node:fs", () => ({
	existsSync: vi.fn(() => false),
	readFileSync: vi.fn(() => "{}"),
	writeFileSync: vi.fn(),
	mkdirSync: vi.fn(),
}));

/** Parse the last console.log call as JSON with runtime validation. */
function lastLogAsJson<T>(validate: (v: unknown) => v is T): T {
	const raw = vi.mocked(console.log).mock.calls.at(-1)?.[0];
	if (typeof raw !== "string") {
		throw new Error(`Expected last console.log arg to be a string, got ${typeof raw}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (_e) {
		throw new Error(`Failed to parse console.log output as JSON: ${raw}`);
	}
	if (!validate(parsed)) {
		throw new Error(`Parsed JSON did not match expected shape: ${raw}`);
	}
	return parsed;
}

function isGuardInstallOutput(v: unknown): v is GuardInstallOutput {
	return v !== null && typeof v === "object" && "mode" in v && "pre_commit" in v;
}

function isGuardCheckOutput(v: unknown): v is GuardCheckOutput {
	return v !== null && typeof v === "object" && "clean" in v && "conflicts" in v;
}

function isGuardStatusOutput(v: unknown): v is GuardStatusOutput {
	return v !== null && typeof v === "object" && "mode" in v && "hooks" in v;
}

function isGuardUninstallOutput(v: unknown): v is GuardUninstallOutput {
	return v !== null && typeof v === "object" && "mode" in v;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("guard install command", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		process.exitCode = 0;
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	it("installs pre-commit hook with warn mode", async () => {
		const { guardInstallCommand } = await import("../guard.js");
		await guardInstallCommand({ mode: "warn", json: true });

		expect(mockInstallGuardHook).toHaveBeenCalledWith("/test/repo", "pre-commit");
		expect(mockUpdateLocalConfig).toHaveBeenCalledWith({ guard_mode: "warn" });

		const output = lastLogAsJson(isGuardInstallOutput);
		expect(output.mode).toBe("warn");
		expect(output.pre_commit.installed).toBe(true);
	});

	it("installs with block mode", async () => {
		const { guardInstallCommand } = await import("../guard.js");
		await guardInstallCommand({ mode: "block", json: true });

		expect(mockUpdateLocalConfig).toHaveBeenCalledWith({ guard_mode: "block" });

		const output = lastLogAsJson(isGuardInstallOutput);
		expect(output.mode).toBe("block");
	});

	it("installs pre-push hook when requested", async () => {
		const { guardInstallCommand } = await import("../guard.js");
		await guardInstallCommand({ mode: "warn", prePush: true, json: true });

		expect(mockInstallGuardHook).toHaveBeenCalledWith("/test/repo", "pre-commit");
		expect(mockInstallGuardHook).toHaveBeenCalledWith("/test/repo", "pre-push");
	});

	it("errors when not in a git repo", async () => {
		mockIsGitRepo.mockReturnValue(false);

		const { guardInstallCommand } = await import("../guard.js");
		await guardInstallCommand({ json: true });

		expect(process.exitCode).toBe(1);
		expect(mockInstallGuardHook).not.toHaveBeenCalled();
	});
});

describe("guard check command", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		process.exitCode = 0;
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		mockIsGitRepo.mockReturnValue(true);
	});

	it("reports clean when no conflicts", async () => {
		mockCallTool.mockResolvedValue({
			reservations: [
				{ agent_name: "other-agent", path_pattern: "src/api/**", expires_at: null },
			],
		});

		const { guardCheckCommand } = await import("../guard.js");
		await guardCheckCommand({ files: ["src/auth/login.ts"], json: true });

		const output = lastLogAsJson(isGuardCheckOutput);
		expect(output.clean).toBe(true);
		expect(output.conflicts).toEqual([]);
		expect(output.files_checked).toBe(1);
	});

	it("reports conflicts with another agent's reservation", async () => {
		mockCallTool.mockResolvedValue({
			reservations: [
				{
					agent_name: "other-agent",
					path_pattern: "src/auth/**",
					expires_at: "2025-12-31T00:00:00Z",
				},
			],
		});

		const { guardCheckCommand } = await import("../guard.js");
		await guardCheckCommand({ files: ["src/auth/login.ts"], json: true });

		const output = lastLogAsJson(isGuardCheckOutput);
		expect(output.clean).toBe(false);
		expect(output.conflicts).toHaveLength(1);
		expect(nonNull(output.conflicts[0]).file).toBe("src/auth/login.ts");
		expect(nonNull(output.conflicts[0]).reserved_by).toBe("other-agent");
		expect(nonNull(output.conflicts[0]).reservation_pattern).toBe("src/auth/**");
	});

	it("excludes own reservations", async () => {
		mockCallTool.mockResolvedValue({
			reservations: [{ agent_name: "my-agent", path_pattern: "src/auth/**" }],
		});

		const { guardCheckCommand } = await import("../guard.js");
		await guardCheckCommand({ files: ["src/auth/login.ts"], json: true });

		const output = lastLogAsJson(isGuardCheckOutput);
		expect(output.clean).toBe(true);
	});

	it("uses staged files when no --files specified", async () => {
		mockGetStagedFiles.mockReturnValue(["src/index.ts"]);
		mockCallTool.mockResolvedValue({ reservations: [] });

		const { guardCheckCommand } = await import("../guard.js");
		await guardCheckCommand({ json: true });

		const output = lastLogAsJson(isGuardCheckOutput);
		expect(output.files_checked).toBe(1);
	});

	it("reports clean when no files to check", async () => {
		mockGetStagedFiles.mockReturnValue([]);

		const { guardCheckCommand } = await import("../guard.js");
		await guardCheckCommand({ json: true });

		const output = lastLogAsJson(isGuardCheckOutput);
		expect(output.clean).toBe(true);
		expect(output.files_checked).toBe(0);
	});

	it("sets exit code 1 in block mode with conflicts", async () => {
		mockReadLocalConfig.mockReturnValue({ agent_name: "my-agent", guard_mode: "block" });
		mockCallTool.mockResolvedValue({
			reservations: [{ agent_name: "other-agent", path_pattern: "src/**" }],
		});

		const { guardCheckCommand } = await import("../guard.js");
		await guardCheckCommand({ files: ["src/index.ts"], json: true });

		expect(process.exitCode).toBe(1);
	});

	it("multiple files, multiple reservations, cross-check all", async () => {
		mockCallTool.mockResolvedValue({
			reservations: [
				{ agent_name: "agent-a", path_pattern: "src/auth/**" },
				{ agent_name: "agent-b", path_pattern: "src/api/**" },
			],
		});

		const { guardCheckCommand } = await import("../guard.js");
		await guardCheckCommand({
			files: ["src/auth/login.ts", "src/api/routes.ts", "README.md"],
			json: true,
		});

		const output = lastLogAsJson(isGuardCheckOutput);
		expect(output.conflicts).toHaveLength(2);
		expect(nonNull(output.conflicts[0]).reserved_by).toBe("agent-a");
		expect(nonNull(output.conflicts[1]).reserved_by).toBe("agent-b");
		expect(output.files_checked).toBe(3);
	});
});

describe("guard status command", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		process.exitCode = 0;
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		mockIsGitRepo.mockReturnValue(true);
	});

	it("shows status with hooks installed", async () => {
		mockGetGuardHookStatus.mockReturnValue({ pre_commit: true, pre_push: false });
		mockReadLocalConfig.mockReturnValue({ agent_name: "my-agent", guard_mode: "warn" });

		const { guardStatusCommand } = await import("../guard.js");
		await guardStatusCommand({ json: true });

		const output = lastLogAsJson(isGuardStatusOutput);
		expect(output.mode).toBe("warn");
		expect(output.hooks.pre_commit).toBe(true);
		expect(output.hooks.pre_push).toBe(false);
		expect(output.git_repo).toBe(true);
	});
});

describe("guard uninstall command", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		process.exitCode = 0;
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		mockIsGitRepo.mockReturnValue(true);
	});

	it("removes hooks and sets mode to off", async () => {
		mockUninstallGuardHook.mockReturnValue({ removed: true });

		const { guardUninstallCommand } = await import("../guard.js");
		await guardUninstallCommand({ json: true });

		expect(mockUninstallGuardHook).toHaveBeenCalledWith("/test/repo", "pre-commit");
		expect(mockUninstallGuardHook).toHaveBeenCalledWith("/test/repo", "pre-push");
		expect(mockUpdateLocalConfig).toHaveBeenCalledWith({ guard_mode: "off" });

		const output = lastLogAsJson(isGuardUninstallOutput);
		expect(output.mode).toBe("off");
	});
});
