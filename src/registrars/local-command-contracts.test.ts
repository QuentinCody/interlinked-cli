import { Command } from "commander";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerObservabilityLogCommands } from "./observability-logs.js";
import { registerQualityCommands } from "./quality.js";
import { registerSetupCommands } from "./setup.js";

let root: string;
let logs: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "local-command-contracts-"));
	vi.spyOn(process, "cwd").mockReturnValue(root);
	logs = vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	process.exitCode = 0;
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	process.exitCode = 0;
	rmSync(root, { recursive: true, force: true });
});

function program(): Command {
	const command = new Command().exitOverride();
	registerSetupCommands(command);
	registerQualityCommands(command);
	registerObservabilityLogCommands(command);
	return command;
}

function rendered(): string {
	return logs.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
}

function snapshot(name: string, source: string): string {
	const directory = join(root, ".interlinked", "sessions");
	mkdirSync(directory, { recursive: true });
	const path = join(directory, `${name}.json`);
	writeFileSync(path, JSON.stringify({ tdd_cycles: {
		[source]: { source_file: source, test_file: `${source}.test.ts`, state: "red" },
	} }));
	return path;
}

describe("registered local command output and selection contracts", () => {
	it.each([{ flags: [] }, { flags: ["--json"] }])("structure doctor fails for invalid configuration with $flags", async ({ flags }) => {
		mkdirSync(join(root, "interlinked"));
		writeFileSync(join(root, "interlinked", "structure.json"), "{ invalid fixture JSON");
		await program().parseAsync(["structure", "doctor", ...flags], { from: "user" });
		expect(process.exitCode).toBe(1);
		expect(rendered()).toContain("invalid JSON");
	});

	it.each(["", "   "])("rejects explicit blank TDD selector %j before mutation", async (selector) => {
		const path = snapshot("fixture", "/repo/app.ts");
		const original = readFileSync(path, "utf8");
		await program().parseAsync(["tdd", "clear", selector, "--cwd", root, "--json"], { from: "user" });
		expect(process.exitCode).toBe(1);
		expect(readFileSync(path, "utf8")).toBe(original);
	});

	it("retains omitted all-selection and preserves nonmatching snapshot bytes", async () => {
		const selected = snapshot("a-selected", "/repo/app.ts");
		const other = snapshot("z-other", "/repo/other.ts");
		const originalOther = readFileSync(other, "utf8");
		await program().parseAsync(["tdd", "clear", "app.ts", "--cwd", root, "--json"], { from: "user" });
		expect(JSON.parse(rendered())).toEqual({ removed: 1 });
		expect(JSON.parse(readFileSync(selected, "utf8")).tdd_cycles).toEqual([]);
		expect(readFileSync(other, "utf8")).toBe(originalOther);
		logs.mockClear();
		await program().parseAsync(["tdd", "clear", "--cwd", root, "--json"], { from: "user" });
		expect(JSON.parse(rendered())).toEqual({ removed: 1 });
	});

	it.each([{ flags: [] }, { flags: ["--short"] }, { flags: ["--full"] }])("masks human token values with $flags and preserves JSON export", async ({ flags }) => {
		for (const name of ["INTERLINKED_TOKEN", "INTERLINKED_ACCESS_TOKEN"]) {
			vi.stubEnv(name, "audit-only-token-123456789");
		}
		await program().parseAsync(["env", ...flags], { from: "user" });
		expect(rendered()).toContain("audit-on...");
		expect(rendered()).not.toContain("audit-only-token-123456789");
		logs.mockClear();
		await program().parseAsync(["env", "--json"], { from: "user" });
		expect(JSON.parse(rendered())).toEqual(expect.arrayContaining([
			expect.objectContaining({ name: "INTERLINKED_ACCESS_TOKEN", value: "audit-only-token-123456789" }),
		]));
	});
});
