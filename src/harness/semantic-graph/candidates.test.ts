import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CouplingPair } from "../../commands/metrics-coupling.js";
import {
	buildCandidateIndex,
	candidatesFor,
	coChangeFromGit,
	coChangeFromPairs,
	companionKey,
	nameTokens,
} from "./candidates.js";
import type { RelationshipType, Unit, UnitKind } from "./types.js";

const CWD = "/repo";

function unit(file: string, kind: UnitKind, name: string, line: number): Unit {
	return { id: `${file}#${kind}:${name}@${line}`, kind, file, name, line, endLine: line, text: name, hash: name };
}

function type(rules: RelationshipType["candidate_rules"], k = 8, target: UnitKind = "function"): RelationshipType {
	return {
		name: "t",
		description: "",
		source_kind: "function",
		target_kind: target,
		question: "?",
		none_description: "",
		candidate_rules: rules,
		k,
	};
}

const UNITS: Unit[] = [
	unit("src/a.ts", "function", "parseConfig", 10),
	unit("src/a.ts", "function", "loadConfigFile", 30),
	unit("src/a.ts", "function", "helper", 12),
	unit("src/a.ts", "doc_comment", "parseConfig", 9),
	unit("src/b.ts", "function", "writeConfig", 5),
	unit("src/c.ts", "function", "unrelated", 1),
	unit("src/d.ts", "function", "parseConfigLine", 1),
	unit("src/__tests__/a.test.ts", "test", "parses config", 3),
	unit("src/b.test.ts", "test", "writes config", 3),
];

/** A graph double: a imports b; c imports a. Paths absolute, as ProjectGraph returns them. */
const GRAPH = {
	getDependencies: (file: string) =>
		file === join(CWD, "src/a.ts")
			? [{ fromFile: file, toFile: join(CWD, "src/b.ts"), specifier: "./b.js", symbols: [], isTypeOnly: false }]
			: [],
	getDependents: (file: string) => (file === join(CWD, "src/a.ts") ? [join(CWD, "src/c.ts")] : []),
};

const CO_CHANGE = new Map<string, string[]>([["src/a.ts", ["src/d.ts", "src/c.ts"]]]);

function names(units: Unit[]): string[] {
	return units.map((u) => u.name);
}

describe("candidatesFor — positive (each rule yields its targets)", () => {
	const index = buildCandidateIndex(UNITS, CWD, { graph: GRAPH, coChange: CO_CHANGE });
	const source = UNITS[0]!;

	it("P1: same_file returns target-kind units in the file, nearest line first, never the source", () => {
		expect(names(candidatesFor(source, type(["same_file"]), index))).toEqual(["helper", "loadConfigFile"]);
	});

	it("P2: import_edge returns units from imported and importing files", () => {
		expect(names(candidatesFor(source, type(["import_edge"]), index))).toEqual(["writeConfig", "unrelated"]);
	});

	it("P3: name_match ranks by shared identifier tokens of length 4 or more; a type without same_file is cross-file", () => {
		expect(names(candidatesFor(source, type(["name_match"]), index))).toEqual(["parseConfigLine", "writeConfig"]);
	});

	it("P3b: listing same_file lets name_match keep same-file units in its own rank order", () => {
		expect(names(candidatesFor(source, type(["name_match", "same_file"]), index))).toEqual([
			"parseConfigLine",
			"loadConfigFile",
			"writeConfig",
			"helper",
		]);
	});

	it("P4: co_change returns units from co-changed files in the caller's order", () => {
		expect(names(candidatesFor(source, type(["co_change"]), index))).toEqual(["parseConfigLine", "unrelated"]);
	});

	it("P5: companion maps a test file to its module and back, in both layouts", () => {
		const testA = UNITS[7]!;
		const testB = UNITS[8]!;
		expect(names(candidatesFor(testA, type(["companion"]), index))).toEqual(["parseConfig", "helper", "loadConfigFile"]);
		expect(names(candidatesFor(testB, type(["companion"]), index))).toEqual(["writeConfig"]);
		expect(names(candidatesFor(source, type(["companion"], 8, "test"), index))).toEqual(["parses config"]);
	});

	it("P6: rules apply in order, deduplicate, and stop at k", () => {
		const ordered = candidatesFor(source, type(["co_change", "name_match", "same_file"], 4), index);
		expect(names(ordered)).toEqual(["parseConfigLine", "unrelated", "loadConfigFile", "writeConfig"]);
		expect(new Set(ordered.map((u) => u.id)).size).toBe(4);
	});

	it("P7: coChangeFromPairs orders partners by strength and keeps both directions", () => {
		const pair = (a: string, b: string, strength: number): CouplingPair =>
			({ a, b, support: 2, revA: 2, revB: 2, strength, percentile: 0 });
		const map = coChangeFromPairs([pair("src/a.ts", "src/c.ts", 10), pair("src/d.ts", "src/a.ts", 50)]);
		expect(map.get("src/a.ts")).toEqual(["src/d.ts", "src/c.ts"]);
		expect(map.get("src/c.ts")).toEqual(["src/a.ts"]);
	});

	it("P8: coChangeFromGit parses the injected log without running git", () => {
		const log = ["aaa\t1", "src/a.ts", "src/d.ts", "", "bbb\t2", "src/a.ts", "src/d.ts", ""].join("\n");
		const seen: string[][] = [];
		const map = coChangeFromGit(CWD, "90 days ago", { runGit: (args) => { seen.push(args); return log; } });
		expect(seen[0]).toContain("--since=90 days ago");
		expect(map.get("src/a.ts")).toEqual(["src/d.ts"]);
	});

	it("P9: nameTokens splits camelCase and snake_case and drops short tokens", () => {
		expect(nameTokens("parseHTTPConfig_file.v2")).toEqual(new Set(["parse", "http", "config", "file"]));
		expect(companionKey("src/__tests__/a.test.ts")).toBe(companionKey("src/a.ts"));
		expect(companionKey("src/b.spec.ts")).toBe(companionKey("src/b.ts"));
	});
});

describe("candidatesFor — negative (no invented candidates)", () => {
	const index = buildCandidateIndex(UNITS, CWD, { graph: GRAPH, coChange: CO_CHANGE });

	it("N1: a file with no import edges yields nothing from import_edge", () => {
		expect(candidatesFor(UNITS[5]!, type(["import_edge"]), index)).toEqual([]);
	});

	it("N2: name_match needs a shared token of length 4 or more; the source and other kinds are excluded", () => {
		const out = candidatesFor(UNITS[2]!, type(["name_match"]), index);
		expect(out).toEqual([]);
		expect(candidatesFor(UNITS[0]!, type(["name_match"]), index).some((u) => u.kind !== "function")).toBe(false);
	});

	it("N3: no co-change data yields nothing from co_change", () => {
		const bare = buildCandidateIndex(UNITS, CWD, { graph: GRAPH });
		expect(candidatesFor(UNITS[0]!, type(["co_change"]), bare)).toEqual([]);
	});

	it("N4: a module and another module never read as companions", () => {
		expect(candidatesFor(UNITS[4]!, type(["companion"]), index)).toEqual([]);
	});

	it("N5: the source unit is never a candidate and k bounds the result", () => {
		const out = candidatesFor(UNITS[0]!, type(["same_file", "import_edge", "name_match", "co_change"], 2), index);
		expect(out.length).toBe(2);
		expect(out.some((u) => u.id === UNITS[0]!.id)).toBe(false);
	});
});
