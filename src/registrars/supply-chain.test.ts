import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerSupplyChainCommands } from "./supply-chain.js";

// Mock the lazy-imported command implementations so the .action bodies are
// exercised end-to-end without touching the real filesystem/allowlist.
const addAllowlistCommand = vi.fn();
const removeAllowlistCommand = vi.fn();
const listAllowlistCommand = vi.fn();
const snapshotAllowlistCommand = vi.fn();
const verifyAllowlistCommand = vi.fn();

vi.mock("../commands/allowlist.js", () => ({
	addAllowlistCommand: (...args: unknown[]) => addAllowlistCommand(...args),
	removeAllowlistCommand: (...args: unknown[]) => removeAllowlistCommand(...args),
	listAllowlistCommand: (...args: unknown[]) => listAllowlistCommand(...args),
	snapshotAllowlistCommand: (...args: unknown[]) => snapshotAllowlistCommand(...args),
	verifyAllowlistCommand: (...args: unknown[]) => verifyAllowlistCommand(...args),
}));

function build(): Command {
	const program = new Command();
	program.exitOverride(); // make commander throw instead of process.exit on parse errors
	registerSupplyChainCommands(program);
	return program;
}

// process.exit throws so the action stops (mirrors real abort) and we can assert the code.
class ExitError extends Error {
	constructor(public code: number) {
		super(`exit:${code}`);
	}
}

let exitSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	vi.clearAllMocks();
	exitSpy = vi
		.spyOn(process, "exit")
		.mockImplementation((code) => {
			throw new ExitError(Number(code ?? 0));
		});
	stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
	exitSpy.mockRestore();
	stderrSpy.mockRestore();
});

describe("registerSupplyChainCommands — structure", () => {
	it("registers the allowlist command group with a description", () => {
		const program = build();
		const allowlist = program.commands.find((c) => c.name() === "allowlist");
		expect(allowlist).toBeDefined();
		expect(allowlist?.description()).toContain("package-allowlist.json");
	});

	it("registers all allowlist subcommands", () => {
		const program = build();
		const allowlist = program.commands.find((c) => c.name() === "allowlist");
		if (!allowlist) throw new Error("allowlist not registered");
		expect(allowlist.commands.map((c) => c.name()).sort()).toEqual(
			["add", "list", "remove", "snapshot", "verify"].sort(),
		);
	});

	it("wires the documented options on each subcommand", () => {
		const program = build();
		const allowlist = program.commands.find((c) => c.name() === "allowlist");
		if (!allowlist) throw new Error("allowlist not registered");
		const optsFor = (name: string) =>
			allowlist.commands
				.find((c) => c.name() === name)
				?.options.map((o) => o.long)
				.sort();
		expect(optsFor("add")).toEqual(
			["--by", "--cwd", "--force", "--reason", "--version-range"].sort(),
		);
		expect(optsFor("remove")).toEqual(["--cwd"]);
		expect(optsFor("list")).toEqual(["--cwd", "--ecosystem", "--json"].sort());
		expect(optsFor("snapshot")).toEqual(["--by", "--cwd", "--lockfile", "--reason"].sort());
		expect(optsFor("verify")).toEqual(["--cwd"]);
	});
});

describe("allowlist add — action wiring", () => {
	it("forwards all options to addAllowlistCommand", async () => {
		const program = build();
		await program.parseAsync(
			[
				"allowlist",
				"add",
				"npm",
				"lodash",
				"--by",
				"qcody",
				"--reason",
				"utility",
				"--version-range",
				"^4.0.0",
				"--force",
				"--cwd",
				"/proj",
			],
			{ from: "user" },
		);
		expect(addAllowlistCommand).toHaveBeenCalledWith("npm", "lodash", {
			cwd: "/proj",
			by: "qcody",
			reason: "utility",
			versionRange: "^4.0.0",
			force: true,
		});
	});

	it("defaults cwd to process.cwd() and omits absent optionals", async () => {
		const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/here");
		try {
			const program = build();
			await program.parseAsync(["allowlist", "add", "pypi", "requests", "--by", "me"], {
				from: "user",
			});
		} finally {
			cwdSpy.mockRestore();
		}
		expect(addAllowlistCommand).toHaveBeenCalledWith("pypi", "requests", {
			cwd: "/here",
			by: "me",
		});
	});

	it("exits 2 when --by is missing and never calls the impl", async () => {
		const program = build();
		await expect(
			program.parseAsync(["allowlist", "add", "npm", "lodash"], { from: "user" }),
		).rejects.toThrow(ExitError);
		expect(stderrSpy).toHaveBeenCalledWith("error: --by <name> is required\n");
		expect(addAllowlistCommand).not.toHaveBeenCalled();
	});

	it("catches Error thrown by the impl and exits 2 with the message", async () => {
		addAllowlistCommand.mockImplementationOnce(() => {
			throw new Error("typosquat refused");
		});
		const program = build();
		await expect(
			program.parseAsync(["allowlist", "add", "npm", "lodahs", "--by", "me"], {
				from: "user",
			}),
		).rejects.toThrow(ExitError);
		expect(stderrSpy).toHaveBeenCalledWith("error: typosquat refused\n");
	});

	it("stringifies non-Error throws in the catch branch", async () => {
		addAllowlistCommand.mockImplementationOnce(() => {
			// eslint-disable-next-line @typescript-eslint/no-throw-literal -- exercising non-Error branch
			throw "boom";
		});
		const program = build();
		await expect(
			program.parseAsync(["allowlist", "add", "npm", "x", "--by", "me"], { from: "user" }),
		).rejects.toThrow(ExitError);
		expect(stderrSpy).toHaveBeenCalledWith("error: boom\n");
	});
});

describe("allowlist remove — action wiring", () => {
	it("forwards ecosystem, package, and explicit cwd", async () => {
		const program = build();
		await program.parseAsync(
			["allowlist", "remove", "cargo", "serde", "--cwd", "/r"],
			{ from: "user" },
		);
		expect(removeAllowlistCommand).toHaveBeenCalledWith("cargo", "serde", { cwd: "/r" });
	});

	it("defaults cwd to process.cwd()", async () => {
		const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/def");
		try {
			const program = build();
			await program.parseAsync(["allowlist", "remove", "go", "pkg"], { from: "user" });
		} finally {
			cwdSpy.mockRestore();
		}
		expect(removeAllowlistCommand).toHaveBeenCalledWith("go", "pkg", { cwd: "/def" });
	});
});

describe("allowlist list — action wiring", () => {
	it("forwards ecosystem + json + cwd", async () => {
		const program = build();
		await program.parseAsync(
			["allowlist", "list", "--ecosystem", "npm", "--json", "--cwd", "/l"],
			{ from: "user" },
		);
		expect(listAllowlistCommand).toHaveBeenCalledWith({
			cwd: "/l",
			ecosystem: "npm",
			json: true,
		});
	});

	it("omits absent optionals and defaults cwd", async () => {
		const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/lc");
		try {
			const program = build();
			await program.parseAsync(["allowlist", "list"], { from: "user" });
		} finally {
			cwdSpy.mockRestore();
		}
		expect(listAllowlistCommand).toHaveBeenCalledWith({ cwd: "/lc" });
	});
});

describe("allowlist snapshot — action wiring", () => {
	it("forwards reason + lockfile + cwd", async () => {
		const program = build();
		await program.parseAsync(
			[
				"allowlist",
				"snapshot",
				"--by",
				"qcody",
				"--reason",
				"pinned",
				"--lockfile",
				"package-lock.json",
				"--cwd",
				"/s",
			],
			{ from: "user" },
		);
		expect(snapshotAllowlistCommand).toHaveBeenCalledWith({
			cwd: "/s",
			by: "qcody",
			reason: "pinned",
			lockfile: "package-lock.json",
		});
	});

	it("defaults cwd and omits absent optionals", async () => {
		const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/sd");
		try {
			const program = build();
			await program.parseAsync(["allowlist", "snapshot", "--by", "me"], { from: "user" });
		} finally {
			cwdSpy.mockRestore();
		}
		expect(snapshotAllowlistCommand).toHaveBeenCalledWith({ cwd: "/sd", by: "me" });
	});

	it("exits 2 when --by is missing and never calls the impl", async () => {
		const program = build();
		await expect(
			program.parseAsync(["allowlist", "snapshot"], { from: "user" }),
		).rejects.toThrow(ExitError);
		expect(stderrSpy).toHaveBeenCalledWith("error: --by <name> is required\n");
		expect(snapshotAllowlistCommand).not.toHaveBeenCalled();
	});
});

describe("allowlist verify — action wiring", () => {
	it("forwards explicit cwd", async () => {
		const program = build();
		await program.parseAsync(["allowlist", "verify", "--cwd", "/v"], { from: "user" });
		expect(verifyAllowlistCommand).toHaveBeenCalledWith({ cwd: "/v" });
	});

	it("defaults cwd to process.cwd()", async () => {
		const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/vd");
		try {
			const program = build();
			await program.parseAsync(["allowlist", "verify"], { from: "user" });
		} finally {
			cwdSpy.mockRestore();
		}
		expect(verifyAllowlistCommand).toHaveBeenCalledWith({ cwd: "/vd" });
	});
});
