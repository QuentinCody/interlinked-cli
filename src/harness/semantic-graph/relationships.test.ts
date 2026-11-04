import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_RELATIONSHIPS,
	DEFAULT_SCOPE,
	loadRelationships,
	parseRelationshipsFile,
	resolveScope,
	writeDefaultRelationships,
} from "./relationships.js";
import { RELATIONSHIPS_FILE, type RelationshipsFile } from "./types.js";

function validFile(): RelationshipsFile {
	return JSON.parse(JSON.stringify(DEFAULT_RELATIONSHIPS)) as RelationshipsFile;
}

/** Deep-clone the seed and let the caller mutate the first type through a loose handle. */
function withFirst(mutate: (row: Record<string, unknown>) => void): unknown {
	const file = validFile() as unknown as { relationships: Record<string, unknown>[] };
	mutate(file.relationships[0] as Record<string, unknown>);
	return file;
}

describe("parseRelationshipsFile — positive (accepts a valid file)", () => {
	it("P1: accepts the seed file unchanged", () => {
		const parsed = parseRelationshipsFile(validFile(), "x.json");
		expect(parsed).toEqual(DEFAULT_RELATIONSHIPS);
	});

	it("P2: accepts a custom type with k at both bounds", () => {
		for (const k of [2, 12]) {
			const parsed = parseRelationshipsFile(withFirst((row) => {
				row.name = "supersedes";
				row.k = k;
			}), "x.json");
			expect(parsed.relationships[0]?.name).toBe("supersedes");
			expect(parsed.relationships[0]?.k).toBe(k);
		}
	});

	it("P3: the three seed types carry the documented kinds and rules", () => {
		const byName = new Map(DEFAULT_RELATIONSHIPS.relationships.map((r) => [r.name, r]));
		expect([...byName.keys()]).toEqual(["promises", "pins", "constrains"]);
		expect(byName.get("promises")).toMatchObject({
			source_kind: "doc_section",
			target_kind: "function",
			candidate_rules: ["name_match", "co_change", "import_edge"],
			k: 8,
		});
		expect(byName.get("pins")).toMatchObject({
			source_kind: "test",
			target_kind: "function",
			candidate_rules: ["companion", "name_match", "import_edge"],
			k: 8,
		});
		expect(byName.get("constrains")).toMatchObject({
			source_kind: "function",
			target_kind: "function",
			candidate_rules: ["name_match", "co_change", "same_file"],
			k: 8,
		});
	});

	it("P7: the seed scope keeps product source and top-level docs and drops session-local trees", () => {
		expect(DEFAULT_RELATIONSHIPS.scope).toEqual(DEFAULT_SCOPE);
		expect(DEFAULT_SCOPE.include).toEqual(["src/**", "docs/*.md", "README.md", "CLAUDE.md"]);
		expect(DEFAULT_SCOPE.exclude).toContain("research/**");
		expect(DEFAULT_SCOPE.exclude).toContain("scratch/**");
		expect(DEFAULT_SCOPE.exclude).toContain(".claude/**");
	});

	it("P8: a partial scope parses and resolveScope fills the absent field from the seed", () => {
		const parsed = parseRelationshipsFile({ ...validFile(), scope: { include: ["lib/**"] } }, "x.json");
		expect(parsed.scope).toEqual({ include: ["lib/**"] });
		expect(resolveScope(parsed)).toEqual({ include: ["lib/**"], exclude: DEFAULT_SCOPE.exclude });
		expect(resolveScope({})).toEqual(DEFAULT_SCOPE);
	});
});

describe("parseRelationshipsFile — negative (rejects a malformed file)", () => {
	const cases: Array<[string, unknown, RegExp]> = [
		["N1: top-level unknown key", { ...validFile(), extra: 1 }, /unknown key "extra"/],
		["N2: wrong version", { ...validFile(), version: 2 }, /version/],
		["N3: relationships not an array", { version: 1, relationships: {} }, /relationships/],
		["N4: k below 2", withFirst((r) => { r.k = 1; }), /k/],
		["N5: k above 12", withFirst((r) => { r.k = 13; }), /k/],
		["N6: unknown unit kind", withFirst((r) => { r.source_kind = "module"; }), /source_kind/],
		["N7: unknown candidate rule", withFirst((r) => { r.candidate_rules = ["vibes"]; }), /candidate_rules/],
		["N8: empty candidate rules", withFirst((r) => { r.candidate_rules = []; }), /candidate_rules/],
		["N9: unknown key on a type", withFirst((r) => { r.weight = 3; }), /unknown key "weight"/],
		["N10: missing question", withFirst((r) => { delete r.question; }), /question/],
		["N11: empty name", withFirst((r) => { r.name = ""; }), /name/],
		["N12: not an object", "nope", /object/],
		["N15: scope not an object", { ...validFile(), scope: "src" }, /scope: must be an object/],
		["N16: unknown scope key", { ...validFile(), scope: { only: ["src/**"] } }, /scope: unknown key "only"/],
		["N17: scope include with a non-string", { ...validFile(), scope: { include: ["src/**", 3] } }, /scope: "include"/],
		["N18: scope exclude with an empty glob", { ...validFile(), scope: { exclude: [""] } }, /scope: "exclude"/],
	];
	for (const [title, raw, pattern] of cases) {
		it(title, () => {
			expect(() => parseRelationshipsFile(raw, "x.json")).toThrow(pattern);
		});
	}

	it("N13: duplicate type names", () => {
		const file = validFile();
		file.relationships.push({ ...file.relationships[0]! });
		expect(() => parseRelationshipsFile(file, "x.json")).toThrow(/duplicate relationship name "promises"/);
	});
});

describe("loadRelationships / writeDefaultRelationships", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "sg-rel-"));
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("P4: returns the defaults when the file is absent", () => {
		expect(loadRelationships(cwd)).toEqual(DEFAULT_RELATIONSHIPS);
	});

	it("P5: reads a committed file", () => {
		mkdirSync(join(cwd, ".interlinked"), { recursive: true });
		const custom = withFirst((r) => { r.name = "custom"; });
		writeFileSync(join(cwd, RELATIONSHIPS_FILE), JSON.stringify(custom));
		expect(loadRelationships(cwd).relationships[0]?.name).toBe("custom");
	});

	it("P6: writes the defaults only when absent", () => {
		expect(writeDefaultRelationships(cwd)).toBe(true);
		const written = JSON.parse(readFileSync(join(cwd, RELATIONSHIPS_FILE), "utf8")) as unknown;
		expect(written).toEqual(DEFAULT_RELATIONSHIPS);
		writeFileSync(join(cwd, RELATIONSHIPS_FILE), "{}");
		expect(writeDefaultRelationships(cwd)).toBe(false);
		expect(readFileSync(join(cwd, RELATIONSHIPS_FILE), "utf8")).toBe("{}");
	});

	it("N14: a malformed committed file throws with its path", () => {
		mkdirSync(join(cwd, ".interlinked"), { recursive: true });
		writeFileSync(join(cwd, RELATIONSHIPS_FILE), "{ not json");
		expect(() => loadRelationships(cwd)).toThrow(/semantic-relationships\.json/);
	});
});
