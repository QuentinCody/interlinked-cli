// ===========================================
// CLI Bug Regression Tests
// ===========================================
// Tests for bugs found during local dev server testing.
// Each test validates the rendering/parsing logic directly
// by mocking callTool responses — no server needed.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Deterministic unique-dir suffix: avoids Date.now()/Math.random() so tests are reproducible.
let uniqueDirCounter = 0;
function uniqueDirSuffix(prefix: string): string {
	return `${prefix}-${process.pid}-${++uniqueDirCounter}`;
}

// ===========================================
// Bug 4: workspace list can't work without workspace set
// ===========================================
// Routes through /api/ui/call which needs a workspace selected.
// Should use /api/workspaces (registry endpoint) directly.

describe("Bug 4: workspace list uses direct API", () => {
	it("fetchWorkspaces should exist on InterlinkedClient", async () => {
		// Dynamic import to test the actual module
		const { InterlinkedClient } = await import("../../lib/api-client.js");
		const client = new InterlinkedClient({
			serverUrl: "http://localhost:8787",
		});

		// The fix: fetchWorkspaces() method must exist
		expect(typeof client.fetchWorkspaces).toBe("function");
	});
});

// ===========================================
// Bug 5: disable doesn't clean legacy hooks from ancestor .claude/settings.json
// ===========================================
// uninstallAllClaudeHooks uses getClaudeSettingsPath(cwd) which is
// .claude/settings.json relative to cwd. When run from a subdirectory,
// it misses the project root's settings.

describe("Bug 5: uninstallAllClaudeHooks cleans ancestor settings", () => {
	let tempDir: string;
	let subDir: string;

	beforeEach(() => {
		// Create a temp project structure:
		// tempDir/           (git root)
		//   .git/
		//   .claude/settings.json   (has hooks)
		//   subdir/                  (cwd)
		tempDir = join(tmpdir(), uniqueDirSuffix("cli-test"));
		subDir = join(tempDir, "subdir");

		mkdirSync(join(tempDir, ".git"), { recursive: true });
		mkdirSync(join(tempDir, ".claude"), { recursive: true });
		mkdirSync(subDir, { recursive: true });

		// Write a settings.json with interlinked hooks at the root
		const settingsWithHooks = {
			hooks: {
				PostToolUse: [
					{
						matcher: "",
						hooks: [
							{
								type: "command",
								command: `node ${join(tempDir, ".interlinked", "hooks", "interlinked-activity.mjs")}`,
							},
						],
					},
				],
			},
		};
		writeFileSync(
			join(tempDir, ".claude", "settings.json"),
			JSON.stringify(settingsWithHooks, null, 2),
		);
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("should find and clean hooks from git root .claude/settings.json when run from subdirectory", async () => {
		const { findProjectRoot } = await import("../../lib/hooks.js");

		// findProjectRoot should walk up from subDir to find tempDir (has .git/)
		const root = findProjectRoot(subDir);
		expect(root).toBe(tempDir);
	});

	it("should remove interlinked hooks from ancestor settings", async () => {
		const { uninstallAllHooks } = await import("../../lib/hooks.js");

		// Run uninstall from the subdirectory
		const results = uninstallAllHooks(subDir, ["claude"]);

		// Should have found and removed hooks from the parent's .claude/settings.json
		const cleaned = results.find((r) => r.client === "claude");
		expect(cleaned?.events.length).toBeGreaterThan(0);

		// Verify the file was actually cleaned
		const settings = JSON.parse(
			readFileSync(join(tempDir, ".claude", "settings.json"), "utf-8"),
		);
		// hooks should be empty or the PostToolUse entry should be gone
		const postToolUse = settings.hooks?.PostToolUse;
		expect(!postToolUse || postToolUse.length === 0).toBe(true);
	});
});

// ===========================================
// Bug 10: updateLocalConfig shallow merge clobbers servers map
// ===========================================

describe("Bug 10: updateLocalConfig deep-merges server entries", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), uniqueDirSuffix("cli-config-merge"));
		mkdirSync(join(tempDir, ".interlinked"), { recursive: true });
		writeFileSync(
			join(tempDir, ".interlinked", "config.local.json"),
			`${JSON.stringify(
				{
					active_server: "production",
					servers: {
						production: {
							server_url: "https://prod.example.com",
							workspace_id: "ws_prod_old",
						},
						local: {
							server_url: "http://localhost:8787",
							workspace_id: "ws_local",
						},
					},
				},
				null,
				4,
			)}\n`,
		);
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("preserves unrelated server entries and existing fields when updating one workspace_id", async () => {
		const { updateLocalConfig, readLocalConfig } = await import("../../lib/config.js");

		updateLocalConfig(
			{
				servers: {
					production: {
						workspace_id: "ws_prod_new",
						server_url: "https://prod.example.com",
					},
				},
				workspace_id: "ws_prod_new",
			},
			tempDir,
		);

		const local = readLocalConfig(tempDir);
		expect(local?.servers?.production?.workspace_id).toBe("ws_prod_new");
		expect(local?.servers?.production?.server_url).toBe("https://prod.example.com");
		expect(local?.servers?.local?.workspace_id).toBe("ws_local");
		expect(local?.servers?.local?.server_url).toBe("http://localhost:8787");
	});
});

// ===========================================
// Bug 18: parseDuration should reject invalid input
// ===========================================

describe("Bug 18: parseDuration validation", () => {
	it("throws on invalid duration strings", async () => {
		const { parseDuration } = await import("../../lib/activity-utils.js");
		expect(() => parseDuration("foo")).toThrow(/Invalid duration/);
		expect(() => parseDuration("15x")).toThrow(/Invalid duration/);
	});

	it("accepts valid duration strings", async () => {
		const { parseDuration } = await import("../../lib/activity-utils.js");
		expect(parseDuration("15m")).toBe(15 * 60 * 1000);
		expect(parseDuration("2h")).toBe(2 * 60 * 60 * 1000);
	});
});

// ===========================================
// Bug 23: reset supports --json with non-zero exit signal when --force missing
// ===========================================

describe("Bug 23: reset --json", () => {
	it("emits machine-readable force requirement and sets exitCode", async () => {
		const previousExitCode = process.exitCode;
		process.exitCode = 0;
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		const { resetCommand } = await import("../reset.js");
		await resetCommand({ json: true });

		const last = logSpy.mock.calls.at(-1)?.[0];
		expect(typeof last).toBe("string");
		const payload = JSON.parse(last as string) as { error?: string; usage?: string };
		expect(payload.error).toContain("--force");
		expect(payload.usage).toContain("interlinked reset --force");
		expect(process.exitCode).toBe(1);

		logSpy.mockRestore();
		process.exitCode = previousExitCode;
	});
});

// ===========================================
// Bug 24: initConfig should preserve default_project on re-init
// ===========================================

describe("Bug 24: initConfig preserves shared defaults", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), uniqueDirSuffix("cli-init-config"));
		mkdirSync(join(tempDir, ".interlinked"), { recursive: true });
		writeFileSync(
			join(tempDir, ".interlinked", "config.json"),
			`${JSON.stringify(
				{
					version: 1,
					server_url: "https://old.example.com",
					default_project: "main",
				},
				null,
				4,
			)}\n`,
		);
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("keeps default_project while updating server_url", async () => {
		const { initConfig, readSharedConfig } = await import("../../lib/config.js");

		initConfig({ serverUrl: "https://new.example.com" }, tempDir);
		const shared = readSharedConfig(tempDir);
		expect(shared?.server_url).toBe("https://new.example.com");
		expect(shared?.default_project).toBe("main");
	});
});

// ===========================================
// Bug 14: doctor should signal failure via process exit code
// ===========================================

describe("Bug 14: doctor exit code behavior", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("sets process.exitCode when failures are present", async () => {
		const tempDir = join(tmpdir(), uniqueDirSuffix("cli-doctor-fail"));
		mkdirSync(tempDir, { recursive: true });
		// SPY, not process.chdir(): chdir THROWS in a worker thread
		// ("process.chdir() is not supported in workers"), and Stryker's vitest
		// runner pins its own pool, so a chdir here failed the mutation dry run
		// for every file whose graph-selected test scope included this one —
		// reported only as a generic "There were failed tests in the initial
		// test run" (measured 2026-08-04). doctorCommand reads `process.cwd()`
		// explicitly and threads it through, so the spy exercises the same path.
		const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tempDir);

		const previousExitCode = process.exitCode;
		process.exitCode = 0;
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			const { doctorCommand } = await import("../doctor.js");
			await doctorCommand({ json: true });
			expect(process.exitCode).toBe(1);
		} finally {
			cwdSpy.mockRestore();
			process.exitCode = previousExitCode;
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});

// ===========================================
// Bug 26: activity --limit should validate input
// ===========================================

describe("Bug 26: activity limit validation", () => {
	it("sets process.exitCode for invalid --limit", async () => {
		const previousExitCode = process.exitCode;
		process.exitCode = 0;
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			const { activityCommand } = await import("../activity.js");
			await activityCommand({ json: true, limit: "abc" });
			expect(process.exitCode).toBe(1);
		} finally {
			process.exitCode = previousExitCode;
			errorSpy.mockRestore();
		}
	});
});

// ===========================================
// Bug 21: truncate should preserve ANSI safety
// ===========================================

describe("Bug 21: truncate ANSI safety", () => {
	it("does not break colored output with partial escape sequences", async () => {
		const { truncate, stripAnsi } = await import("../../lib/formatter.js");
		const colored = "\u001b[32mhello world\u001b[0m";
		const out = truncate(colored, 6);
		expect(stripAnsi(out)).toBe("hello…");
		expect(out.includes("\u001b[0m")).toBe(true);
	});
});
