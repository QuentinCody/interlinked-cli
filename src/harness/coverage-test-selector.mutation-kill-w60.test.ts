import { nonNull } from "../lib/non-null.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { selectAffectedTests, type SelectAffectedTestsInput } from "./coverage-test-selector.js";

function fakeDepView(opts: {
	answerScope?: "repo" | "seed-only";
	hasFile?: (abs: string) => boolean;
	getDependents?: (abs: string) => string[];
}): SelectAffectedTestsInput["depView"] {
	return {
		answerScope: opts.answerScope ?? "repo",
		hasFile: opts.hasFile ?? (() => true),
		getDependents: opts.getDependents ?? (() => []),
	};
}

let dirs: string[] = [];
function makeTmpDir(): string {
	const d = mkdtempSync(join(tmpdir(), "cov-test-selector-w60-"));
	dirs.push(d);
	return d;
}

afterEach(() => {
	for (const d of dirs) {
		try {
			rmSync(d, { recursive: true, force: true });
		} catch (err) {
			// interlinked-ignore: empty_catch — best-effort tmp-dir cleanup, nothing actionable
			void err;
		}
	}
	dirs = [];
});

describe("selectAffectedTests — toRepoRel backslash normalization (mutant 1ad0bde4be2f63fe)", () => {
	it("recognizes a __tests__ directory segment reached via a backslash-separated dependent path", () => {
		const root = makeTmpDir();
		const editedRelPath = "src/seed.ts";
		const editedAbs = join(root, editedRelPath);
		// The dependent path uses a literal backslash as directory separator
		// (as a raw string, not a real fs separator) so toRepoRel's
		// `.replace(/\\/g, "/")` must convert it to "/" for isTestPath's
		// directory-segment check ("__tests__/") to match.
		const dependentRaw = "chain\\__tests__\\thing.test.ts";
		const depView = fakeDepView({
			hasFile: (abs) => abs === editedAbs,
			getDependents: (abs) => (abs === editedAbs ? [dependentRaw] : []),
		});
		const result = selectAffectedTests({ editedRelPath, projectRoot: root, depView });
		expect(result).toEqual(["chain/__tests__/thing.test.ts"]);
	});
});

describe("companionTestCandidates via selectAffectedTests — dot<=0 guard (287b89df4a27d4cc, 7875f7b634d41c78)", () => {
	it("returns no companion candidates and defers (null) for a leading-dot filename with no real extension", () => {
		const root = makeTmpDir();
		// A dot at index 0 must trip the `dot <= 0` early return in
		// companionTestCandidates, producing zero candidates. If instead the
		// candidate-generation path ran, it would compute stem="" and could
		// spuriously match a file named ".test.ts" placed at the root.
		writeFileSync(join(root, ".test.ts"), "// bait file");
		const depView = fakeDepView({ hasFile: () => false });
		const result = selectAffectedTests({ editedRelPath: ".ts", projectRoot: root, depView });
		expect(result).toBeNull();
	});
});

describe("companionTestCandidates via selectAffectedTests — backslash normalization (8eebd004e829bcaf)", () => {
	it("finds a nested companion when the edited path uses a backslash directory separator", () => {
		const root = makeTmpDir();
		mkdirSync(join(root, "dir"), { recursive: true });
		writeFileSync(join(root, "dir", "util.test.ts"), "// companion");
		const depView = fakeDepView({ hasFile: () => false });
		const result = selectAffectedTests({
			editedRelPath: "dir\\util.ts",
			projectRoot: root,
			depView,
		});
		expect(result).toEqual(["dir/util.test.ts"]);
	});
});

describe("companionTestCandidates via selectAffectedTests — dir slash>=0 conditional (bf4c952be21eefd9)", () => {
	it("does not prefix a directory onto the companion candidate when there is no slash in the stem", () => {
		const root = makeTmpDir();
		writeFileSync(join(root, "util.test.ts"), "// companion at root");
		const depView = fakeDepView({ hasFile: () => false });
		const result = selectAffectedTests({
			editedRelPath: "util.ts",
			projectRoot: root,
			depView,
		});
		expect(result).toEqual(["util.test.ts"]);
	});
});

describe("companionTestCandidates via selectAffectedTests — base slash>=0 equality boundary (89e55d4f2b19d0f7)", () => {
	it("strips a single leading slash from the stem when computing the base name", () => {
		const root = makeTmpDir();
		writeFileSync(join(root, "util.test.ts"), "// companion at root");
		const depView = fakeDepView({ hasFile: () => false });
		const result = selectAffectedTests({
			editedRelPath: "/util.ts",
			projectRoot: root,
			depView,
		});
		expect(result).toEqual(["util.test.ts"]);
	});
});

describe("companionTestCandidates via selectAffectedTests — __tests__ dir template (9528e5c7cac64f1b)", () => {
	it("finds a companion under <dir>/__tests__/ when the plain sibling does not exist", () => {
		const root = makeTmpDir();
		mkdirSync(join(root, "src", "__tests__"), { recursive: true });
		writeFileSync(join(root, "src", "__tests__", "util.test.ts"), "// companion");
		const depView = fakeDepView({ hasFile: () => false });
		const result = selectAffectedTests({
			editedRelPath: "src/util.ts",
			projectRoot: root,
			depView,
		});
		expect(result).toEqual(["src/__tests__/util.test.ts"]);
	});
});

describe("coveringTestsWithoutGraph overlay-path arrow — backslash normalization (47ccae7b6990c0db)", () => {
	it("matches an overlay companion whose relPath uses a backslash separator", () => {
		const root = makeTmpDir();
		const depView = fakeDepView({ hasFile: () => false });
		const result = selectAffectedTests({
			editedRelPath: "src/foo.ts",
			projectRoot: root,
			depView,
			overlaySections: [{ relPath: "src\\foo.test.ts", content: "// overlay companion" }],
		});
		expect(result).toEqual(["src/foo.test.ts"]);
	});
});

describe("coveringTestsWithoutGraph overlay-path arrow — full replacement (0e11dec7b88633fd)", () => {
	it("matches a plain-slash overlay companion path (no disk file, no needle content)", () => {
		const root = makeTmpDir();
		const depView = fakeDepView({ hasFile: () => false });
		const result = selectAffectedTests({
			editedRelPath: "src/foo.ts",
			projectRoot: root,
			depView,
			overlaySections: [{ relPath: "src/foo.test.ts", content: "unrelated content" }],
		});
		expect(result).toEqual(["src/foo.test.ts"]);
	});
});

describe("coveringTestsWithoutGraph needle logic — split('/') literal (0b845bca46c9af55)", () => {
	it("matches an overlay test whose content references the edited file's basename via a path segment", () => {
		const root = makeTmpDir();
		const depView = fakeDepView({ hasFile: () => false });
		const result = selectAffectedTests({
			editedRelPath: "src/dir/comp.ts",
			projectRoot: root,
			depView,
			overlaySections: [
				{ relPath: "tests/other.test.ts", content: "something referencing /comp. here" },
			],
		});
		expect(result).toEqual(["tests/other.test.ts"]);
	});
});

describe("coveringTestsWithoutGraph needle logic — extension-stripping regex anchor (25548db4015e0378)", () => {
	it("strips only the trailing extension, keeping an embedded dot segment in the needle", () => {
		const root = makeTmpDir();
		const depView = fakeDepView({ hasFile: () => false });
		const result = selectAffectedTests({
			editedRelPath: "src/dir/comp.util.ts",
			projectRoot: root,
			depView,
			overlaySections: [
				{ relPath: "tests/other.test.ts", content: "reference to /comp.util. right here" },
			],
		});
		expect(result).toEqual(["tests/other.test.ts"]);
	});
});

describe("coveringTestsWithoutGraph needle logic — leading slash in needle (d0556637a850ec55)", () => {
	it("requires the path-segment slash immediately before the basename, not a bare substring match", () => {
		const root = makeTmpDir();
		const depView = fakeDepView({ hasFile: () => false });
		const result = selectAffectedTests({
			editedRelPath: "src/dir/comp.util.ts",
			projectRoot: root,
			depView,
			overlaySections: [
				// contains "comp.util." but NOT preceded by "/" (preceded by "x")
				{ relPath: "tests/other.test.ts", content: "xcomp.util. extra text" },
			],
		});
		expect(result).toBeNull();
	});
});

describe("coveringTestsWithoutGraph needle logic — base.length>0 guard (612f63c21601ec00, a68b08df69784d91)", () => {
	it("skips the needle scan entirely when the basename strips down to empty", () => {
		const root = makeTmpDir();
		const depView = fakeDepView({ hasFile: () => false });
		const result = selectAffectedTests({
			editedRelPath: "src/dir/.ts",
			projectRoot: root,
			depView,
			overlaySections: [{ relPath: "tests/other.test.ts", content: "blah /. blah" }],
		});
		expect(result).toBeNull();
	});
});

describe("selectAffectedTests new-file branch — sort() on the covering set (20e75db2b29bcb99)", () => {
	it("returns companions in sorted order, not discovery/insertion order", () => {
		const root = makeTmpDir();
		// companionTestCandidates checks the `.test.` candidate before the
		// `.spec.` candidate, so insertion order is [test, spec] — the
		// reverse of alphabetical ([spec, test]).
		writeFileSync(join(root, "z.test.ts"), "// t");
		writeFileSync(join(root, "z.spec.ts"), "// s");
		const depView = fakeDepView({ hasFile: () => false });
		const result = selectAffectedTests({
			editedRelPath: "z.ts",
			projectRoot: root,
			depView,
		});
		expect(result).toEqual(["z.spec.ts", "z.test.ts"]);
	});
});

describe("selectAffectedTests main BFS — queue seeded with the edited file (1667a92d12781c74)", () => {
	it("discovers a direct dependent of the edited file", () => {
		const root = makeTmpDir();
		const editedRelPath = "src/seed.ts";
		const editedAbs = join(root, editedRelPath);
		const depTestAbs = join(root, "tests", "dep.test.ts");
		const depView = fakeDepView({
			hasFile: (abs) => abs === editedAbs,
			getDependents: (abs) => (abs === editedAbs ? [depTestAbs] : []),
		});
		const result = selectAffectedTests({ editedRelPath, projectRoot: root, depView });
		expect(result).toEqual(["tests/dep.test.ts"]);
	});
});

describe("selectAffectedTests main BFS — hop cap equality boundary (24e849d34070c06f)", () => {
	it("truncates (returns null) exactly at the documented MAX_TRANSITIVE_HOPS boundary", () => {
		const root = makeTmpDir();
		const MAX = 1000;
		// Build a linear chain of MAX+1 nodes: node[0] is the edited file,
		// node[k] -> node[k+1] for k in 0..MAX-1, and node[MAX] is a leaf
		// (no further dependents). Processing node[MAX-1] (the MAX-th
		// iteration, head=MAX-1) reveals node[MAX] but never expands it
		// under the correct `<` bound, so node[MAX] is left "discovered but
		// unprocessed" and the walk must report itself as truncated (null).
		const nodePaths: string[] = [];
		for (let i = 0; i <= MAX; i++) {
			nodePaths.push(join(root, "chain", `n${i}.ts`));
		}
		const depView = fakeDepView({
			hasFile: (abs) => abs === nodePaths[0],
			getDependents: (abs) => {
				const idx = nodePaths.indexOf(abs);
				if (idx >= 0 && idx < MAX) return [nonNull(nodePaths[idx + 1])];
				return [];
			},
		});
		const result = selectAffectedTests({
			editedRelPath: "chain/n0.ts",
			projectRoot: root,
			depView,
		});
		expect(result).toBeNull();
	});
});
