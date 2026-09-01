import { describe, expect, it } from "vitest";
import { mapOpencode2Tool, opencode2ColdBlockReason } from "./opencode-tool-map.js";

describe("mapOpencode2Tool — positive (must map)", () => {
	it("P1: maps bash and shell command + workdir", () => {
		expect(mapOpencode2Tool("bash", { command: "ls", workdir: "/tmp" })).toEqual({
			tool_name: "Bash",
			tool_input: { command: "ls", cwd: "/tmp" },
		});
		expect(mapOpencode2Tool("shell", { command: "ls" }).tool_name).toBe("Bash");
	});

	it("P2: maps edit camelCase fields to file_path/old_string/new_string", () => {
		const mapped = mapOpencode2Tool("edit", {
			filePath: "/r/a.ts",
			oldString: "x",
			newString: "y",
			replaceAll: true,
		});
		expect(mapped.tool_name).toBe("Edit");
		expect(mapped.tool_input).toMatchObject({
			file_path: "/r/a.ts",
			old_string: "x",
			new_string: "y",
			replace_all: true,
		});
	});

	it("P3: maps write/read/grep/task", () => {
		expect(mapOpencode2Tool("write", { filePath: "/r/a.ts", content: "hi" }).tool_name).toBe("Write");
		expect(mapOpencode2Tool("read", { filePath: "/r/a.ts" }).tool_name).toBe("Read");
		expect(mapOpencode2Tool("grep", { pattern: "foo", include: "*.ts" }).tool_input.glob).toBe("*.ts");
		expect(mapOpencode2Tool("task", { prompt: "do", agent: "engineer" }).tool_input.subagent_type).toBe(
			"engineer",
		);
	});
});

describe("mapOpencode2Tool — negative (must not invent names)", () => {
	it("N1: unknown tools keep their original name", () => {
		expect(mapOpencode2Tool("skill", { name: "x" }).tool_name).toBe("skill");
	});

	it("N2: non-object args become empty input", () => {
		expect(mapOpencode2Tool("bash", "nope").tool_input).toEqual({});
	});
});

describe("opencode2ColdBlockReason", () => {
	it("P1: blocks recursive rm of /", () => {
		expect(opencode2ColdBlockReason("Bash", { command: "rm -rf /" })).toMatch(/BLOCKED/);
		expect(opencode2ColdBlockReason("Bash", { command: "rm -fr /" })).toMatch(/BLOCKED/);
		expect(opencode2ColdBlockReason("Bash", { command: "rm -fr ~" })).toMatch(/BLOCKED/);
	});

	it("P2: blocks npm install", () => {
		expect(opencode2ColdBlockReason("Bash", { command: "npm install left-pad" })).toMatch(/BLOCKED/);
	});

	it("N1: allows ls", () => {
		expect(opencode2ColdBlockReason("Bash", { command: "ls" })).toBeNull();
	});

	it("N2: ignores non-bash tools", () => {
		expect(opencode2ColdBlockReason("Edit", { command: "rm -rf /" })).toBeNull();
	});
});
