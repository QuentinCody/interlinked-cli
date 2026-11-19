import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildStructuralPolicyProposal } from "./proposal.js";
import { parsePolicyProfile } from "./profile.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function project(entry: unknown): string {
	const root = mkdtempSync(join(tmpdir(), "profile-proposal-")); roots.push(root);
	mkdirSync(join(root, ".interlinked"));
	writeFileSync(join(root, ".interlinked/check-policy.json"), JSON.stringify({ checks: { nan_comparison: { action: "warn_before" } }, metrics: { cyclomatic: entry } }));
	return root;
}
describe("reviewable structural profile proposal", () => {
	it("keeps AST tokens out of canonical gate proposals", () => {
		const root = project({});
		const result = buildStructuralPolicyProposal(root, parsePolicyProfile({ schemaVersion: 1, id: "team", metrics: { tokens: { mode: "block", threshold: 100 } } }));
		expect(result.state).toBe("none");
		expect(result.omittedMetrics).toEqual(["tokens"]);
		expect(result.document).toBeNull();
	});
	it("can propose an explicitly canonical function-token target", () => {
		const root = project({});
		const result = buildStructuralPolicyProposal(root, parsePolicyProfile({ schemaVersion: 1, id: "team", metrics: { "function-tokens": { mode: "block", threshold: 400 } } }));
		expect(result.document?.metrics).toMatchObject({ "function-tokens": { threshold: 400 } });
		expect(result.omittedMetrics).toEqual([]);
	});
	it("retains unrelated config and never writes the proposal", () => {
		const root = project({ mode: "block", threshold: 20 }), path = join(root, ".interlinked/check-policy.json"), before = readFileSync(path, "utf8");
		const result = buildStructuralPolicyProposal(root, parsePolicyProfile({ schemaVersion: 1, id: "team", metrics: { cyclomatic: { mode: "block", threshold: 10 }, difficulty: { mode: "warn", threshold: 40 } } }));
		expect(result.state).toBe("reviewable");
		expect(result.document?.checks).toBeDefined();
		expect(result.omittedMetrics).toEqual(["difficulty"]);
		expect(readFileSync(path, "utf8")).toBe(before);
	});
	it("exposes integrity refusal for an adopted block downgrade", () => {
		const root = project({ mode: "block", threshold: 10 });
		const result = buildStructuralPolicyProposal(root, parsePolicyProfile({ schemaVersion: 1, id: "team", metrics: { cyclomatic: { mode: "off" } } }));
		expect(result.state).toBe("would-weaken");
		expect(result.findings.join(" ")).toContain("mode");
	});
	it("does not overwrite malformed current policy in a proposal", () => {
		const root = project({}); writeFileSync(join(root, ".interlinked/check-policy.json"), "{broken");
		const result = buildStructuralPolicyProposal(root, parsePolicyProfile({ schemaVersion: 1, id: "team", metrics: { cognitive: { mode: "warn" } } }));
		expect(result.state).toBe("unavailable");
		expect(result.document).toBeNull();
	});
	it("keeps a valid JSON document with invalid policy fields unavailable", () => {
		const root = project({}); writeFileSync(join(root, ".interlinked/check-policy.json"), '{"checks":false}');
		expect(buildStructuralPolicyProposal(root, parsePolicyProfile({ schemaVersion: 1, id: "team", metrics: { cognitive: {} } })).state).toBe("unavailable");
	});
});
