// ===========================================
// disable command — behavioral coverage
// ===========================================
// Two modes:
//   - default      → soft, recorded stand-down (writes a marker + stops the
//                    daemon; hooks/config stay).
//   - --uninstall  → the destructive teardown (remove hooks, delete config).
//
// All module boundaries are mocked so the test asserts real output strings and
// side-effect calls without touching the filesystem, the daemon socket, or the
// guard-state marker files. The formatter is left real and ANSI is stripped at
// read time.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { InstallResult } from "../lib/hook-types.js";
import type { ClientName } from "../lib/settings.js";

// --- module boundary mocks ------------------------------------------------

vi.mock("../lib/config.js", () => ({
	getConfigDir: vi.fn(),
	isConfigured: vi.fn(),
	readLocalConfig: vi.fn(),
}));

vi.mock("../lib/hooks.js", () => ({
	deleteConfigDir: vi.fn(),
	deleteHookScript: vi.fn(),
	uninstallAllHooks: vi.fn(),
}));

vi.mock("../lib/skill-installers.js", () => ({
	uninstallSkills: vi.fn(),
}));

vi.mock("../lib/guard-state.js", () => ({
	writeGuardDisable: vi.fn(),
}));

vi.mock("./harness.js", () => ({
	harnessStopCommand: vi.fn(),
	isHarnessRunning: vi.fn(),
}));

import { getConfigDir, isConfigured, readLocalConfig } from "../lib/config.js";
import { stripAnsi } from "../lib/formatter.js";
import { writeGuardDisable } from "../lib/guard-state.js";
import { deleteConfigDir, deleteHookScript, uninstallAllHooks } from "../lib/hooks.js";
import { uninstallSkills } from "../lib/skill-installers.js";
import { disableCommand } from "./disable.js";
import { harnessStopCommand, isHarnessRunning } from "./harness.js";

// --- helpers --------------------------------------------------------------

const CWD = "/fake/project";

function result(client: ClientName, over: Partial<InstallResult> = {}): InstallResult {
	return { client, installed: false, events: [], ...over };
}

function logged(spy: ReturnType<typeof vi.spyOn>): string {
	const calls = spy.mock.calls as unknown[][];
	return stripAnsi(calls.map((args) => args.join(" ")).join("\n"));
}

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	vi.clearAllMocks();
	logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(process, "cwd").mockReturnValue(CWD);

	vi.mocked(getConfigDir).mockReturnValue(`${CWD}/.interlinked`);
	vi.mocked(isConfigured).mockReturnValue(true);
	vi.mocked(readLocalConfig).mockReturnValue({ agent_name: "qcody" } as never);
	vi.mocked(uninstallAllHooks).mockReturnValue([]);
	vi.mocked(deleteHookScript).mockReturnValue(false);
	vi.mocked(deleteConfigDir).mockReturnValue(false);
	vi.mocked(uninstallSkills).mockReturnValue(false);
	vi.mocked(writeGuardDisable).mockReturnValue({
		disabled: true,
		scope: "project",
		by: "qcody",
		at: "2026-06-14T00:00:00.000Z",
		version: 1,
		source: "local",
	} as never);
	vi.mocked(harnessStopCommand).mockResolvedValue(undefined);
	// Default: the daemon stopped cleanly, so a stand-down is fully in effect.
	vi.mocked(isHarnessRunning).mockReturnValue({ running: false } as never);
});

afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = 0; // standDown sets a non-zero exit when the daemon survives
});

const ALL_CLIENTS: ClientName[] = [
	"claude",
	"copilot",
	"gemini",
	"codex",
	"cursor",
	"opencode",
	"opencode2",
	"pi",
];

// --------------------------------------------------------------------------

describe("disableCommand — stand down (default)", () => {
	it("writes a personal marker and stops the daemon, leaving hooks in place", async () => {
		await disableCommand({});

		const out = logged(logSpy);
		expect(out).toContain("Disable (stand down)");
		expect(out).toContain("Stood down");
		expect(vi.mocked(writeGuardDisable)).toHaveBeenCalledWith(
			`${CWD}/.interlinked`,
			expect.objectContaining({ by: "qcody" }),
			false,
		);
		expect(vi.mocked(harnessStopCommand)).toHaveBeenCalledOnce();
		expect(vi.mocked(uninstallAllHooks)).not.toHaveBeenCalled();
		expect(vi.mocked(deleteConfigDir)).not.toHaveBeenCalled();
	});

	it("does NOT claim success when the daemon survives the stop (still guarding)", async () => {
		// The live daemon ignores the marker; if it survived SIGTERM the project is
		// still guarded, so the command must warn + exit non-zero rather than report
		// a successful stand-down (finding 2026-06, round 8).
		vi.mocked(isHarnessRunning).mockReturnValue({ running: true, pid: 999 } as never);

		await disableCommand({});

		const out = logged(logSpy);
		expect(out).toContain("Not fully stood down");
		expect(out).toContain("interlinked harness stop");
		expect(out).not.toContain("will not guard"); // the success claim is withheld
		expect(process.exitCode).toBe(1);
		// The marker is still RECORDED (the consent) — it just is not yet in effect.
		expect(vi.mocked(writeGuardDisable)).toHaveBeenCalledOnce();
	});

	it("writes a committed team marker with --team and says it shows in the diff", async () => {
		await disableCommand({ team: true });

		const out = logged(logSpy);
		expect(vi.mocked(writeGuardDisable)).toHaveBeenCalledWith(
			`${CWD}/.interlinked`,
			expect.objectContaining({ by: "qcody" }),
			true,
		);
		expect(out).toContain("PR diff");
	});

	it("records a --reason on the marker", async () => {
		await disableCommand({ reason: "debugging flaky harness test" });
		expect(vi.mocked(writeGuardDisable)).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({ reason: "debugging flaky harness test" }),
			false,
		);
	});

	it("derives an expiry from --until", async () => {
		await disableCommand({ until: "2h" });
		expect(vi.mocked(writeGuardDisable)).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({ expires_at: expect.any(String) }),
			false,
		);
	});

	it("exits on an unparseable --until", async () => {
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("exit");
		}) as never);
		await expect(disableCommand({ until: "soon" })).rejects.toThrow("exit");
		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(vi.mocked(writeGuardDisable)).not.toHaveBeenCalled();
	});

	it("prefers --by over the configured agent name", async () => {
		await disableCommand({ by: "alice" });
		expect(vi.mocked(writeGuardDisable)).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({ by: "alice" }),
			false,
		);
	});

	it("refuses (no marker) when the project is not configured", async () => {
		vi.mocked(isConfigured).mockReturnValue(false);
		await disableCommand({});
		const out = logged(logSpy);
		expect(out).toContain("Not enabled here");
		expect(vi.mocked(writeGuardDisable)).not.toHaveBeenCalled();
		expect(vi.mocked(harnessStopCommand)).not.toHaveBeenCalled();
	});
});

describe("disableCommand — uninstall", () => {
	it("prints the uninstall banner and tears down hooks for every client", async () => {
		await disableCommand({ uninstall: true });

		const out = logged(logSpy);
		expect(out).toContain("Disable (uninstall)");
		expect(out).toContain("Removing hooks:");
		expect(vi.mocked(uninstallAllHooks)).toHaveBeenCalledWith(CWD, ALL_CLIENTS);
		expect(vi.mocked(uninstallSkills)).toHaveBeenCalledWith(CWD, ALL_CLIENTS);
		expect(vi.mocked(writeGuardDisable)).not.toHaveBeenCalled();
	});

	it("renders a removed line per client and counts the summary", async () => {
		vi.mocked(uninstallAllHooks).mockReturnValue([
			result("claude", { events: ["PreToolUse", "PostToolUse"] }),
			result("codex", { events: ["PreToolUse"] }),
		]);

		await disableCommand({ uninstall: true });

		const out = logged(logSpy);
		expect(out).toContain("claude — removed 2 hook event(s)");
		expect(out).toContain("codex — removed 1 hook event(s)");
		expect(out).toContain("Removed hooks from 2 client(s).");
	});

	it("renders error and no-hooks lines and the no-op summary", async () => {
		vi.mocked(uninstallAllHooks).mockReturnValue([
			result("gemini", { error: "permission denied" }),
			result("cursor"),
		]);

		await disableCommand({ uninstall: true });

		const out = logged(logSpy);
		expect(out).toContain("gemini — permission denied");
		expect(out).toContain("cursor — no hooks found");
		expect(out).toContain("No hooks were found to remove.");
	});

	it("announces script + skill removal when they changed", async () => {
		vi.mocked(deleteHookScript).mockReturnValue(true);
		vi.mocked(uninstallSkills).mockReturnValue(true);

		await disableCommand({ uninstall: true });

		const out = logged(logSpy);
		expect(out).toContain("Deleted hook script");
		expect(out).toContain("Removed Interlinked skills from");
	});

	it("deletes the config dir by default and prints a repo-relative path", async () => {
		vi.mocked(deleteConfigDir).mockReturnValue(true);

		await disableCommand({ uninstall: true });

		const out = logged(logSpy);
		expect(vi.mocked(deleteConfigDir)).toHaveBeenCalledWith(CWD);
		expect(out).toContain("Deleted .interlinked/");
		expect(out).not.toContain("Kept");
	});

	it("keeps the config dir with --keep-config", async () => {
		await disableCommand({ uninstall: true, keepConfig: true });

		const out = logged(logSpy);
		expect(vi.mocked(deleteConfigDir)).not.toHaveBeenCalled();
		expect(out).toContain("Kept");
		expect(out).toContain("Config preserved. Run 'interlinked enable' to re-install hooks.");
	});
});
