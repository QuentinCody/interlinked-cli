import { describe, expect, it } from "vitest";
import { shouldObserveWorkspaceEffects } from "./workspace-effects-read-only-tools.js";

describe("shouldObserveWorkspaceEffects", () => {
	it("P1: returns false for a known read-only tool", () => {
		expect(shouldObserveWorkspaceEffects("Read")).toBe(false);
		expect(shouldObserveWorkspaceEffects("Grep")).toBe(false);
		expect(shouldObserveWorkspaceEffects("WebFetch")).toBe(false);
	});

	it("N1: returns true for a write-capable tool", () => {
		expect(shouldObserveWorkspaceEffects("Edit")).toBe(true);
		expect(shouldObserveWorkspaceEffects("Bash")).toBe(true);
	});

	it("N2: returns true (observe by default) for an unknown tool name", () => {
		expect(shouldObserveWorkspaceEffects("SomeNewMcpTool")).toBe(true);
	});

	it("N3: returns true when the tool name is undefined", () => {
		expect(shouldObserveWorkspaceEffects(undefined)).toBe(true);
	});
});
