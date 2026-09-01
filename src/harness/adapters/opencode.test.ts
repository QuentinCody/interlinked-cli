import { describe, expect, it } from "vitest";
import { PROVIDER_BRIDGE_MARKER } from "./provider-bridge-source.js";
import { createOpenCodeAdapter, renderOpenCodeBridgeSource } from "./opencode.js";

const adapter = createOpenCodeAdapter();

describe("OpenCode adapter", () => {
	it("exposes the native plugin surface", () => {
		expect(adapter.id).toBe("opencode");
		expect(adapter.nativeEventNames).toContain("tool.execute.before");
		expect(adapter.nativeEventNames).toContain("tool.execute.after");
		expect(adapter.nativeEventNames).not.toContain("permission.ask");
		expect(adapter.nativeEventNames).toContain("event:session.compacted");
	});

	it("detects explicit OpenCode process markers only", () => {
		expect(adapter.detectFromEnv({ OPENCODE: "1" })).toBe(true);
		expect(adapter.detectFromEnv({ INTERLINKED_CLIENT: "opencode" })).toBe(true);
		expect(adapter.detectFromEnv({ OPENCODE2: "1" })).toBe(false);
		expect(adapter.detectFromEnv({ OPENCODE: "1", OPENCODE2: "1" })).toBe(false);
		expect(adapter.detectFromEnv({})).toBe(false);
	});

	it("normalizes a tool.execute.before payload", () => {
		const event = adapter.parseHookInput(
			{
				sessionID: "oc-1",
				callID: "call-1",
				cwd: "/repo",
				tool: "edit",
				args: { file_path: "/repo/a.ts" },
			},
			"tool.execute.before",
		);
		expect(event).toMatchObject({
			runner: "opencode",
			session_id: "oc-1",
			tool_use_id: "call-1",
			phase: "pre-tool",
		});
		expect(event.action).toMatchObject({
			kind: "tool_call",
			tool_name: "edit",
			tool_class: "modify",
		});
	});

	it("normalizes permission and event-bus lifecycle phases", () => {
		expect(
			adapter.parseHookInput(
				{ session_id: "oc", tool_name: "permission:bash", tool_input: {} },
				"permission.ask",
			).phase,
		).toBe("permission-request");
		expect(
			adapter.parseHookInput({ session_id: "oc" }, "event:session.created").phase,
		).toBe("session-start");
	});
});

describe("OpenCode managed plugin", () => {
	it("routes every installed capability through a generated callback", () => {
		expect(adapter.nativeEventNames).toEqual([
			"chat.message",
			"tool.execute.before",
			"tool.execute.after",
			"experimental.session.compacting",
			"event:session.created",
			"event:session.deleted",
			"event:session.idle",
			"event:session.error",
			"event:session.compacted",
			"event:permission.updated",
			"event:permission.replied",
		]);
		const source = renderOpenCodeBridgeSource("/bin/hook");
		for (const eventName of adapter.nativeEventNames) {
			const registration = eventName.startsWith("event:")
				? `"${eventName.slice("event:".length)}"`
				: `"${eventName}": async`;
			expect(source, eventName).toContain(registration);
		}
	});

	it("uses provider-native project and user locations", () => {
		expect(adapter.renderSettingsFragment("/bin/hook", "project").path).toBe(
			".opencode/plugins/interlinked.ts",
		);
		expect(adapter.renderSettingsFragment("/bin/hook", "local").path).toBe(
			".opencode/plugins/interlinked.ts",
		);
		expect(adapter.renderSettingsFragment("/bin/hook", "user").path).toBe(
			"~/.config/opencode/plugins/interlinked.ts",
		);
	});

	it("renders an exact self-contained bounded bridge", () => {
		const binaryPath = "/tmp/a path/hook-entry.mjs";
		const fragment = adapter.renderSettingsFragment(binaryPath, "project");
		expect(fragment.fragment).toEqual({});
		expect(fragment.mergeStrategy).toBe("deep-merge");
		expect(fragment.fileContent).toBe(renderOpenCodeBridgeSource(binaryPath));
		expect(fragment.fileContent?.startsWith(PROVIDER_BRIDGE_MARKER)).toBe(true);
		expect(fragment.fileContent).toContain(JSON.stringify(binaryPath));
		expect(fragment.fileContent).toContain('INTERLINKED_CLIENT: INTERLINKED_RUNNER');
		expect(fragment.fileContent).toContain('"tool.execute.before"');
		expect(fragment.fileContent).not.toContain('"permission.ask": async');
		expect(fragment.fileContent).toContain("Object.assign(output.args, decision.updated_input)");
		expect(fragment.fileContent).toContain("INTERLINKED_TIMEOUT_MS = 10_000");
		expect(fragment.fileContent).toContain('hook_event_name: interlinkedLegacyHookEvent(eventName)');
		expect(fragment.fileContent).toContain('.join("\\n")');
		expect(fragment.fileContent).toContain('"\\n\\n[interlinked]\\n"');
		expect(fragment.fileContent).toContain('export default { id: "interlinked", setup: async () => {} }');
		expect(fragment.fileContent).toContain("if (interlinkedIsOpenCodeV2()) return {};");
	});

	it("hard-denies ask decisions because OpenCode cannot initiate native confirmation", () => {
		const event = adapter.parseHookInput(
			{ session_id: "oc", tool_name: "bash", tool_input: { command: "rm x" } },
			"tool.execute.before",
		);
		const output = adapter.encodeDecision(
			{
				decision: "ask",
				reason: "Confirm deletion",
				resolved_targets: [{ kind: "file", value: "x" }],
			},
			event,
		);
		expect(output.exit_code).toBe(0);
		expect(JSON.parse(output.stdout ?? "{}")).toMatchObject({
			decision: "ask",
			reason: expect.stringContaining("x"),
		});
	});
});
