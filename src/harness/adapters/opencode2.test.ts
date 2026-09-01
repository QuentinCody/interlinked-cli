import { describe, expect, it } from "vitest";
import { createOpencode2Adapter } from "./opencode2.js";

const adapter = createOpencode2Adapter();

describe("OpenCode adapter identity", () => {
	it("has the expected id and native events", () => {
		expect(adapter.id).toBe("opencode2");
		expect(adapter.nativeEventNames).toContain("tool.execute.before");
		expect(adapter.nativeEventNames).toContain("session.idle");
	});

	it("installs a v2-only plugin path, not the v1 interlinked.ts bridge", () => {
		const project = adapter.renderSettingsFragment("/bin/hook", "project");
		expect(project.path).toBe(".opencode/plugins/interlinked-opencode2.ts");
		expect(project.fileContent).toContain("interlinked-opencode2");
		expect(adapter.renderSettingsFragment("/bin/hook", "user").path).toBe(
			"~/.config/opencode/plugins/interlinked-opencode2.ts",
		);
	});
});

describe("OpenCode detectFromEnv", () => {
	it("P1: detects OPENCODE2", () => {
		expect(adapter.detectFromEnv({ OPENCODE2: "1" })).toBe(true);
	});
	it("N3: XDG_CONFIG_HOME substring is not a v2 identity signal", () => {
		expect(adapter.detectFromEnv({ XDG_CONFIG_HOME: "/home/agent/.config/opencode-v2" })).toBe(false);
	});
	it("N1: ignores a plain env", () => {
		expect(adapter.detectFromEnv({})).toBe(false);
	});
	it("N2: ignores v1 OPENCODE without v2 markers", () => {
		expect(adapter.detectFromEnv({ OPENCODE: "1" })).toBe(false);
	});
});

describe("OpenCode parseHookInput", () => {
	it("P1: maps tool.execute.before edit to a tool_call", () => {
		const event = adapter.parseHookInput(
			{ sessionID: "s1", cwd: "/r", tool: "edit", args: { filePath: "/r/a.ts", oldString: "a", newString: "b" } },
			"tool.execute.before",
		);
		expect(event.phase).toBe("pre-tool");
		expect(event.runner).toBe("opencode2");
		if (event.action.kind !== "tool_call") throw new Error("expected tool_call");
		expect(event.action.tool_name).toBe("Edit");
		expect(event.action.tool_input).toMatchObject({ file_path: "/r/a.ts" });
	});

	it("P2: session.created is a lifecycle event", () => {
		const event = adapter.parseHookInput({ sessionID: "s2" }, "session.created");
		expect(event.phase).toBe("session-start");
		expect(event.action.kind).toBe("other");
	});
});

describe("OpenCode encodeDecision", () => {
	it("P1: block exits 2 with a reason", () => {
		const out = adapter.encodeDecision(
			{ decision: "block", reason: "nope", warnings: [] },
			adapter.parseHookInput({}, "tool.execute.before"),
		);
		expect(out.exit_code).toBe(2);
		expect(out.stdout).toContain("nope");
	});

	it("N1: allow exits 0", () => {
		const out = adapter.encodeDecision(
			{ decision: "allow", warnings: [] },
			adapter.parseHookInput({}, "tool.execute.before"),
		);
		expect(out.exit_code).toBe(0);
	});
});
