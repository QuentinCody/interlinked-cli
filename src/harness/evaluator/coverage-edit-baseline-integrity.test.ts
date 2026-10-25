// Companion for the coverage-edit arm of the baseline-integrity gate. The
// red-team pins (P-cases reproducing recorded bypasses) live in
// red-team-2026-10-21-coverage-scope.test.ts; this file pins the detector's
// own rules in isolation.
import { describe, expect, it } from "vitest";
import { detectCoverageEdit } from "./coverage-edit-baseline-integrity.js";

const FILE = "/repo/.interlinked/coverage-edit-baseline.json";
const SCOPE = "scoped:0123456789ab";
const always = () => true;
const never = () => false;

function rules(before: unknown, after: unknown, exists = always): string[] {
	return detectCoverageEdit(FILE, before, after, exists).map((f) => f.rule);
}

describe("detectCoverageEdit — positive (must fire)", () => {
	it("fires on a lowered fraction under the same scope", () => {
		expect(rules({ "src/a.ts": { f: 0.9, scope: SCOPE } }, { "src/a.ts": { f: 0.4, scope: SCOPE } })).toEqual(["coverage-edit:src/a.ts"]);
	});
	it("fires on a lowered fraction under a changed scope, naming both the drop and the re-key", () => {
		expect(rules({ "src/a.ts": { f: 0.9, scope: SCOPE } }, { "src/a.ts": { f: 0.4, scope: "full" } })).toEqual([
			"coverage-edit:src/a.ts",
			"coverage-edit-scope:src/a.ts",
		]);
	});
	it("fires on a scope re-key at an equal fraction", () => {
		expect(rules({ "src/a.ts": { f: 0.9, scope: SCOPE } }, { "src/a.ts": { f: 0.9, scope: "full" } })).toEqual(["coverage-edit-scope:src/a.ts"]);
	});
	it("fires on a scope the runtime grammar never writes — kept entry (trailing space) and new entry", () => {
		const kept = detectCoverageEdit(FILE, { "src/a.ts": { f: 0.9, scope: SCOPE } }, { "src/a.ts": { f: 0.9, scope: `${SCOPE} ` } }, always);
		expect(kept.map((f) => f.rule)).toEqual(["coverage-edit-scope:src/a.ts", "coverage-edit-scope:src/a.ts"]);
		expect(kept[1]?.message).toContain("never writes");
		expect(rules({}, { "src/n.ts": { f: 0.1, scope: "x" } })).toEqual(["coverage-edit-scope:src/n.ts"]);
		expect(rules({}, { "src/n.ts": { f: 0.1, scope: "scoped:ABCDEF012345" } })).toEqual(["coverage-edit-scope:src/n.ts"]);
	});
	it("fires on an entry removed while its source exists, or replaced by an undecodable value", () => {
		expect(rules({ "src/a.ts": 0.9 }, {}, always)).toEqual(["coverage-edit:src/a.ts"]);
		expect(rules({ "src/a.ts": 0.9 }, { "src/a.ts": { f: "bad" } })).toEqual(["coverage-edit:src/a.ts"]);
		expect(rules({ "src/a.ts": 0.9 }, { "src/a.ts": null })).toEqual(["coverage-edit:src/a.ts"]);
	});
});

describe("detectCoverageEdit — negative (must not fire)", () => {
	it("allows a raise, an equal rewrite, and a legacy→legacy equal shape", () => {
		expect(rules({ "src/a.ts": { f: 0.9, scope: SCOPE } }, { "src/a.ts": { f: 0.95, scope: SCOPE } })).toEqual([]);
		expect(rules({ "src/a.ts": 0.9 }, { "src/a.ts": 0.9 })).toEqual([]);
		expect(rules({ "src/a.ts": 0.9 }, { "src/a.ts": { f: 0.9 } })).toEqual([]);
	});
	it("allows removing an entry whose source is gone", () => {
		expect(rules({ "src/a.ts": { f: 0.9, scope: SCOPE } }, {}, never)).toEqual([]);
	});
	it("allows new entries in either runtime shape", () => {
		expect(rules({}, { "src/n.ts": 0.4, "src/m.ts": { f: 0.3, scope: "full" }, "src/o.ts": { f: 0.3, scope: SCOPE } })).toEqual([]);
	});
	it("skips a before-entry it cannot decode and tolerates non-object documents", () => {
		expect(rules({ "src/a.ts": "garbage" }, {})).toEqual([]);
		expect(rules("not an object", { "src/a.ts": 0.1 })).toEqual([]);
		expect(rules({ "src/a.ts": 0.9 }, null, never)).toEqual([]);
	});
});
