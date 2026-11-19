import { Command } from "commander";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const effects = vi.hoisted(() => ({ execFileSync: vi.fn(), writeDecision: vi.fn() }));
vi.mock("node:child_process", () => ({ execFileSync: effects.execFileSync }));
vi.mock("../harness/sponsor/feed-client.js", async (importOriginal) => ({
	...await importOriginal<typeof import("../harness/sponsor/feed-client.js")>(),
	fetchFeedWire: vi.fn(async () => ({})),
	verifyWire: vi.fn(() => ({})),
	selectCreative: vi.fn(() => ({ text: "fixture creative" })),
}));
vi.mock("../lib/sponsor-spinner.js", () => ({
	addSponsorSpinnerVerb: () => ({ ok: true, written: "fixture sponsored verb" }),
	removeSponsorSpinnerVerbs: () => ({ ok: true }),
}));
vi.mock("../harness/content-scanner/review-files.js", () => ({
	listPendingReviews: () => [{ key: "fixture-newest" }],
	readReview: () => ({ url: "https://fixture.invalid/", findings: [] }),
	writeDecision: effects.writeDecision,
}));
import { registerCiCommand } from "../commands/ci-status.js";
import { registerSponsorCommands } from "./sponsor.js";
import { registerHarnessCommands } from "./harness.js";

let logs: ReturnType<typeof vi.spyOn>;
const roots: string[] = [];
beforeEach(() => {
	vi.clearAllMocks();
	logs = vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	process.exitCode = 0;
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	process.exitCode = 0;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function rendered(): string {
	return logs.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
}

function fixture(): string {
	const root = mkdtempSync(join(tmpdir(), "operations-next-probe-"));
	roots.push(root);
	mkdirSync(join(root, ".interlinked"));
	vi.spyOn(process, "cwd").mockReturnValue(root);
	vi.stubEnv("INTERLINKED_HOME", join(root, ".interlinked"));
	return root;
}

describe("registered local operation failure contracts with isolated effects", () => {
	it("reports failed CI collection as unavailable with a failing exit", async () => {
		effects.execFileSync.mockImplementation((_command: string, args: string[]) => {
			if (args[0] === "--version") return "gh fixture";
			throw new Error("fixture gh authentication failed");
		});
		const program = new Command().exitOverride();
		registerCiCommand(program);
		await program.parseAsync(["ci-status", "--json"], { from: "user" });
		expect(rendered()).toBe("");
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("fixture gh authentication failed"));
		expect(process.exitCode).toBe(1);
	});

	it.each(["garbage", "1junk", "1.5", "", "9007199254740992"])("rejects invalid CI limit %j before invoking gh", async (limit) => {
		effects.execFileSync.mockImplementation((_command: string, args: string[]) => args[0] === "--version" ? "gh fixture" : "[]");
		const program = new Command().exitOverride();
		registerCiCommand(program);
		await expect(program.parseAsync(["ci-status", "--limit", limit, "--json"], { from: "user" })).rejects.toMatchObject({ code: "commander.invalidArgument" });
		expect(effects.execFileSync).not.toHaveBeenCalled();
	});

	it("emits one JSON document when sponsor spinner installation succeeds", async () => {
		fixture();
		const program = new Command().exitOverride();
		registerSponsorCommands(program);
		await program.parseAsync(["sponsor", "enable", "--spinner", "--json"], { from: "user" });
		expect(JSON.parse(rendered())).toMatchObject({ enabled: true });
		expect(logs).toHaveBeenCalledTimes(1);
	});

	it("retains successful empty CI collection and documented limit clamping", async () => {
		effects.execFileSync.mockImplementation((_command: string, args: string[]) => args[0] === "--version" ? "gh fixture" : "[]");
		for (const [supplied, expected] of [["-5", "1"], ["0", "1"], ["101", "100"], ["12", "12"]]) {
			logs.mockClear();
			const program = new Command().exitOverride();
			registerCiCommand(program);
			await program.parseAsync(["ci-status", "--limit", supplied ?? "", "--json"], { from: "user" });
			expect(effects.execFileSync).toHaveBeenLastCalledWith("gh", expect.arrayContaining(["--limit", expected]), expect.any(Object));
			expect(JSON.parse(rendered())).toMatchObject({ total: 0, completed: 0 });
		}
	});

	it("retains omitted scanner review-key selection", async () => {
		fixture();
		const program = new Command().exitOverride();
		registerHarnessCommands(program);
		await program.parseAsync(["scanner", "review", "--allow", "--json"], { from: "user" });
		expect(effects.writeDecision).toHaveBeenCalledWith(expect.objectContaining({ key: "fixture-newest", decision: "allow" }));
	});

	it.each(["{\"protected_file_rules\": [fixture unfinished policy", "[]", "null"])("preserves malformed scanner policy %j and fails before mutation", async (original) => {
		const root = fixture();
		const path = join(root, ".interlinked", "guard-rules.local.json");
		writeFileSync(path, original);
		const program = new Command().exitOverride();
		registerHarnessCommands(program);
		await program.parseAsync(["scanner", "on", "--json"], { from: "user" });
		expect(readFileSync(path, "utf8")).toBe(original);
		expect(process.exitCode).toBe(1);
		expect(console.error).toHaveBeenCalled();
	});

	it.each(["", "   "])("rejects explicit blank scanner review key %j before writing a decision", async (key) => {
		fixture();
		const program = new Command().exitOverride();
		registerHarnessCommands(program);
		await program.parseAsync(["scanner", "review", "--key", key, "--allow", "--json"], { from: "user" });
		expect(effects.writeDecision).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
	});
});
