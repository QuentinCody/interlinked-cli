import { describe, expect, it } from "vitest";

import {
	CONFIDENTIAL_LEVELS,
	getCommand,
	isBashCandidate,
	planHintsContainTool,
} from "./candidate-helpers.js";

describe("CONFIDENTIAL_LEVELS", () => {
	it("contains the two confidential sensitivity levels", () => {
		expect(CONFIDENTIAL_LEVELS.has("Confidential")).toBe(true);
		expect(CONFIDENTIAL_LEVELS.has("HighlyConfidential")).toBe(true);
	});

	it("excludes the non-confidential sensitivity levels", () => {
		expect(CONFIDENTIAL_LEVELS.has("Public")).toBe(false);
		expect(CONFIDENTIAL_LEVELS.has("Internal")).toBe(false);
	});
});

describe("getCommand", () => {
	it("returns the command string when present", () => {
		expect(getCommand({ command: "npm test" })).toBe("npm test");
	});

	it("returns an empty string for undefined tool input", () => {
		expect(getCommand(undefined)).toBe("");
	});

	it("returns an empty string when the command key is absent", () => {
		expect(getCommand({})).toBe("");
	});

	it("returns an empty string when the command is not a string", () => {
		expect(getCommand({ command: 42 })).toBe("");
		expect(getCommand({ command: null })).toBe("");
	});
});

describe("isBashCandidate", () => {
	it("accepts the exact Bash tool name", () => {
		expect(isBashCandidate("Bash")).toBe(true);
	});

	it("rejects other tool names and undefined", () => {
		expect(isBashCandidate("Read")).toBe(false);
		expect(isBashCandidate("bash")).toBe(false);
		expect(isBashCandidate(undefined)).toBe(false);
	});
});

describe("planHintsContainTool", () => {
	it("returns true when a hint matches the candidate tool case-insensitively", () => {
		expect(planHintsContainTool("Bash", { steps: [{ tool_hint: "bash" }] })).toBe(true);
		expect(
			planHintsContainTool("Edit", { steps: [{ tool_hint: "Read" }, { tool_hint: "edit" }] }),
		).toBe(true);
	});

	it("returns false when no hint matches the candidate tool", () => {
		expect(planHintsContainTool("Bash", { steps: [{ tool_hint: "Read" }] })).toBe(false);
	});

	it("returns true when the plan is absent or carries no steps", () => {
		expect(planHintsContainTool("Bash", undefined)).toBe(true);
		expect(planHintsContainTool("Bash", {})).toBe(true);
		expect(planHintsContainTool("Bash", { steps: [] })).toBe(true);
	});

	it("returns true when every hint is missing or empty", () => {
		expect(planHintsContainTool("Bash", { steps: [{}, { tool_hint: "" }] })).toBe(true);
	});

	it("returns true when the candidate tool name is missing", () => {
		expect(planHintsContainTool(undefined, { steps: [{ tool_hint: "Read" }] })).toBe(true);
	});
});
