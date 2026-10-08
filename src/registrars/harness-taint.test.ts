import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerHarnessTaint } from "./harness-taint.js";

const calls = vi.hoisted(() => ({ status: vi.fn(), clear: vi.fn() }));
vi.mock("../commands/harness-taint.js", () => ({
	harnessTaintStatusCommand: calls.status,
	harnessTaintClearCommand: calls.clear,
}));

beforeEach(() => {
	vi.clearAllMocks();
});

function parse(args: string[]): Promise<Command> {
	const harness = new Command().exitOverride();
	registerHarnessTaint(harness);
	return harness.parseAsync(args, { from: "user" });
}

describe("harness taint registration — positive (must fire)", () => {
	it("P1: `taint status --session` reaches the status command", async () => {
		await parse(["taint", "status", "--session", "abc", "--json"]);
		expect(calls.status).toHaveBeenCalledExactlyOnceWith({ session: "abc", json: true });
	});

	it("P2: bare `taint` defaults to status", async () => {
		await parse(["taint"]);
		expect(calls.status).toHaveBeenCalledExactlyOnceWith({});
	});

	it("P3: `taint clear` passes the session and the reason", async () => {
		await parse(["taint", "clear", "--session", "abc", "--reason", "false positive"]);
		expect(calls.clear).toHaveBeenCalledExactlyOnceWith({
			session: "abc",
			reason: "false positive",
		});
	});

	it("P4: `taint clear --actor` forwards the actor key (per-actor clear, B3)", async () => {
		await parse(["taint", "clear", "--session", "abc", "--reason", "fp", "--actor", "child-a"]);
		expect(calls.clear).toHaveBeenCalledExactlyOnceWith({
			session: "abc",
			reason: "fp",
			actor: "child-a",
		});
	});
});

describe("harness taint registration — negative (must not fire)", () => {
	it("N1: clear without --reason is rejected before the command runs", async () => {
		await expect(parse(["taint", "clear", "--session", "abc"])).rejects.toThrow();
		expect(calls.clear).not.toHaveBeenCalled();
	});

	it("N2: there is no --yes or --force escape hatch on clear", async () => {
		await expect(
			parse(["taint", "clear", "--session", "abc", "--reason", "r", "--yes"]),
		).rejects.toThrow();
		await expect(
			parse(["taint", "clear", "--session", "abc", "--reason", "r", "--force"]),
		).rejects.toThrow();
		expect(calls.clear).not.toHaveBeenCalled();
	});
});
