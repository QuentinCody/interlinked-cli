import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../lib/non-null.js";

const mocks = vi.hoisted(() => ({
	addAllowlistCommand: vi.fn<typeof import("../commands/allowlist.js").addAllowlistCommand>(),
	removeAllowlistCommand: vi.fn<typeof import("../commands/allowlist.js").removeAllowlistCommand>(),
	listAllowlistCommand: vi.fn<typeof import("../commands/allowlist.js").listAllowlistCommand>(),
	snapshotAllowlistCommand: vi.fn<typeof import("../commands/allowlist.js").snapshotAllowlistCommand>(),
	verifyAllowlistCommand: vi.fn<typeof import("../commands/allowlist.js").verifyAllowlistCommand>(),
}));

vi.mock("../commands/allowlist.js", () => mocks);

import { registerSupplyChainCommands } from "./supply-chain.js";

function buildProgram(): Command {
	const program = new Command();
	program.exitOverride();
	registerSupplyChainCommands(program);
	return program;
}

function getSub(program: Command, name: string) {
	const al = program.commands.find((c) => c.name() === "allowlist");
	if (!al) throw new Error("allowlist command not registered");
	const sub = al.commands.find((c) => c.name() === name);
	if (!sub) throw new Error(`allowlist ${name} not registered`);
	return sub;
}

function optionDesc(cmd: ReturnType<typeof getSub>, flag: string): string {
	const opt = cmd.options.find((o) => o.long === flag);
	if (!opt) throw new Error(`option ${flag} not found`);
	return opt.description;
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("supply-chain registrar — string literal descriptions (must not be empty)", () => {
	it("add command description is non-empty and mentions ecosystems", () => {
		const program = buildProgram();
		const add = getSub(program, "add");
		expect(add.description()).toBe(
			"Approve a registry package (ecosystem: npm | pypi | cargo | rubygems | go)",
		);
		expect(add.description().length).toBeGreaterThan(0);
	});

	it("add command option descriptions are non-empty", () => {
		const program = buildProgram();
		const add = getSub(program, "add");
		expect(optionDesc(add, "--by")).toBe("Approver name (required)");
		expect(optionDesc(add, "--reason")).toBe("Why this package is approved");
		expect(optionDesc(add, "--version-range")).toBe(
			"Optional semver/PEP-440 range constraint",
		);
		expect(optionDesc(add, "--force")).toBe(
			"Override the admission screens (typosquat refusal, non-allowlisted license, open OSV advisories)",
		);
		expect(optionDesc(add, "--cwd")).toBe("Project root (default: current directory)");
	});

	it("remove command description and --cwd option are non-empty", () => {
		const program = buildProgram();
		const remove = getSub(program, "remove");
		expect(remove.description()).toBe("Un-approve a previously-approved package");
		expect(optionDesc(remove, "--cwd")).toBe("Project root");
	});

	it("list command description and options are non-empty", () => {
		const program = buildProgram();
		const list = getSub(program, "list");
		expect(list.description()).toBe("Show approved packages and snapshots");
		expect(optionDesc(list, "--ecosystem")).toBe("Filter by ecosystem");
		expect(optionDesc(list, "--json")).toBe("Machine-readable output");
		expect(optionDesc(list, "--cwd")).toBe("Project root");
	});

	it("snapshot command description and options are non-empty", () => {
		const program = buildProgram();
		const snapshot = getSub(program, "snapshot");
		expect(snapshot.description()).toBe(
			"Hash current manifest+lockfile state, store as an approved snapshot",
		);
		expect(optionDesc(snapshot, "--by")).toBe("Approver name (required)");
		expect(optionDesc(snapshot, "--reason")).toBe("Why this state is approved");
		expect(optionDesc(snapshot, "--lockfile")).toBe(
			"Snapshot a specific file only (e.g. package-lock.json)",
		);
		expect(optionDesc(snapshot, "--cwd")).toBe("Project root");
	});

	it("verify command description and --cwd option are non-empty", () => {
		const program = buildProgram();
		const verify = getSub(program, "verify");
		expect(verify.description()).toBe("Show manifest deps not on the allowlist");
		expect(optionDesc(verify, "--cwd")).toBe("Project root");
	});
});

describe("supply-chain registrar — conditional spread of optional opts (add)", () => {
	it("omits reason/versionRange/force keys entirely when flags are absent", async () => {
		const program = buildProgram();
		await program.parseAsync(
			["node", "test", "allowlist", "add", "npm", "lodash", "--by", "tester"],
			{ from: "node" },
		);
		expect(mocks.addAllowlistCommand).toHaveBeenCalledTimes(1);
		const passedOpts = nonNull(nonNull(mocks.addAllowlistCommand.mock.calls[0])[2]);
		expect(Object.prototype.hasOwnProperty.call(passedOpts, "reason")).toBe(false);
		expect(Object.prototype.hasOwnProperty.call(passedOpts, "versionRange")).toBe(false);
		expect(Object.prototype.hasOwnProperty.call(passedOpts, "force")).toBe(false);
	});

	it("includes reason/versionRange/force keys when flags are present", async () => {
		const program = buildProgram();
		await program.parseAsync(
			[
				"node",
				"test",
				"allowlist",
				"add",
				"npm",
				"lodash",
				"--by",
				"tester",
				"--reason",
				"utility",
				"--version-range",
				"^4.0.0",
				"--force",
			],
			{ from: "node" },
		);
		const passedOpts = nonNull(nonNull(mocks.addAllowlistCommand.mock.calls[0])[2]);
		expect(passedOpts.reason).toBe("utility");
		expect(passedOpts.versionRange).toBe("^4.0.0");
		expect(passedOpts.force).toBe(true);
	});
});

describe("supply-chain registrar — conditional spread of optional opts (list)", () => {
	it("omits ecosystem/json keys entirely when flags are absent", async () => {
		const program = buildProgram();
		await program.parseAsync(["node", "test", "allowlist", "list"], { from: "node" });
		expect(mocks.listAllowlistCommand).toHaveBeenCalledTimes(1);
		const passedOpts = nonNull(nonNull(mocks.listAllowlistCommand.mock.calls[0])[0]);
		expect(Object.prototype.hasOwnProperty.call(passedOpts, "ecosystem")).toBe(false);
		expect(Object.prototype.hasOwnProperty.call(passedOpts, "json")).toBe(false);
	});

	it("includes ecosystem/json keys when flags are present", async () => {
		const program = buildProgram();
		await program.parseAsync(
			["node", "test", "allowlist", "list", "--ecosystem", "npm", "--json"],
			{ from: "node" },
		);
		const passedOpts = nonNull(nonNull(mocks.listAllowlistCommand.mock.calls[0])[0]);
		expect(passedOpts.ecosystem).toBe("npm");
		expect(passedOpts.json).toBe(true);
	});
});

describe("supply-chain registrar — conditional spread of optional opts (snapshot)", () => {
	it("omits reason/lockfile keys entirely when flags are absent", async () => {
		const program = buildProgram();
		await program.parseAsync(["node", "test", "allowlist", "snapshot", "--by", "tester"], {
			from: "node",
		});
		expect(mocks.snapshotAllowlistCommand).toHaveBeenCalledTimes(1);
		const passedOpts = nonNull(nonNull(mocks.snapshotAllowlistCommand.mock.calls[0])[0]);
		expect(Object.prototype.hasOwnProperty.call(passedOpts, "reason")).toBe(false);
		expect(Object.prototype.hasOwnProperty.call(passedOpts, "lockfile")).toBe(false);
	});

	it("includes reason/lockfile keys when flags are present", async () => {
		const program = buildProgram();
		await program.parseAsync(
			[
				"node",
				"test",
				"allowlist",
				"snapshot",
				"--by",
				"tester",
				"--reason",
				"state approved",
				"--lockfile",
				"package-lock.json",
			],
			{ from: "node" },
		);
		const passedOpts = nonNull(nonNull(mocks.snapshotAllowlistCommand.mock.calls[0])[0]);
		expect(passedOpts.reason).toBe("state approved");
		expect(passedOpts.lockfile).toBe("package-lock.json");
	});
});
