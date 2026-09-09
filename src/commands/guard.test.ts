import { parseWire, wireArray, wireObject, wireRecord, wireString, wireUnknown } from "../lib/value-validation.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../lib/non-null.js";
import {
	guardCheckCommand,
	guardInstallCommand,
	guardStatusCommand,
	guardUninstallCommand,
} from "./guard.js";

// ===========================================
// Behavioral tests for `interlinked guard`.
//
// Covers all four command handlers (install / check / status / uninstall)
// across every output mode (json + normal), every branch (git-repo guard,
// mode ternaries, conflict match/no-match, own-reservation skip, staged
// vs explicit files, block-mode exit code, cache present/absent/stale,
// server-reachable vs server-down fallbacks, catch/outputError), and the
// pure helpers (getGuardMode, readGuardCache JSON-parse failure, writeGuardCache
// mkdir branch) reached transitively through the public handlers.
//
// Color helpers in ../lib/formatter.js are inert under the test env
// (NO_COLOR/CI/non-TTY) so normal-mode assertions match on plain substrings.
// ===========================================

// --- api-client (consumed via dynamic import inside getReservations) ---
const mockCallTool = vi.fn();
vi.mock("../lib/api-client.js", () => ({
	getClient: vi.fn(() => ({ callTool: mockCallTool })),
}));

// --- config ---
const mockReadLocalConfig = vi.fn<() => unknown>(() => ({
	agent_name: "my-agent",
	guard_mode: "warn",
}));
const mockUpdateLocalConfig = vi.fn();
vi.mock("../lib/config.js", () => ({
	readLocalConfig: () => mockReadLocalConfig(),
	updateLocalConfig: (...args: unknown[]) => mockUpdateLocalConfig(...args),
	getConfigDir: () => "/test/.interlinked",
}));

// --- git-utils ---
const mockIsGitRepo = vi.fn(() => true);
const mockGetStagedFiles = vi.fn<() => string[]>(() => []);
const mockGetGitToplevel = vi.fn<() => string | null>(() => "/test/repo");
vi.mock("../lib/git-utils.js", () => ({
	isGitRepo: () => mockIsGitRepo(),
	getStagedFiles: () => mockGetStagedFiles(),
	getGitToplevel: () => mockGetGitToplevel(),
}));

// --- guard-hooks ---
const mockInstallGuardHook =
	vi.fn<(root: string, hook: string) => { installed: boolean; backed_up?: string }>();
const mockUninstallGuardHook =
	vi.fn<(root: string, hook: string) => { removed: boolean; restored?: string }>();
const mockGetGuardHookStatus = vi.fn(() => ({ pre_commit: false, pre_push: false }));
vi.mock("../lib/guard-hooks.js", () => ({
	installGuardHook: (root: string, hook: string) => mockInstallGuardHook(root, hook),
	uninstallGuardHook: (root: string, hook: string) => mockUninstallGuardHook(root, hook),
	getGuardHookStatus: () => mockGetGuardHookStatus(),
	GUARD_CACHE_FILE: "guard-cache.json",
}));

// --- glob-overlap: real path-pattern matching is what we want to exercise,
//     but pin it deterministically: overlap when the file path starts with
//     the pattern's directory prefix (everything before the first glob char).
vi.mock("../lib/glob-overlap.js", () => ({
	patternsOverlap: (file: string, pattern: string) => {
		const prefix = nonNull(pattern.split(/[*?[]/)[0]);
		return file.startsWith(prefix);
	},
}));

// --- node:fs (cache read/write) ---
const mockExistsSync = vi.fn<(p: string) => boolean>(() => false);
const mockReadFileSync = vi.fn<(p: string, enc?: string) => string>(() => "{}");
const mockWriteFileSync = vi.fn<typeof import("node:fs").writeFileSync>();
const mockMkdirSync = vi.fn();
vi.mock("node:fs", () => ({
	existsSync: (p: string) => mockExistsSync(p),
	readFileSync: (p: string, enc?: string) => mockReadFileSync(p, enc),
	writeFileSync: (...args: Parameters<typeof mockWriteFileSync>) => mockWriteFileSync(...args),
	mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
}));

// ===========================================
// Helpers
// ===========================================

function logOutput(): string {
	return vi
		.mocked(console.log)
		.mock.calls.map((args) => String(args[0]))
		.join("\n");
}

function errOutput(): string {
	return vi
		.mocked(console.error)
		.mock.calls.map((args) => String(args[0]))
		.join("\n");
}

function lastLogJson(): Record<string, unknown> {
	const raw = vi.mocked(console.log).mock.calls.at(-1)?.[0];
	if (typeof raw !== "string") throw new Error(`expected string log, got ${typeof raw}`);
	return parseWire(JSON.parse(raw), wireRecord(wireUnknown), "test JSON value");
}

beforeEach(() => {
	vi.clearAllMocks();
	process.exitCode = 0;
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	// Reset default mock behaviors (cleared above).
	mockReadLocalConfig.mockReturnValue({ agent_name: "my-agent", guard_mode: "warn" });
	mockIsGitRepo.mockReturnValue(true);
	mockGetStagedFiles.mockReturnValue([]);
	mockGetGitToplevel.mockReturnValue("/test/repo");
	mockInstallGuardHook.mockReturnValue({ installed: true });
	mockUninstallGuardHook.mockReturnValue({ removed: true });
	mockGetGuardHookStatus.mockReturnValue({ pre_commit: false, pre_push: false });
	mockExistsSync.mockReturnValue(false);
	mockReadFileSync.mockReturnValue("{}");
	mockCallTool.mockResolvedValue({ reservations: [] });
});

afterEach(() => {
	vi.restoreAllMocks();
});

// ===========================================
// guard install
// ===========================================

describe("guardInstallCommand", () => {
	it("exports a function", () => {
		expect(typeof guardInstallCommand).toBe("function");
		expect(guardInstallCommand.name).toBe("guardInstallCommand");
	});

	it("installs pre-commit in warn mode (json) and persists guard_mode", async () => {
		await guardInstallCommand({ mode: "warn", json: true });

		expect(mockInstallGuardHook).toHaveBeenCalledWith("/test/repo", "pre-commit");
		expect(mockInstallGuardHook).not.toHaveBeenCalledWith("/test/repo", "pre-push");
		expect(mockUpdateLocalConfig).toHaveBeenCalledWith({ guard_mode: "warn" });

		const out = lastLogJson();
		expect(out.mode).toBe("warn");
		expect(out.pre_commit).toEqual({ installed: true });
		expect(out.pre_push).toBeUndefined();
		expect(out.config_dir).toBe("/test/.interlinked");
		expect(process.exitCode).toBe(0);
	});

	it("maps non-'block' modes to warn (undefined mode → warn ternary false branch)", async () => {
		await guardInstallCommand({ json: true });
		expect(mockUpdateLocalConfig).toHaveBeenCalledWith({ guard_mode: "warn" });
		expect(lastLogJson().mode).toBe("warn");
	});

	it("installs in block mode (json)", async () => {
		await guardInstallCommand({ mode: "block", json: true });
		expect(mockUpdateLocalConfig).toHaveBeenCalledWith({ guard_mode: "block" });
		expect(lastLogJson().mode).toBe("block");
	});

	it("installs pre-push when prePush is set (json)", async () => {
		await guardInstallCommand({ mode: "warn", prePush: true, json: true });
		expect(mockInstallGuardHook).toHaveBeenCalledWith("/test/repo", "pre-push");
		expect(lastLogJson().pre_push).toEqual({ installed: true });
	});

	it("normal mode: warn, freshly-installed pre-commit, allow-commits guidance", async () => {
		mockInstallGuardHook.mockReturnValue({ installed: true });
		await guardInstallCommand({ mode: "warn" });

		const text = logOutput();
		expect(text).toContain("Guard Installed");
		expect(text).toContain("warn");
		expect(text).toContain("installed");
		expect(text).toContain("Conflicts will show warnings but allow commits.");
		expect(text).not.toContain("Backup");
	});

	it("normal mode: block + already-installed pre-commit + backup + pre-push", async () => {
		mockInstallGuardHook.mockImplementation((_root, hook) =>
			hook === "pre-commit"
				? { installed: false, backed_up: "/test/repo/.git/hooks/pre-commit.bak" }
				: { installed: true },
		);
		await guardInstallCommand({ mode: "block", prePush: true });

		const text = logOutput();
		expect(text).toContain("block");
		expect(text).toContain("already installed");
		expect(text).toContain("Backup");
		expect(text).toContain("/test/repo/.git/hooks/pre-commit.bak");
		// pre-push line present and shows freshly installed.
		expect(text).toContain("pre-push");
		expect(text).toContain("Commits with conflicts will be blocked.");
	});

	it("normal mode: pre-push already-installed branch", async () => {
		mockInstallGuardHook.mockImplementation((_root, hook) =>
			hook === "pre-push" ? { installed: false } : { installed: true },
		);
		await guardInstallCommand({ mode: "warn", prePush: true });
		const text = logOutput();
		expect(text).toContain("pre-push");
		expect(text).toContain("already installed");
	});

	it("falls back to cwd when getGitToplevel returns null", async () => {
		mockGetGitToplevel.mockReturnValue(null);
		const spy = vi.spyOn(process, "cwd").mockReturnValue("/cwd/fallback");
		try {
			await guardInstallCommand({ json: true });
			expect(mockInstallGuardHook).toHaveBeenCalledWith("/cwd/fallback", "pre-commit");
		} finally {
			spy.mockRestore();
		}
	});

	it("errors (exit 1) and skips install when not a git repo — json error shape", async () => {
		mockIsGitRepo.mockReturnValue(false);
		await guardInstallCommand({ json: true });

		expect(mockInstallGuardHook).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
		const err = parseWire(JSON.parse(errOutput()), wireObject({ "error": wireString }), "test JSON value");
		expect(err.error).toContain("Not a git repository");
	});

	it("catch path surfaces a non-Error throw via String() (normal mode)", async () => {
		mockIsGitRepo.mockReturnValue(true);
		mockInstallGuardHook.mockImplementation(() => {
			throw "boom-string";
		});
		await guardInstallCommand({});
		expect(errOutput()).toContain("Error: boom-string");
		expect(process.exitCode).toBe(1);
	});
});

// ===========================================
// guard check
// ===========================================

describe("guardCheckCommand", () => {
	it("exports a function", () => {
		expect(typeof guardCheckCommand).toBe("function");
		expect(guardCheckCommand.name).toBe("guardCheckCommand");
	});

	it("no staged files → clean, files_checked 0 (json)", async () => {
		mockGetStagedFiles.mockReturnValue([]);
		await guardCheckCommand({ json: true });
		const out = lastLogJson();
		expect(out.clean).toBe(true);
		expect(out.conflicts).toEqual([]);
		expect(out.files_checked).toBe(0);
		expect(out.cached).toBe(false);
		expect(out.mode).toBe("warn");
		// Server is never queried when there are no files.
		expect(mockCallTool).not.toHaveBeenCalled();
	});

	it("no staged files → normal mode prints the no-files message", async () => {
		mockGetStagedFiles.mockReturnValue([]);
		await guardCheckCommand({});
		expect(logOutput()).toContain("No files to check (no staged files).");
	});

	it("clean when the only reservation does not overlap (json) and caches result", async () => {
		mockCallTool.mockResolvedValue({
			reservations: [{ agent_name: "other", path_pattern: "docs/**" }],
		});
		await guardCheckCommand({ files: ["src/auth/login.ts"], json: true });

		const out = lastLogJson();
		expect(out.clean).toBe(true);
		expect(out.conflicts).toEqual([]);
		expect(out.files_checked).toBe(1);
		// Server reachable → cache written, not read.
		expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
		expect(mockCallTool).toHaveBeenCalledWith("list_file_reservations", { brief: true });
	});

	it("clean normal mode prints the green no-conflicts summary with file count", async () => {
		mockCallTool.mockResolvedValue({ reservations: [] });
		await guardCheckCommand({ files: ["src/a.ts", "src/b.ts"] });
		expect(logOutput()).toContain("No reservation conflicts (2 files checked).");
	});

	it("detects a conflict from another agent's reservation (json)", async () => {
		mockCallTool.mockResolvedValue({
			reservations: [
				{
					agent_name: "other-agent",
					path_pattern: "src/auth/**",
					expires_at: "2030-01-01T00:00:00Z",
				},
			],
		});
		await guardCheckCommand({ files: ["src/auth/login.ts"], json: true });

		const out = lastLogJson();
		expect(out.clean).toBe(false);
		const conflicts = parseWire(out.conflicts, wireArray(wireRecord(wireUnknown)), "test JSON value");
		expect(conflicts).toHaveLength(1);
		expect(conflicts[0]).toMatchObject({
			file: "src/auth/login.ts",
			reserved_by: "other-agent",
			reservation_pattern: "src/auth/**",
			expires_at: "2030-01-01T00:00:00Z",
		});
		// warn mode → no non-zero exit on conflict.
		expect(process.exitCode).toBe(0);
	});

	it("skips the caller's own reservations (agentName === reservation.agent_name)", async () => {
		mockReadLocalConfig.mockReturnValue({ agent_name: "my-agent", guard_mode: "warn" });
		mockCallTool.mockResolvedValue({
			reservations: [{ agent_name: "my-agent", path_pattern: "src/auth/**" }],
		});
		await guardCheckCommand({ files: ["src/auth/login.ts"], json: true });
		expect(lastLogJson().clean).toBe(true);
	});

	it("does NOT skip when agentName is unset (config has no agent_name)", async () => {
		mockReadLocalConfig.mockReturnValue({ guard_mode: "warn" });
		mockCallTool.mockResolvedValue({
			reservations: [{ agent_name: "anon", path_pattern: "src/**" }],
		});
		await guardCheckCommand({ files: ["src/x.ts"], json: true });
		expect(lastLogJson()).toHaveProperty(["conflicts","length"], 1);
	});

	it("uses staged files when --files is empty", async () => {
		mockGetStagedFiles.mockReturnValue(["src/index.ts"]);
		mockCallTool.mockResolvedValue({ reservations: [] });
		await guardCheckCommand({ files: [], json: true });
		expect(lastLogJson().files_checked).toBe(1);
		expect(mockGetStagedFiles).toHaveBeenCalled();
	});

	it("block mode + conflict → exit code 1", async () => {
		mockReadLocalConfig.mockReturnValue({ agent_name: "me", guard_mode: "block" });
		mockCallTool.mockResolvedValue({
			reservations: [{ agent_name: "other", path_pattern: "src/**" }],
		});
		await guardCheckCommand({ files: ["src/index.ts"], json: true });
		expect(process.exitCode).toBe(1);
		expect(lastLogJson().clean).toBe(false);
	});

	it("block mode but clean → exit code stays 0", async () => {
		mockReadLocalConfig.mockReturnValue({ agent_name: "me", guard_mode: "block" });
		mockCallTool.mockResolvedValue({ reservations: [] });
		await guardCheckCommand({ files: ["src/index.ts"], json: true });
		expect(process.exitCode).toBe(0);
	});

	it("cross-checks every file against every reservation (json)", async () => {
		mockCallTool.mockResolvedValue({
			reservations: [
				{ agent_name: "a", path_pattern: "src/auth/**" },
				{ agent_name: "b", path_pattern: "src/api/**" },
			],
		});
		await guardCheckCommand({
			files: ["src/auth/login.ts", "src/api/routes.ts", "README.md"],
			json: true,
		});
		const conflicts = parseWire(lastLogJson().conflicts, wireArray(wireRecord(wireUnknown)), "test JSON value");
		expect(conflicts).toHaveLength(2);
		expect(conflicts.map((x) => x.reserved_by)).toEqual(["a", "b"]);
		expect(lastLogJson().files_checked).toBe(3);
	});

	it("normal mode: singular conflict wording, no-expiry pattern line, no cache note", async () => {
		mockCallTool.mockResolvedValue({
			reservations: [{ agent_name: "other-agent", path_pattern: "src/auth/**" }],
		});
		await guardCheckCommand({ files: ["src/auth/login.ts"] });

		const text = logOutput();
		expect(text).toContain("1 reservation conflict found:"); // singular branch
		expect(text).toContain("src/auth/login.ts");
		expect(text).toContain("reserved by");
		expect(text).toContain("other-agent");
		expect(text).toContain("pattern:");
		expect(text).toContain("src/auth/**");
		expect(text).not.toContain("expires");
		expect(text).not.toContain("using cached reservations");
	});

	it("normal mode: plural conflict wording + expiry suffix on the pattern line", async () => {
		mockCallTool.mockResolvedValue({
			reservations: [{ agent_name: "x", path_pattern: "src/**", expires_at: "2030-06-01" }],
		});
		await guardCheckCommand({ files: ["src/a.ts", "src/b.ts"] });
		const text = logOutput();
		expect(text).toContain("2 reservation conflicts found:"); // plural branch
		expect(text).toContain("(expires 2030-06-01)");
	});
});

// ===========================================
// guard check — server-down fallback paths (getReservations catch branch)
// ===========================================

describe("guardCheckCommand reservation fallback", () => {
	function makeCache(ageMs: number, reservations: unknown[]): string {
		return JSON.stringify({
			reservations,
			fetched_at: new Date(Date.now() - ageMs).toISOString(),
		});
	}

	it("server unreachable + fresh cache → uses cache, cached:true, age reported (json)", async () => {
		mockCallTool.mockRejectedValue(new Error("ECONNREFUSED"));
		mockExistsSync.mockReturnValue(true);
		mockReadFileSync.mockReturnValue(
			makeCache(2000, [{ agent_name: "other", path_pattern: "src/**" }]),
		);

		await guardCheckCommand({ files: ["src/x.ts"], json: true });
		const out = lastLogJson();
		expect(out.cached).toBe(true);
		expect(typeof out.cache_age_seconds).toBe("number");
		expect(out.cache_age_seconds).toBeGreaterThanOrEqual(2);
		expect(out).toHaveProperty(["conflicts","length"], 1);
		// No stale warning for a fresh cache.
		expect(errOutput()).not.toContain("stale");
	});

	it("server unreachable + STALE cache → warns to stderr but still uses it", async () => {
		mockCallTool.mockRejectedValue(new Error("down"));
		mockExistsSync.mockReturnValue(true);
		// 6 minutes old > 5-minute TTL.
		mockReadFileSync.mockReturnValue(
			makeCache(6 * 60 * 1000, [{ agent_name: "other", path_pattern: "src/**" }]),
		);

		await guardCheckCommand({ files: ["src/x.ts"], json: true });
		expect(errOutput()).toContain("reservation cache is stale");
		expect(lastLogJson().cached).toBe(true);
	});

	it("server unreachable + no cache → empty reservations, cached:false, warning", async () => {
		mockCallTool.mockRejectedValue(new Error("down"));
		mockExistsSync.mockReturnValue(false);

		await guardCheckCommand({ files: ["src/x.ts"], json: true });
		const out = lastLogJson();
		expect(out.cached).toBe(false);
		expect(out.conflicts).toEqual([]);
		expect(out.clean).toBe(true);
		expect(errOutput()).toContain("could not fetch reservations and no cache available");
	});

	it("server unreachable + corrupt cache file (JSON.parse throws) → treated as no cache", async () => {
		mockCallTool.mockRejectedValue(new Error("down"));
		mockExistsSync.mockReturnValue(true);
		mockReadFileSync.mockReturnValue("{not-json");

		await guardCheckCommand({ files: ["src/x.ts"], json: true });
		expect(lastLogJson().cached).toBe(false);
		expect(errOutput()).toContain("no cache available");
	});

	it.each([
		null,
		{ reservations: [null], fetched_at: "2026-09-08T12:00:00Z" },
		{ reservations: [], fetched_at: "invalid timestamp" },
	])("rejects malformed reservation cache contents: %j", async cache => {
		mockCallTool.mockRejectedValue(new Error("down"));
		mockExistsSync.mockReturnValue(true);
		mockReadFileSync.mockReturnValue(JSON.stringify(cache));

		await guardStatusCommand({ json: true });
		expect(lastLogJson().cache).toBeNull();
		await guardCheckCommand({ files: ["src/x.ts"], json: true });
		expect(lastLogJson().cached).toBe(false);
		expect(errOutput()).toContain("no cache available");
	});

	it("normal mode conflict using cached reservations prints the cache-age note", async () => {
		mockCallTool.mockRejectedValue(new Error("down"));
		mockExistsSync.mockReturnValue(true);
		mockReadFileSync.mockReturnValue(
			makeCache(3000, [{ agent_name: "other", path_pattern: "src/**" }]),
		);

		await guardCheckCommand({ files: ["src/a.ts"] });
		const text = logOutput();
		expect(text).toContain("using cached reservations");
		expect(text).toMatch(/\d+s old/);
	});

	it("normal mode cached conflict with sub-1s age omits the age suffix (falsy ternary)", async () => {
		// age < 1000ms → Math.floor(ageMs/1000) === 0 (falsy) → no ", Ns old".
		mockCallTool.mockRejectedValue(new Error("down"));
		mockExistsSync.mockReturnValue(true);
		mockReadFileSync.mockReturnValue(
			makeCache(0, [{ agent_name: "other", path_pattern: "src/**" }]),
		);

		await guardCheckCommand({ files: ["src/a.ts"] });
		const text = logOutput();
		expect(text).toContain("using cached reservations");
		// No "<n>s old" suffix because age floored to 0.
		expect(text).not.toMatch(/\d+s old/);
	});

	it("check catch path with a non-Error throw uses String(err)", async () => {
		// isGitRepo throws a non-Error to hit the String(err) branch of the catch.
		mockIsGitRepo.mockImplementation(() => {
			throw "check-boom";
		});
		await guardCheckCommand({ files: ["src/a.ts"] });
		expect(errOutput()).toContain("Error: check-boom");
		expect(process.exitCode).toBe(1);
	});

	it("server returns null result → defaults to empty reservation list (?? path)", async () => {
		mockCallTool.mockResolvedValue(null);
		await guardCheckCommand({ files: ["src/a.ts"], json: true });
		expect(lastLogJson().clean).toBe(true);
		// Reachable server (returned, didn't throw) → cache still written.
		expect(mockWriteFileSync).toHaveBeenCalled();
	});

	it("writeGuardCache creates the config dir when it does not exist", async () => {
		// existsSync(false) for both the cache-path read AND the dir check.
		mockExistsSync.mockReturnValue(false);
		mockCallTool.mockResolvedValue({ reservations: [] });
		await guardCheckCommand({ files: ["src/a.ts"], json: true });
		expect(mockMkdirSync).toHaveBeenCalledWith("/test/.interlinked", { recursive: true });
		expect(mockWriteFileSync).toHaveBeenCalled();
	});

	it("writeGuardCache skips mkdir when the dir already exists", async () => {
		// dir exists → existsSync true. Cache-path existsSync is read first in
		// getReservations only on the failure path; success path reads dir only.
		mockExistsSync.mockReturnValue(true);
		mockCallTool.mockResolvedValue({ reservations: [] });
		await guardCheckCommand({ files: ["src/a.ts"], json: true });
		expect(mockMkdirSync).not.toHaveBeenCalled();
		expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
		const [cachePath, cacheBody] = nonNull(mockWriteFileSync.mock.calls[0]);
		expect(cachePath).toBe("/test/.interlinked/guard-cache.json");
		expect(JSON.parse(parseWire(cacheBody, wireString, "guard cache write")).reservations).toEqual([]);
	});

	it("not a git repo → outputError and exit 1 (no server call)", async () => {
		mockIsGitRepo.mockReturnValue(false);
		await guardCheckCommand({ files: ["src/a.ts"], json: true });
		expect(process.exitCode).toBe(1);
		expect(mockCallTool).not.toHaveBeenCalled();
		const err = parseWire(JSON.parse(errOutput()), wireObject({ "error": wireString }), "test JSON value");
		expect(err.error).toContain("Not a git repository");
	});
});

// ===========================================
// guard status
// ===========================================

describe("guardStatusCommand", () => {
	it("exports a function", () => {
		expect(typeof guardStatusCommand).toBe("function");
	});

	it("json: hooks installed, warn mode, empty cache", async () => {
		mockGetGuardHookStatus.mockReturnValue({ pre_commit: true, pre_push: false });
		mockReadLocalConfig.mockReturnValue({ agent_name: "me", guard_mode: "warn" });
		mockExistsSync.mockReturnValue(false); // no cache file

		await guardStatusCommand({ json: true });
		const out = lastLogJson();
		expect(out.mode).toBe("warn");
		expect(out.hooks).toEqual({ pre_commit: true, pre_push: false });
		expect(out.git_repo).toBe(true);
		expect(out.cache).toBeNull();
	});

	it("json: with a populated cache reports count + age", async () => {
		mockExistsSync.mockReturnValue(true);
		mockReadFileSync.mockReturnValue(
			JSON.stringify({
				reservations: [{ agent_name: "a", path_pattern: "x/**" }],
				fetched_at: new Date(Date.now() - 5000).toISOString(),
			}),
		);
		await guardStatusCommand({ json: true });
		const cache = parseWire(lastLogJson().cache, wireRecord(wireUnknown), "test JSON value");
		expect(cache.reservation_count).toBe(1);
		expect(cache.age_seconds).toBeGreaterThanOrEqual(5);
		expect(typeof cache.fetched_at).toBe("string");
	});

	it("normal mode: off mode + not-installed hooks + empty cache", async () => {
		mockReadLocalConfig.mockReturnValue({ guard_mode: "off" });
		mockGetGuardHookStatus.mockReturnValue({ pre_commit: false, pre_push: false });
		mockExistsSync.mockReturnValue(false);

		await guardStatusCommand({});
		const text = logOutput();
		expect(text).toContain("Guard Status");
		expect(text).toContain("off");
		expect(text).toContain("not installed");
		// Cache: empty branch.
		expect(text).toMatch(/Cache.*empty/s);
	});

	it("normal mode: block mode renders the block label + cache line when present", async () => {
		mockReadLocalConfig.mockReturnValue({ guard_mode: "block" });
		mockGetGuardHookStatus.mockReturnValue({ pre_commit: true, pre_push: true });
		mockExistsSync.mockReturnValue(true);
		mockReadFileSync.mockReturnValue(
			JSON.stringify({
				reservations: [{ agent_name: "a", path_pattern: "x/**" }],
				fetched_at: new Date().toISOString(),
			}),
		);
		await guardStatusCommand({});
		const text = logOutput();
		expect(text).toContain("block");
		expect(text).toContain("installed");
		expect(text).toMatch(/Cache.*1 reservations/s);
	});

	it("normal mode: warn label branch", async () => {
		mockReadLocalConfig.mockReturnValue({ guard_mode: "warn" });
		await guardStatusCommand({});
		expect(logOutput()).toContain("warn");
	});

	it("normal mode: not a git repo renders the red 'no' Git-repo line + off (no guard_mode → || 'off')", async () => {
		mockIsGitRepo.mockReturnValue(false);
		// config present but without guard_mode → getGuardMode hits the `|| "off"` branch.
		mockReadLocalConfig.mockReturnValue({ agent_name: "me" });
		mockExistsSync.mockReturnValue(false);

		await guardStatusCommand({});
		const text = logOutput();
		expect(text).toMatch(/Git repo.*no/s); // gitRoot null → "no" branch (L282)
		expect(text).toContain("off"); // mode resolved to "off"
		expect(text).toContain("not installed");
	});

	it("catch path: non-Error throw routes through String(err)", async () => {
		mockReadLocalConfig.mockImplementation(() => {
			throw "status-boom";
		});
		await guardStatusCommand({});
		expect(errOutput()).toContain("Error: status-boom");
		expect(process.exitCode).toBe(1);
	});

	it("not a git repo → git_repo:false, hooks default false, getGuardHookStatus not called", async () => {
		mockIsGitRepo.mockReturnValue(false);
		await guardStatusCommand({ json: true });
		const out = lastLogJson();
		expect(out.git_repo).toBe(false);
		expect(out.hooks).toEqual({ pre_commit: false, pre_push: false });
		expect(mockGetGuardHookStatus).not.toHaveBeenCalled();
		// Reaches output, not the catch path.
		expect(process.exitCode).toBe(0);
	});

	it("git repo but getGitToplevel null → falls back to cwd for hook status", async () => {
		mockIsGitRepo.mockReturnValue(true);
		mockGetGitToplevel.mockReturnValue(null);
		const spy = vi.spyOn(process, "cwd").mockReturnValue("/cwd/x");
		try {
			await guardStatusCommand({ json: true });
			expect(mockGetGuardHookStatus).toHaveBeenCalled();
			expect(lastLogJson().git_repo).toBe(true);
		} finally {
			spy.mockRestore();
		}
	});

	it("catch path: readLocalConfig throwing routes to outputError", async () => {
		mockReadLocalConfig.mockImplementation(() => {
			throw new Error("config blew up");
		});
		await guardStatusCommand({ json: true });
		expect(process.exitCode).toBe(1);
		const err = parseWire(JSON.parse(errOutput()), wireObject({ "error": wireString }), "test JSON value");
		expect(err.error).toBe("config blew up");
	});
});

// ===========================================
// guard uninstall
// ===========================================

describe("guardUninstallCommand", () => {
	it("exports a function", () => {
		expect(typeof guardUninstallCommand).toBe("function");
	});

	it("json: removes both hooks and sets mode off", async () => {
		mockUninstallGuardHook.mockReturnValue({ removed: true });
		await guardUninstallCommand({ json: true });

		expect(mockUninstallGuardHook).toHaveBeenCalledWith("/test/repo", "pre-commit");
		expect(mockUninstallGuardHook).toHaveBeenCalledWith("/test/repo", "pre-push");
		expect(mockUpdateLocalConfig).toHaveBeenCalledWith({ guard_mode: "off" });
		const out = lastLogJson();
		expect(out.mode).toBe("off");
		expect(out.pre_commit).toEqual({ removed: true });
		expect(out.pre_push).toEqual({ removed: true });
	});

	it("normal mode: both removed + restored backups shown", async () => {
		mockUninstallGuardHook.mockImplementation((_root, hook) => ({
			removed: true,
			restored: `/restored/${hook}`,
		}));
		await guardUninstallCommand({});
		const text = logOutput();
		expect(text).toContain("Guard Uninstalled");
		expect(text).toContain("removed");
		expect(text).toContain("Restored");
		expect(text).toContain("/restored/pre-commit");
		expect(text).toContain("/restored/pre-push");
		expect(text).toMatch(/Mode.*off/s);
	});

	it("normal mode: nothing found (not-found branches, no restored lines)", async () => {
		mockUninstallGuardHook.mockReturnValue({ removed: false });
		await guardUninstallCommand({});
		const text = logOutput();
		expect(text).toContain("not found");
		expect(text).not.toContain("Restored");
	});

	it("falls back to cwd when getGitToplevel returns null", async () => {
		mockGetGitToplevel.mockReturnValue(null);
		const spy = vi.spyOn(process, "cwd").mockReturnValue("/cwd/u");
		try {
			await guardUninstallCommand({ json: true });
			expect(mockUninstallGuardHook).toHaveBeenCalledWith("/cwd/u", "pre-commit");
		} finally {
			spy.mockRestore();
		}
	});

	it("not a git repo → outputError, exit 1, no uninstall, no config write", async () => {
		mockIsGitRepo.mockReturnValue(false);
		await guardUninstallCommand({ json: true });
		expect(process.exitCode).toBe(1);
		expect(mockUninstallGuardHook).not.toHaveBeenCalled();
		expect(mockUpdateLocalConfig).not.toHaveBeenCalled();
		const err = parseWire(JSON.parse(errOutput()), wireObject({ "error": wireString }), "test JSON value");
		expect(err.error).toContain("Not a git repository");
	});

	it("catch path: uninstall throwing an Error routes to outputError", async () => {
		mockUninstallGuardHook.mockImplementation(() => {
			throw new Error("rm failed");
		});
		await guardUninstallCommand({});
		expect(errOutput()).toContain("Error: rm failed");
		expect(process.exitCode).toBe(1);
	});

	it("catch path: uninstall throwing a non-Error uses String(err)", async () => {
		mockUninstallGuardHook.mockImplementation(() => {
			throw "rm-boom";
		});
		await guardUninstallCommand({});
		expect(errOutput()).toContain("Error: rm-boom");
		expect(process.exitCode).toBe(1);
	});
});
