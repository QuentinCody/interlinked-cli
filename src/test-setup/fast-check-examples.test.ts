// Pins for the fast-check failure example store (Hegel trial idea #1): keyed by
// the VITEST test id (file + title), never by source text — Hegel's source-text
// key collided across tests with the same body (hegel-trial.md §7).
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	COUNTEREXAMPLE_MAX_CHARS,
	type ExampleStore,
	examplesStorePath,
	exampleWritesDisabled,
	FAST_CHECK_EXAMPLES_FILE,
	pruneExamples,
	readExampleStore,
	recordExample,
	removeExample,
	stableSeed,
	testFileOf,
	testIdFor,
	titleLeafOf,
	truncateCounterexample,
} from "./fast-check-examples.js";

const ROOT = "/repo";
const EXAMPLE = { seed: 42, path: "47:2", counterexample: "[690]", ts: "2026-10-04T00:00:00.000Z" };

describe("testIdFor — positive (must fire)", () => {
	it("P1: keys by project-relative posix path and the vitest title", () => {
		expect(testIdFor("/repo/src/a/b.test.ts", "suite > P1: holds", ROOT)).toBe("src/a/b.test.ts::suite > P1: holds");
	});

	it("P2: the file and the leaf title are recoverable from the id", () => {
		const id = testIdFor("/repo/src/a/b.test.ts", "suite > inner > P1: holds", ROOT) ?? "";
		expect(testFileOf(id)).toBe("src/a/b.test.ts");
		expect(titleLeafOf(id)).toBe("P1: holds");
	});
});

describe("testIdFor — negative (must not fire)", () => {
	it("N1: returns null when vitest state has no test path or title", () => {
		expect(testIdFor(undefined, "x", ROOT)).toBeNull();
		expect(testIdFor("/repo/a.test.ts", undefined, ROOT)).toBeNull();
		expect(testIdFor("/repo/a.test.ts", "", ROOT)).toBeNull();
	});
});

describe("stableSeed", () => {
	it("P1: is a deterministic 32-bit integer per test id", () => {
		const a = stableSeed("src/a.test.ts::t");
		expect(a).toBe(stableSeed("src/a.test.ts::t"));
		expect(Number.isInteger(a)).toBe(true);
		expect(Math.abs(a)).toBeLessThanOrEqual(2 ** 31);
	});

	it("N1: differs between two test ids", () => {
		expect(stableSeed("src/a.test.ts::t")).not.toBe(stableSeed("src/a.test.ts::u"));
	});
});

describe("store I/O", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fc-examples-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("P1: the default path is the gitignored .interlinked file", () => {
		expect(examplesStorePath(ROOT)).toBe(join(ROOT, FAST_CHECK_EXAMPLES_FILE));
		expect(FAST_CHECK_EXAMPLES_FILE).toBe(".interlinked/fast-check-examples.json");
	});
    it("preserves malformed store bytes and still archives the new failure", () => {
        const file = join(dir, "examples.json");
        writeFileSync(file, "{broken-original");
        expect(() => recordExample(file, "a.test.ts::one", EXAMPLE)).toThrow();
        expect(readFileSync(file, "utf8")).toBe("{broken-original");
        expect(JSON.parse(readFileSync(file + ".history.jsonl", "utf8"))).toMatchObject({ outcome: "failed", example: EXAMPLE });
    });

	it("P2: recordExample creates the directory and merges into existing entries", () => {
		const file = join(dir, "nested", "examples.json");
		recordExample(file, "a.test.ts::one", EXAMPLE);
		recordExample(file, "a.test.ts::two", { ...EXAMPLE, seed: 7 });
		const store = JSON.parse(readFileSync(file, "utf8")) as ExampleStore;
		expect(store.version).toBe(1);
		expect(Object.keys(store.entries).sort()).toEqual(["a.test.ts::one", "a.test.ts::two"]);
		expect(store.entries["a.test.ts::two"]?.seed).toBe(7);
	});

	it("P3: a later record for the same id replaces the earlier one", () => {
		const file = join(dir, "examples.json");
		recordExample(file, "a.test.ts::one", EXAMPLE);
		recordExample(file, "a.test.ts::one", { ...EXAMPLE, path: "1:0" });
		expect(readExampleStore(file).entries["a.test.ts::one"]?.path).toBe("1:0");
	});

	it("P4: removeExample deletes one id, keeps the rest and reports true", () => {
		const file = join(dir, "examples.json");
		recordExample(file, "a.test.ts::one", EXAMPLE);
		recordExample(file, "a.test.ts::two", EXAMPLE);
		expect(removeExample(file, "a.test.ts::one")).toBe(true);
		expect(Object.keys(readExampleStore(file).entries)).toEqual(["a.test.ts::two"]);
        const history = readFileSync(file + ".history.jsonl", "utf8").trim().split("\n").map(line => JSON.parse(line));
        expect(history[0]).toMatchObject({ outcome: "failed", example: EXAMPLE });
        expect(history.at(-1)).toMatchObject({ outcome: "not-reproduced", example: EXAMPLE });
	});
    it("does not remove a newer concurrent failure when an older replay passes", () => {
        const file = join(dir, "examples.json");
        recordExample(file, "case", EXAMPLE);
        const newer = { ...EXAMPLE, seed: 99 };
        recordExample(file, "case", newer);
        expect(removeExample(file, "case", EXAMPLE)).toBe(false);
        expect(readExampleStore(file).entries.case).toEqual(newer);
    });

	it("N2: removeExample on an absent id or file reports false and writes nothing", () => {
		const file = join(dir, "examples.json");
		expect(removeExample(file, "a.test.ts::one")).toBe(false);
		expect(existsSync(file)).toBe(false);
		recordExample(file, "a.test.ts::two", EXAMPLE);
		const bytes = readFileSync(file, "utf8");
		expect(removeExample(file, "a.test.ts::one")).toBe(false);
		expect(readFileSync(file, "utf8")).toBe(bytes);
	});

	it("N1: a missing or malformed file reads as an empty store", () => {
		expect(readExampleStore(join(dir, "absent.json"))).toEqual({ version: 1, entries: {} });
		const bad = join(dir, "bad.json");
		writeFileSync(bad, "{not json");
		expect(readExampleStore(bad)).toEqual({ version: 1, entries: {} });
		writeFileSync(bad, JSON.stringify({ version: 99, entries: { x: EXAMPLE } }));
		expect(readExampleStore(bad)).toEqual({ version: 1, entries: {} });
	});
});

describe("pruneExamples", () => {
	const store: ExampleStore = {
		version: 1,
		entries: {
			"src/live.test.ts::suite > P1: kept": EXAMPLE,
			"src/live.test.ts::suite > P2: renamed away": EXAMPLE,
			"src/gone.test.ts::suite > P1: file deleted": EXAMPLE,
			"src/other.test.ts::suite > P1: untouched file": EXAMPLE,
		},
	};
	const fs = {
		fileExists: (file: string) => file !== "src/gone.test.ts",
		readSource: (file: string) => (file === "src/live.test.ts" ? 'it("P1: kept", () => {});' : ""),
	};

	it("P1: drops entries whose test file no longer exists", () => {
		const { store: next, dropped } = pruneExamples(store, fs, "src/live.test.ts");
		expect(dropped).toContain("src/gone.test.ts::suite > P1: file deleted");
		expect(next.entries["src/gone.test.ts::suite > P1: file deleted"]).toBeUndefined();
	});

	it("N2: retains dynamic or renamed titles because substring search cannot prove removal", () => {
		const { dropped } = pruneExamples(store, fs, "src/live.test.ts");
		expect(dropped).not.toContain("src/live.test.ts::suite > P2: renamed away");
	});

	it("N1: keeps a live id and never reads the source of another file", () => {
		const { store: next, dropped } = pruneExamples(store, fs, "src/live.test.ts");
		expect(next.entries["src/live.test.ts::suite > P1: kept"]).toEqual(EXAMPLE);
		expect(next.entries["src/other.test.ts::suite > P1: untouched file"]).toEqual(EXAMPLE);
		expect(dropped).toHaveLength(1);
	});
});

describe("truncateCounterexample / exampleWritesDisabled", () => {
	it("P1: truncates a long rendering and marks the cut", () => {
		const long = "x".repeat(COUNTEREXAMPLE_MAX_CHARS * 2);
		const out = truncateCounterexample(long);
		expect(out.length).toBeLessThanOrEqual(COUNTEREXAMPLE_MAX_CHARS + 1);
		expect(out.endsWith("…")).toBe(true);
	});

	it("N1: leaves a short rendering intact", () => {
		expect(truncateCounterexample("[690]")).toBe("[690]");
	});

	it("P2: writes are disabled under a Stryker mutant or an explicit opt-out", () => {
		expect(exampleWritesDisabled({ STRYKER_MUTATOR_WORKER: "0" })).toBe(true);
		expect(exampleWritesDisabled({ __STRYKER_ACTIVE_MUTANT__: "12" })).toBe(true);
		expect(exampleWritesDisabled({ INTERLINKED_FC_EXAMPLES: "off" })).toBe(true);
	});

	it("N2: writes are enabled by default", () => {
		expect(exampleWritesDisabled({})).toBe(false);
	});
});
