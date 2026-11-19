// The prove-kill command the nudge and the Stop check print: batch form when the
// survivors sidecar knows more than one survivor of the companion source.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emptyManifest } from "../mutation/manifest.js";
import { writeSurvivorsIndex } from "../mutation/survivors-index.js";
import type { MutationManifest, MutantRecord, SymbolRecord } from "../mutation/types.js";
import { companionSourceCandidates, knownSurvivorsFor, prefersBatch, proveKillCommandFor } from "./prove-command.js";

const TEST = "src/harness/recurrence-time.mutation-kill.test.ts";

let root: string;
beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "prove-command-")));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A manifest with `survivors` surviving and one killed mutant under one symbol of `file` (the sidecar reads only statuses and ids). */
function manifestWith(file: string, survivors: number): MutationManifest {
	const manifest = emptyManifest({ engine: "stryker", engineVersion: "9.6.1", dependencyGraphVersion: "0", environmentHash: "t", authoritativeAt: "2026-11-05T00:00:00.000Z" });
	const mutants: Record<string, MutantRecord> = {};
	const record = (id: string, status: MutantRecord["status"]): MutantRecord =>
		({ mutantId: id, siteId: id, mutator: "EqualityOperator", originalLexeme: ">", replacement: ">=", ordinalWithinSymbol: 0, status, firstSeen: "2026-11-05T00:00:00.000Z" }) as unknown as MutantRecord;
	for (let i = 0; i < survivors; i++) mutants[`${i}`.padStart(16, "a")] = record(`${i}`.padStart(16, "a"), "survived");
	mutants["b".repeat(16)] = record("b".repeat(16), "killed");
	const symbol = { symbolId: "s", qualifiedName: "f", symbolHash: "h", mutants } as unknown as SymbolRecord;
	manifest.files[file] = { s: symbol };
	return manifest;
}

describe("companionSourceCandidates — positive (must derive)", () => {
	it("P1: a mutation-directed test names its companion source in every JS/TS extension, .ts first", () => {
		expect(companionSourceCandidates(TEST)[0]).toBe("src/harness/recurrence-time.ts");
		expect(companionSourceCandidates(TEST)).toContain("src/harness/recurrence-time.tsx");
		expect(companionSourceCandidates("src/a.survivors.spec.js")[0]).toBe("src/a.ts");
		expect(companionSourceCandidates("a.mutation-hardening-w27.test.mts")[0]).toBe("a.ts");
	});
	it("P2: a plain companion test derives the same source", () => {
		expect(companionSourceCandidates("src/x.test.ts")[0]).toBe("src/x.ts");
	});
});

describe("companionSourceCandidates — negative (must not guess)", () => {
	it("N1: a path that is not a test file has no candidate", () => {
		expect(companionSourceCandidates("src/x.ts")).toEqual([]);
		expect(companionSourceCandidates("README.md")).toEqual([]);
	});
});

describe("knownSurvivorsFor / proveKillCommandFor — positive (batch form)", () => {
	it("P1: two or more sidecar survivors of the companion source give the --all-survivors command over that source", () => {
		writeSurvivorsIndex(join(root, ".interlinked"), manifestWith("src/harness/recurrence-time.ts", 2));
		const known = knownSurvivorsFor(root, TEST);
		expect(known).toEqual({ source: "src/harness/recurrence-time.ts", count: 2 });
		expect(prefersBatch(known)).toBe(true);
		expect(proveKillCommandFor(TEST, known)).toBe(`interlinked tests prove-kill --file src/harness/recurrence-time.ts --test ${TEST} --all-survivors`);
	});
});

describe("knownSurvivorsFor / proveKillCommandFor — negative (single form)", () => {
	it("N1: one known survivor keeps the single-mutant command", () => {
		writeSurvivorsIndex(join(root, ".interlinked"), manifestWith("src/harness/recurrence-time.ts", 1));
		const known = knownSurvivorsFor(root, TEST);
		expect(known?.count).toBe(1);
		expect(prefersBatch(known)).toBe(false);
		expect(proveKillCommandFor(TEST, known)).toBe(`interlinked tests prove-kill --mutant <id> --test ${TEST}`);
	});
	it("N2: no sidecar, or a sidecar without the companion source, is null and keeps the single form", () => {
		expect(knownSurvivorsFor(root, TEST)).toBeNull();
		writeSurvivorsIndex(join(root, ".interlinked"), manifestWith("src/other.ts", 5));
		expect(knownSurvivorsFor(root, TEST)).toBeNull();
		expect(proveKillCommandFor(TEST, null)).toBe(`interlinked tests prove-kill --mutant <id> --test ${TEST}`);
	});
});
