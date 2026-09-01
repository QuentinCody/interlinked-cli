import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { InstallResult } from "../lib/hook-types.js";
import type { ClientName } from "../lib/settings.js";

vi.mock("../lib/config.js", () => ({
	getConfigDir: vi.fn(),
	isConfigured: vi.fn(),
	readLocalConfig: vi.fn(),
}));
vi.mock("../lib/guard-state.js", () => ({ writeGuardDisable: vi.fn() }));
vi.mock("../lib/hooks.js", () => ({
	deleteConfigDir: vi.fn(),
	deleteHookScript: vi.fn(),
	uninstallAllHooks: vi.fn(),
}));
vi.mock("../lib/skill-installers.js", () => ({ uninstallSkills: vi.fn() }));
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

const CWD = "/mutation/project";
const CLIENTS: ClientName[] = [
	"claude",
	"copilot",
	"gemini",
	"codex",
	"cursor",
	"opencode",
	"opencode2",
	"pi",
];

function outputOf(spy: ReturnType<typeof vi.spyOn>): string {
	return stripAnsi((spy.mock.calls as unknown[][]).map((args) => args.join(" ")).join("\n"));
}

function hookResult(client: ClientName, events: string[] = [], error?: string): InstallResult {
	return { client, installed: false, events, ...(error === undefined ? {} : { error }) };
}

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	vi.clearAllMocks();
	process.exitCode = 0;
	logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(process, "cwd").mockReturnValue(CWD);
	vi.mocked(getConfigDir).mockReturnValue(`${CWD}/.interlinked`);
	vi.mocked(isConfigured).mockReturnValue(true);
	vi.mocked(readLocalConfig).mockReturnValue({ agent_name: "agent-from-config" } as never);
	vi.mocked(writeGuardDisable).mockReturnValue({
		disabled: true,
		scope: "project",
		by: "agent-from-config",
		at: "2026-08-20T00:00:00.000Z",
		version: 1,
		source: "local",
	} as never);
	vi.mocked(harnessStopCommand).mockResolvedValue(undefined);
	vi.mocked(isHarnessRunning).mockReturnValue({ running: false } as never);
	vi.mocked(uninstallAllHooks).mockReturnValue([]);
	vi.mocked(deleteHookScript).mockReturnValue(false);
	vi.mocked(deleteConfigDir).mockReturnValue(false);
	vi.mocked(uninstallSkills).mockReturnValue(false);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	process.exitCode = 0;
});

describe("disable stand-down mutation contracts", () => {
	// test-contract: public-api — the configured personal command writes the exact local marker and reports the repo-relative path.
	it("uses the personal marker name and exact recorded wording", async () => {
		await disableCommand({});
		const out = outputOf(logSpy);
		expect(out).toContain("Interlinked CLI — Disable (stand down)");
		expect(out).toContain("────────────────────────────────────────");
		expect(out).toContain("Stand-down recorded (personal).");
		expect(out).toContain("Marker:  .interlinked/guard-disabled.local.json");
		expect(out).toContain("Stood down — the harness will not guard this project.");
	});

	// test-contract: invariant — team scope changes both the persisted scope argument and the reviewable marker guidance.
	it("uses the team marker name and team wording only with --team", async () => {
		await disableCommand({ team: true });
		const out = outputOf(logSpy);
		expect(vi.mocked(writeGuardDisable)).toHaveBeenCalledWith(
			`${CWD}/.interlinked`,
			{ by: "agent-from-config" },
			true,
		);
		expect(out).toContain("Stand-down recorded (team).");
		expect(out).toContain("Marker:  .interlinked/guard-disabled.json");
		expect(out).toContain("Committed marker — it shows up in your PR diff");
		expect(out).not.toContain("(personal)");
	});

	// test-contract: boundary — absence of local config must safely fall through to USER rather than dereferencing undefined.
	it("resolves the actor from USER when local config is absent", async () => {
		vi.mocked(readLocalConfig).mockReturnValue(null);
		const oldUser = process.env.USER;
		process.env.USER = "shell-user";
		try {
			await disableCommand({});
		} finally {
			if (oldUser === undefined) delete process.env.USER;
			else process.env.USER = oldUser;
		}
		expect(vi.mocked(writeGuardDisable)).toHaveBeenCalledWith(
			`${CWD}/.interlinked`,
			{ by: "shell-user" },
			false,
		);
	});

	// test-contract: public-api — an explicit --by actor is authoritative over configured and environment identity.
	it("prefers the explicit actor flag", async () => {
		await disableCommand({ by: "flag-user" });
		expect(vi.mocked(writeGuardDisable)).toHaveBeenCalledWith(
			`${CWD}/.interlinked`,
			{ by: "flag-user" },
			false,
		);
	});

	// test-contract: boundary — optional reason and expiry fields must be omitted, not emitted as undefined, when absent.
	it("omits optional marker fields when options are absent", async () => {
		await disableCommand({});
		expect(vi.mocked(writeGuardDisable)).toHaveBeenCalledWith(
			`${CWD}/.interlinked`,
			{ by: "agent-from-config" },
			false,
		);
		const out = outputOf(logSpy);
		expect(out).not.toContain("Reason:");
		expect(out).not.toContain("Until:");
	});

	// test-contract: boundary — a collaborator record without an actor must render the documented unknown fallback.
	it("renders unknown when the marker record has no actor", async () => {
		vi.mocked(writeGuardDisable).mockReturnValue({
			disabled: true,
			scope: "project",
			at: "2026-08-20T00:00:00.000Z",
			version: 1,
			source: "local",
		} as never);
		await disableCommand({});
		expect(outputOf(logSpy)).toContain("By:      unknown");
	});

	// test-contract: invariant — provided reason and duration become auditable marker data and visible output.
	it("records and prints reason plus a future expiry", async () => {
		vi.setSystemTime(new Date("2026-08-20T12:00:00.000Z"));
		vi.mocked(writeGuardDisable).mockReturnValue({
			disabled: true,
			scope: "project",
			reason: "debug mode",
			by: "agent-from-config",
			expires_at: "2026-08-20T14:00:00.000Z",
			version: 1,
			source: "local",
		} as never);
		await disableCommand({ reason: "debug mode", until: "2h" });
		const out = outputOf(logSpy);
		expect(vi.mocked(writeGuardDisable)).toHaveBeenCalledWith(
			`${CWD}/.interlinked`,
			{ by: "agent-from-config", reason: "debug mode", expires_at: "2026-08-20T14:00:00.000Z" },
			false,
		);
		expect(out).toContain("Reason:  debug mode");
		expect(out).toContain("Until:   2026-08-20T14:00:00.000Z");
	});

	// test-contract: bug — expiry is calculated forward from now, never backward into the past.
	it("calculates the expiry boundary in the future", async () => {
		vi.setSystemTime(new Date("2026-08-20T12:00:00.000Z"));
		await disableCommand({ until: "1h" });
		const args = vi.mocked(writeGuardDisable).mock.calls[0]?.[1] as { expires_at?: string };
		expect(args.expires_at).toBe("2026-08-20T13:00:00.000Z");
		expect(Date.parse(args.expires_at ?? "")).toBeGreaterThan(Date.now());
	});

	// test-contract: security — malformed duration reports the exact operator guidance and prevents marker writes.
	it("reports invalid duration guidance and does not disable", async () => {
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("exit");
		}) as never);
		await expect(disableCommand({ until: "soon" })).rejects.toThrow("exit");
		const out = outputOf(logSpy);
		expect(out).toContain("Error: Invalid duration \"soon\". Expected format like 30m, 1h, 15s, or 2d.");
		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(vi.mocked(writeGuardDisable)).not.toHaveBeenCalled();
	});

	// test-contract: public-api — a live daemon means the marker is recorded but success must not be claimed.
	it("reports the exact incomplete-stand-down guidance when daemon survives", async () => {
		vi.mocked(isHarnessRunning).mockReturnValue({ running: true, pid: 42 } as never);
		await disableCommand({});
		const out = outputOf(logSpy);
		expect(process.exitCode).toBe(1);
		expect(out).toContain("Not fully stood down.");
		expect(out).toContain("guarding this project — the live daemon does not read the stand-down marker.");
		expect(out).toContain("Finish the stand-down by stopping it: interlinked harness stop");
		expect(out).not.toContain("Stood down — the harness will not guard this project.");
	});

	// test-contract: public-api — an already-disabled project gives actionable guidance without marker or daemon side effects.
	it("handles an already-disabled project with exact re-enable guidance", async () => {
		vi.mocked(isConfigured).mockReturnValue(false);
		await disableCommand({});
		const out = outputOf(logSpy);
		expect(out).toContain("Not enabled here. No .interlinked/ config found.");
		expect(out).toContain("Run `interlinked enable` first, or `interlinked disable --uninstall` to remove stray hooks.");
		expect(vi.mocked(writeGuardDisable)).not.toHaveBeenCalled();
		expect(vi.mocked(harnessStopCommand)).not.toHaveBeenCalled();
	});
});

describe("disable uninstall mutation contracts", () => {
	// test-contract: public-api — uninstall always evaluates all supported clients and distinguishes removed, failed, and absent hooks.
	it("renders every hook-result branch and counts only removed clients", async () => {
		vi.mocked(uninstallAllHooks).mockReturnValue([
			hookResult("claude", ["PreToolUse", "PostToolUse"]),
			hookResult("copilot", [], "permission denied"),
			hookResult("gemini"),
		]);
		await disableCommand({ uninstall: true });
		const out = outputOf(logSpy);
		expect(vi.mocked(uninstallAllHooks)).toHaveBeenCalledWith(CWD, CLIENTS);
		expect(out).toContain("claude — removed 2 hook event(s)");
		expect(out).toContain("copilot — permission denied");
		expect(out).toContain("gemini — no hooks found");
		expect(out).toContain("Done. Removed hooks from 1 client(s).");
	});

	// test-contract: boundary — missing configuration is not a blocker for destructive cleanup and must print the stray-hook guidance.
	it("checks stray hooks when already disabled", async () => {
		vi.mocked(isConfigured).mockReturnValue(false);
		await disableCommand({ uninstall: true });
		const out = outputOf(logSpy);
		expect(out).toContain("Not enabled. No .interlinked/ config found.");
		expect(out).toContain("Checking for hooks to remove anyway");
		expect(vi.mocked(uninstallAllHooks)).toHaveBeenCalledWith(CWD, CLIENTS);
	});

	// test-contract: invariant — a removed hook script and skills are reported, while keep-config suppresses config deletion and gives re-install guidance.
	it("preserves config with --keep-config while reporting removals", async () => {
		vi.mocked(deleteHookScript).mockReturnValue(true);
		vi.mocked(uninstallSkills).mockReturnValue(true);
		await disableCommand({ uninstall: true, keepConfig: true });
		const out = outputOf(logSpy);
		expect(out).toContain("Deleted hook script");
		expect(out).toContain("Removed Interlinked skills from claude, copilot, gemini, codex, cursor");
		expect(out).toContain("Kept .interlinked/ config (--keep-config)");
		expect(out).toContain("Config preserved. Run 'interlinked enable' to re-install hooks.");
		expect(vi.mocked(deleteConfigDir)).not.toHaveBeenCalled();
	});

	// test-contract: public-api — default uninstall deletes config and uses the exact no-op summary and re-enable instruction when nothing changes.
	it("deletes config and reports a no-op uninstall", async () => {
		vi.mocked(deleteConfigDir).mockReturnValue(true);
		await disableCommand({ uninstall: true });
		const out = outputOf(logSpy);
		expect(out).toContain("Deleted .interlinked/");
		expect(out).toContain("Done. No hooks were found to remove.");
		expect(out).toContain("Agent activity will no longer be captured.");
		expect(out).toContain("Run 'interlinked enable' to re-enable.");
	});
});
