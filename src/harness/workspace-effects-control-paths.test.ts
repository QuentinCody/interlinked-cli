import { describe, expect, it } from "vitest";
import type { WorkspaceChangeSet } from "./workspace-effects.js";
import {
	EXPLICIT_CONTROL_PATHS,
	formatWorkspaceResidueWarning,
	isWorkspaceControlPath,
} from "./workspace-effects-control-paths.js";

function changeSet(overrides: Partial<WorkspaceChangeSet> = {}): WorkspaceChangeSet {
	return {
		source: "filesystem-observation",
		complete: true,
		before_captured_at: "2026-01-01T00:00:00.000Z",
		after_captured_at: "2026-01-01T00:00:01.000Z",
		files: [],
		...overrides,
	};
}

describe("isWorkspaceControlPath", () => {
	it("P1: recognizes a known runtime control path", () => {
		expect(isWorkspaceControlPath(".interlinked/config.json")).toBe(true);
	});

	it("P2: normalizes backslashes before matching", () => {
		expect(isWorkspaceControlPath(".interlinked\\config.json")).toBe(true);
	});

	it("N1: rejects an ordinary source file", () => {
		expect(isWorkspaceControlPath("src/index.ts")).toBe(false);
	});
});

describe("EXPLICIT_CONTROL_PATHS", () => {
	it("P1: is a non-empty superset including at least the non-water-line control paths", () => {
		expect(EXPLICIT_CONTROL_PATHS.size).toBeGreaterThan(0);
		expect(EXPLICIT_CONTROL_PATHS.has(".interlinked/guard-rules.json")).toBe(true);
	});
});

describe("formatWorkspaceResidueWarning", () => {
	it("P1: renders a bounded warning listing effects", () => {
		const warning = formatWorkspaceResidueWarning(
			changeSet({
				files: [
					{ path: "a.ts", kind: "modified", before_sha256: "x", after_sha256: "y" },
				],
			}),
		);
		expect(warning).toContain("effect-residue");
		expect(warning).toContain("modified:a.ts");
	});

	it("P2: notes excluded effects attributed to another session", () => {
		const warning = formatWorkspaceResidueWarning(
			changeSet({
				files: [{ path: "a.ts", kind: "created", before_sha256: null, after_sha256: "y" }],
				attributed_to_other_sessions: 3,
			}),
		);
		expect(warning).toContain("3 further effect(s)");
	});

	it("N1: returns null when there are no residue files", () => {
		expect(formatWorkspaceResidueWarning(changeSet({ files: [] }))).toBeNull();
	});
});
