import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import { DEFAULT_SIMILARITY_THRESHOLD, extractFunctionShingles, jaccard } from "./dry.js";
import {
	checkExtractedHelperDuplicate,
	checkNewExportWithoutImporter,
	findExtractedHelperDuplicates,
	findNewExportsWithoutImporter,
	HELPER_DUPLICATE_THRESHOLD,
} from "./helper-hygiene.js";

// Both detectors are edit-time (pre_warn) nudges about helper extraction:
// the pure cores take the pre-edit content explicitly; the registry wrappers
// read it from disk (at PreToolUse the on-disk file IS the pre-edit state).

function repo(files: Record<string, string>) {
	return {
		listFiles: () => Object.keys(files),
		readFile: (p: string) => files[p] ?? null,
	};
}

const BEFORE = "export function main(): number {\n\treturn 1;\n}\n";
const AFTER = `${BEFORE}export function helper(): number {\n\treturn 2;\n}\n`;

const args = (content: string, preContent: string | null, filePath = "src/lib.ts") => ({
	content,
	filePath,
	preContent,
	cwd: "/repo",
});

// ===========================================
// new_export_without_importer
// ===========================================

describe("findNewExportsWithoutImporter — positive (must fire)", () => {
	it("P1: an edit that adds an export nothing imports fires with the module-private nudge", () => {
		const files = { "src/lib.ts": BEFORE, "src/main.ts": 'import { main } from "./lib.js";\nmain();\n' };
		const out = findNewExportsWithoutImporter(args(AFTER, BEFORE), repo(files));
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).line).toBe(4);
		expect(nonNull(out[0]).text).toContain("'helper'");
		expect(nonNull(out[0]).text).toContain("no importer");
		expect(nonNull(out[0]).text).toContain("module-private");
	});

	it("P2: an export imported ONLY by its test file still fires — test through the caller", () => {
		const files = {
			"src/lib.ts": BEFORE,
			"src/main.ts": 'import { main } from "./lib.js";\nmain();\n',
			"src/lib.test.ts": 'import { helper } from "./lib.js";\nhelper();\n',
		};
		const out = findNewExportsWithoutImporter(args(AFTER, BEFORE), repo(files));
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).text).toContain("only by tests");
	});

	it("P3: introduced-only — a pre-existing dead export stays silent, only the new one fires", () => {
		const before = `${BEFORE}export const legacyDead = 1;\n`;
		const after = `${before}export function helper(): number {\n\treturn 2;\n}\n`;
		const files = { "src/lib.ts": before, "src/main.ts": 'import { main } from "./lib.js";\nmain();\n' };
		const out = findNewExportsWithoutImporter(args(after, before), repo(files));
		expect(out.map((m) => m.line)).toEqual([5]);
	});

	it("P4: an export removed and a DIFFERENT-bodied export added is not a rename — fires", () => {
		const before = `${BEFORE}export function old(): number {\n\treturn 2;\n}\n`;
		const after = `${BEFORE}export function fresh(): number {\n\treturn 3;\n}\n`;
		const files = { "src/lib.ts": before, "src/main.ts": 'import { main } from "./lib.js";\nmain();\n' };
		const out = findNewExportsWithoutImporter(args(after, before), repo(files));
		expect(out.map((m) => m.text)).toEqual([expect.stringContaining("'fresh'")]);
	});

	it("P5: a file already carrying ten dead exports cannot truncate the new one out (MAX_FLAGGED applies to introduced names only)", () => {
		const dead = Array.from({ length: 10 }, (_, i) => `export const dead${i} = ${i};`).join("\n");
		const before = `${BEFORE}${dead}\n`;
		const after = `${before}export function helper(): number {\n\treturn 2;\n}\n`;
		const files = { "src/lib.ts": before, "src/main.ts": 'import { main } from "./lib.js";\nmain();\n' };
		const out = findNewExportsWithoutImporter(args(after, before), repo(files));
		expect(out.map((m) => m.text)).toEqual([expect.stringContaining("'helper'")]);
	});
});

describe("findNewExportsWithoutImporter — negative (must not fire)", () => {
	it("N1: the new export is imported by a non-test sibling", () => {
		const files = {
			"src/lib.ts": BEFORE,
			"src/main.ts": 'import { helper, main } from "./lib.js";\nmain();\nhelper();\n',
		};
		expect(findNewExportsWithoutImporter(args(AFTER, BEFORE), repo(files))).toEqual([]);
	});

	it("N2: a brand-new file is exempt — the exporter-first rule guarantees zero importers yet", () => {
		const files = { "src/main.ts": "export const x = 1;\n" };
		expect(findNewExportsWithoutImporter(args(AFTER, null), repo(files))).toEqual([]);
	});

	it("N3: no export was introduced (content equals the on-disk state)", () => {
		const files = { "src/lib.ts": AFTER, "src/main.ts": "export const x = 1;\n" };
		expect(findNewExportsWithoutImporter(args(AFTER, AFTER), repo(files))).toEqual([]);
	});

	it("N4: a 'public API' comment above the new export marks it a deliberate seam", () => {
		const after = `${BEFORE}// public API — reusable seam for sibling packages\nexport function helper(): number {\n\treturn 2;\n}\n`;
		const files = { "src/lib.ts": BEFORE, "src/main.ts": 'import { main } from "./lib.js";\nmain();\n' };
		expect(findNewExportsWithoutImporter(args(after, BEFORE), repo(files))).toEqual([]);
	});

	it("N5: a new TYPE-only export is not a helper — silent", () => {
		const after = `${BEFORE}export interface Shape {\n\tid: string;\n}\n`;
		const files = { "src/lib.ts": BEFORE, "src/main.ts": 'import { main } from "./lib.js";\nmain();\n' };
		expect(findNewExportsWithoutImporter(args(after, BEFORE), repo(files))).toEqual([]);
	});

	it("N6: a test file gaining an export is silent", () => {
		const files = { "src/lib.test.ts": BEFORE };
		expect(
			findNewExportsWithoutImporter(args(AFTER, BEFORE, "src/lib.test.ts"), repo(files)),
		).toEqual([]);
	});

	it("N7: a production module under this package's own detector tree is a consumer, not a test", () => {
		// `isTestFile` is the pattern-data alias: it also names src/harness/checks/**.
		// A consumer there must count as use — the strict test predicate decides.
		const files = {
			"src/lib.ts": BEFORE,
			"src/harness/checks/consumer.ts": 'import { helper, main } from "../../lib.js";\nmain();\nhelper();\n',
		};
		expect(findNewExportsWithoutImporter(args(AFTER, BEFORE), repo(files))).toEqual([]);
	});

	it("N8: renaming an export (removed + same-bodied one added in one edit) is not a new export", () => {
		const before = `${BEFORE}export function helper(): number {\n\tconst v = helper.length;\n\treturn v + 2;\n}\n`;
		const after = `${BEFORE}export function helperRenamed(): number {\n\tconst v = helperRenamed.length;\n\treturn v + 2;\n}\n`;
		const files = {
			"src/lib.ts": before,
			"src/main.ts": 'import { helper, main } from "./lib.js";\nmain();\nhelper();\n',
		};
		expect(findNewExportsWithoutImporter(args(after, before), repo(files))).toEqual([]);
	});
});

// ===========================================
// extracted_helper_duplicate
// ===========================================

const COLLECT_BODY = `{
	const out: number[] = [];
	for (const row of rows) {
		if (row.enabled) {
			out.push(row.value);
		}
	}
	return out;
}`;

const SIBLING_SRC = `export function collectEnabled(rows: Row[]): number[] ${COLLECT_BODY}\n`;

/** ~70 shingles: one changed token here lands between the two thresholds. */
const LONG_BODY = `{
	const out: number[] = [];
	for (const row of rows) {
		if (row.enabled) {
			out.push(row.value);
		}
	}
	out.sort((x, y) => x - y);
	return out.slice(0, limit);
}`;

/** Larger body (~135 shingles) so a single renamed identifier lands inside
 *  the [0.90, 0.99) "renamed/edited copy" band instead of the move band. */
const NEAR_BODY = `{
	const out: number[] = [];
	for (const row of rows) {
		if (row.enabled) {
			out.push(row.value);
		}
	}
	out.sort((x, y) => x - y);
	const filtered = out.filter((v) => v > 0);
	const doubled = filtered.map((v) => v * 2);
	const total = doubled.reduce((acc, v) => acc + v, 0);
	console.log(total);
	return doubled.slice(0, limit);
}`;
const NEAR_SIBLING_SRC = `export function collectTop(rows: Row[], limit: number): number[] ${NEAR_BODY}\n`;
const NEAR_VARIANT = `function pickTop(rows: Row[], limit: number): number[] ${NEAR_BODY.replace("row.value", "row.amount")}\n`;

function siblingCandidates(file = "/repo/src/sibling.ts") {
	return () => extractFunctionShingles(SIBLING_SRC, file);
}

const EDITED = "/repo/src/edited.ts";
const OTHER_FN = "export function unrelated(): string {\n\treturn 'x';\n}\n";
const EXTRACTED = `${OTHER_FN}function pickEnabled(rows: Row[]): number[] ${COLLECT_BODY}\n`;
/** Same name + signature as `SIBLING_SRC`'s function: a byte-for-byte move,
 *  not a renamed re-extraction (jaccard 1.0, vs ~0.91 for `EXTRACTED`, whose
 *  differing name/keywords also show up as body-line tokens). */
const MOVED = `${OTHER_FN}export function collectEnabled(rows: Row[]): number[] ${COLLECT_BODY}\n`;

describe("findExtractedHelperDuplicates — positive (must fire)", () => {
	it("P1: a genuine re-extraction (93% similar, renamed/edited — not verbatim) names the existing sibling and keeps the import-it remedy", () => {
		const sib = nonNull(extractFunctionShingles(NEAR_SIBLING_SRC, "/repo/src/sibling.ts")[0]);
		const mine = nonNull(
			extractFunctionShingles(NEAR_VARIANT, EDITED).find((f) => f.name === "pickTop"),
		);
		const sim = jaccard(mine.shingles, sib.shingles);
		expect(sim).toBeGreaterThanOrEqual(HELPER_DUPLICATE_THRESHOLD);
		expect(sim).toBeLessThan(0.99);
		const out = findExtractedHelperDuplicates(
			{ content: `${OTHER_FN}${NEAR_VARIANT}`, filePath: EDITED, preContent: OTHER_FN },
			() => [sib],
		);
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).text).toContain("pickTop()");
		expect(nonNull(out[0]).text).toContain("already exists as collectTop()");
		expect(nonNull(out[0]).text).toContain("sibling.ts:1");
		expect(nonNull(out[0]).text).toContain("import it instead of extracting a second copy");
		expect(nonNull(out[0]).text).not.toContain("move in progress");
	});

	it("P2: a brand-new module carrying 5 byte-identical sibling functions is one move-in-progress finding, not five extraction remedies", () => {
		// Distinct bodies per function so the within-file self-compare in
		// findClones never out-ranks the cross-file sibling match.
		const movedBody = (i: number) => `{
	const out: number[] = [];
	for (const row of rows) {
		if (row.enabled) {
			out.push(row.value * ${i});
		}
	}
	return out;
}`;
		const names = ["alpha", "bravo", "charlie", "delta", "echo"];
		const fns = names.map((name, i) => `export function ${name}(rows: Row[]): number[] ${movedBody(i + 1)}`).join("\n");
		const sibling = names.map((name, i) => `export function ${name}(rows: Row[]): number[] ${movedBody(i + 1)}`).join("\n");
		const out = findExtractedHelperDuplicates(
			{ content: fns, filePath: EDITED, preContent: null },
			() => extractFunctionShingles(sibling, "/repo/src/sibling.ts"),
		);
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).text).toContain("move in progress: 5 function(s) byte-identical to sibling.ts");
		expect(nonNull(out[0]).text).toContain("delete the originals from sibling.ts");
		expect(nonNull(out[0]).text).not.toContain("import it instead");
	});

	it("P3: an edited (non-new) file adding one byte-identical copy of a sibling helper is a move in progress", () => {
		const out = findExtractedHelperDuplicates(
			{ content: MOVED, filePath: EDITED, preContent: OTHER_FN },
			siblingCandidates(),
		);
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).text).toContain("move in progress: 1 function(s) byte-identical to sibling.ts");
		expect(nonNull(out[0]).text).not.toContain("import it instead");
	});

});

describe("findExtractedHelperDuplicates — negative (must not fire)", () => {
	it("N1: the duplicate already existed before this edit (not introduced) — silent", () => {
		const out = findExtractedHelperDuplicates(
			{ content: EXTRACTED, filePath: EDITED, preContent: EXTRACTED },
			siblingCandidates(),
		);
		expect(out).toEqual([]);
	});

	it("N2: a same-file near-duplicate is code_clones' job, not this check's — silent", () => {
		const twoCopies = `function a(rows: Row[]): number[] ${COLLECT_BODY}\nfunction b(rows: Row[]): number[] ${COLLECT_BODY}\n`;
		const out = findExtractedHelperDuplicates(
			{ content: twoCopies, filePath: EDITED, preContent: null },
			() => [],
		);
		expect(out).toEqual([]);
	});

	it("N3: a pair in the code_clones band (0.82 <= J < 0.90) is a clone, not 'the same helper' — silent", () => {
		// One changed condition in a ~70-shingle body lands at J ~= 0.85:
		// code_clones flags it on the post-edit audit; this check must not.
		const sibling = `export function topEnabled(rows: Row[], limit: number): number[] ${LONG_BODY}\n`;
		const variant = `${OTHER_FN}function topDisabled(rows: Row[], limit: number): number[] ${LONG_BODY.replace("row.enabled", "row.disabled")}\n`;
		const sib = nonNull(extractFunctionShingles(sibling, "/repo/src/sibling.ts")[0]);
		const mine = nonNull(
			extractFunctionShingles(variant, EDITED).find((f) => f.name === "topDisabled"),
		);
		const sim = jaccard(mine.shingles, sib.shingles);
		expect(sim).toBeGreaterThanOrEqual(DEFAULT_SIMILARITY_THRESHOLD);
		expect(sim).toBeLessThan(HELPER_DUPLICATE_THRESHOLD);
		const out = findExtractedHelperDuplicates(
			{ content: variant, filePath: EDITED, preContent: OTHER_FN },
			() => [sib],
		);
		expect(out).toEqual([]);
	});

	it("N4: a test file is never scanned", () => {
		const out = findExtractedHelperDuplicates(
			{ content: EXTRACTED, filePath: "/repo/src/edited.test.ts", preContent: null },
			siblingCandidates(),
		);
		expect(out).toEqual([]);
	});

	it("N5: a tiny new helper (under the clone size floor) is silent", () => {
		const tiny = `${OTHER_FN}function id(x: number): number {\n\treturn x;\n}\n`;
		const out = findExtractedHelperDuplicates(
			{ content: tiny, filePath: EDITED, preContent: OTHER_FN },
			() => extractFunctionShingles("export function id2(x: number): number {\n\treturn x;\n}\n", "/repo/src/s.ts"),
		);
		expect(out).toEqual([]);
	});

	it("N7: once the sibling deletes the originals, the move-in-progress finding stops firing", () => {
		// Same edited-file shape as the byte-identical move case, but the
		// sibling candidate set is now empty — the originals are gone.
		const out = findExtractedHelperDuplicates(
			{ content: EXTRACTED, filePath: EDITED, preContent: OTHER_FN },
			() => [],
		);
		expect(out).toEqual([]);
	});

	it("N6: the threshold is stricter than code_clones' 0.82", () => {
		expect(HELPER_DUPLICATE_THRESHOLD).toBe(0.9);
	});
});

// ===========================================
// Registry wrappers — disk-backed pre-edit content
// ===========================================

describe("registry wrappers — positive (must fire)", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "helper-hygiene-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("P1: checkNewExportWithoutImporter reads the on-disk file as the pre-edit baseline", () => {
		const file = join(dir, "lib.ts");
		writeFileSync(file, BEFORE);
		const out = checkNewExportWithoutImporter(AFTER, file, dir);
		expect(out.map((m) => m.line)).toEqual([4]);
	});

	it("P2: checkExtractedHelperDuplicate compares against on-disk siblings (existing file, genuine 93%-similar re-extraction → 'import it')", () => {
		writeFileSync(join(dir, "sibling.ts"), NEAR_SIBLING_SRC);
		const file = join(dir, "edited.ts");
		writeFileSync(file, OTHER_FN);
		const out = checkExtractedHelperDuplicate(`${OTHER_FN}${NEAR_VARIANT}`, file, dir);
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).text).toContain("sibling.ts:1");
		expect(nonNull(out[0]).text).toContain("import it instead");
	});

	it("P3: checkExtractedHelperDuplicate on a file not yet on disk reports the move-in-progress finding", () => {
		writeFileSync(join(dir, "sibling.ts"), SIBLING_SRC);
		const out = checkExtractedHelperDuplicate(EXTRACTED, join(dir, "edited.ts"), dir);
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).text).toContain("move in progress: 1 function(s) byte-identical to sibling.ts");
		expect(nonNull(out[0]).text).toContain("delete the originals from sibling.ts");
	});
});

describe("registry wrappers — negative (must not fire)", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "helper-hygiene-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("N1: checkNewExportWithoutImporter is silent for a file not yet on disk", () => {
		expect(checkNewExportWithoutImporter(AFTER, join(dir, "fresh.ts"), dir)).toEqual([]);
	});

	it("N2: checkExtractedHelperDuplicate is silent when the on-disk file already holds the helper", () => {
		writeFileSync(join(dir, "sibling.ts"), SIBLING_SRC);
		const file = join(dir, "edited.ts");
		writeFileSync(file, EXTRACTED);
		expect(checkExtractedHelperDuplicate(EXTRACTED, file, dir)).toEqual([]);
	});
});
