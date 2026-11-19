import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerCheckpointCommands } from "./checkpoints.js";

const effects = vi.hoisted(() => ({ execFileSync: vi.fn(), execSync: vi.fn(), callTool: vi.fn(), head: "a".repeat(40) }));
vi.mock("node:child_process", () => ({ execFileSync: effects.execFileSync, execSync: effects.execSync }));
vi.mock("../lib/api-client.js", () => ({ getClient: () => ({ callTool: effects.callTool }) }));
vi.mock("../lib/git-utils.js", () => ({
	isGitRepo: () => true,
	getCurrentBranch: () => "fixture",
	getHeadSha: () => "a".repeat(40),
	getCommitMessage: () => "fixture message",
	parseInterlinkedTrailers: () => ({}),
}));

let logs: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
	vi.clearAllMocks();
	process.exitCode = 0;
	logs = vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	effects.head = "a".repeat(40);
	effects.callTool.mockResolvedValue({ checkpoint_id: 7, trailers: ["Interlinked-Checkpoint: 7"], notes_json: "{}" });
	effects.execFileSync.mockImplementation((_command: string, args: string[]) => {
		if (args[0] === "rev-parse") {
			const ref = args.at(-1)?.replace(/\^\{commit\}$/, "");
			if (ref === "HEAD") return effects.head;
			if (ref === "refs/heads/fixture" || ref === "a".repeat(40)) return "a".repeat(40);
			if (ref === "d".repeat(64)) return ref;
			if (ref === "other") return "c".repeat(40);
			throw new Error("fixture ref unavailable");
		}
		if (args[0] === "commit") effects.head = "b".repeat(effects.head.length);
		return "";
	});
});
afterEach(() => { vi.restoreAllMocks(); process.exitCode = 0; });

async function run(ref?: string, checkpoint = "7"): Promise<Record<string, unknown>> {
	const program = new Command().exitOverride();
	registerCheckpointCommands(program);
	const selection = ref === undefined ? [] : ["--commit", ref];
	await program.parseAsync(["git", "link-checkpoint", "--checkpoint", checkpoint, ...selection, "--apply", "--json"], { from: "user" });
	return JSON.parse(String(logs.mock.calls.at(-1)?.[0] ?? "{}"));
}

describe("registered Git apply object and subprocess contracts", () => {
	it.each(["7junk", "7.5", "", "-1", "0", "9007199254740992"])("rejects explicit malformed checkpoint ID %j before server work", async (checkpoint) => {
		await run(undefined, checkpoint);
		expect(process.exitCode).toBe(1);
		expect(effects.callTool).not.toHaveBeenCalled();
	});
	it.each([undefined, "HEAD", "refs/heads/fixture", "a".repeat(40)])("resolves %j and uses literal argv for mutations", async (ref) => {
		const result = await run(ref);
		expect(result).toMatchObject({ applied: true, commit_sha: "b".repeat(40) });
		expect(effects.execFileSync).toHaveBeenCalledWith("git", ["notes", "add", "-f", "-F", "-", "b".repeat(40)], expect.objectContaining({ input: "{}" }));
		expect(effects.execSync).not.toHaveBeenCalled();
	});

	it.each(["audit.invalid;metadata", "", "other"])("fails selected object %j before mutation", async (ref) => {
		await run(ref);
		expect(process.exitCode).toBe(1);
		expect(effects.callTool).not.toHaveBeenCalled();
		expect(effects.execSync).not.toHaveBeenCalled();
		expect(effects.execFileSync.mock.calls.some((call: unknown[]) => ["commit", "notes"].includes(String((call[1] as string[])[0])))).toBe(false);
	});

	it("supports SHA-256 commit identities", async () => {
		effects.head = "d".repeat(64);
		const result = await run(effects.head);
		expect(result).toMatchObject({ applied: true, commit_sha: "b".repeat(64) });
	});

	it("fails before mutation when required message discovery fails", async () => {
		const ordinary = effects.execFileSync.getMockImplementation();
		effects.execFileSync.mockImplementation((command: string, args: string[]) => {
			if (args[0] === "log") throw new Error("fixture message unavailable");
			return ordinary?.(command, args);
		});
		const result = await run();
		expect(result).toMatchObject({ applied: false, apply_error: "fixture message unavailable" });
		expect(effects.head).toBe("a".repeat(40));
		expect(process.exitCode).toBe(1);
	});

	it("reports a failed notes write with the post-amend identity and failing exit", async () => {
		const ordinary = effects.execFileSync.getMockImplementation();
		effects.execFileSync.mockImplementation((command: string, args: string[]) => {
			if (args[0] === "notes") throw new Error("fixture notes refused");
			return ordinary?.(command, args);
		});
		const result = await run();
		expect(result).toMatchObject({ applied: false, commit_sha: "b".repeat(40), apply_error: "fixture notes refused" });
		expect(process.exitCode).toBe(1);
	});
});
