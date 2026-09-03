import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import { checkCodeClones } from "./dry-check.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dry-check-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const cloneBody = `{
	const out = [];
	for (const row of rows) {
		if (row.enabled) {
			out.push(row.value);
		}
	}
	return out;
}`;

describe("checkCodeClones", () => {
	it("P1: flags two near-identical functions in the same file", () => {
		const content = `
function collectA(rows: Row[]): number[] ${cloneBody}
function collectB(rows: Row[]): number[] ${cloneBody}
`;
		const file = join(dir, "collect.ts");
		writeFileSync(file, content);
		const matches = checkCodeClones(content, file);
		expect(matches.length).toBeGreaterThanOrEqual(1);
		expect(nonNull(matches[0]).text).toContain("similar to");
	});

	it("P2: flags a clone living in a sibling file", () => {
		const editedContent = `
function collectA(rows: Row[]): number[] ${cloneBody}
`;
		const siblingContent = `
function collectZ(rows: Row[]): number[] ${cloneBody}
`;
		const editedFile = join(dir, "a.ts");
		const siblingFile = join(dir, "b.ts");
		writeFileSync(editedFile, editedContent);
		writeFileSync(siblingFile, siblingContent);
		const matches = checkCodeClones(editedContent, editedFile);
		expect(matches.length).toBe(1);
		expect(nonNull(matches[0]).text).toContain("b.ts");
	});

	it("N1: does not fire on non-JS/TS files (extension guard)", () => {
		expect(checkCodeClones("whatever", join(dir, "notes.md"))).toEqual([]);
	});

	it("N2: does not fire on files with no duplicated functions", () => {
		const content = `
function uniqueOne(x: number): number {
	const a = x + 1;
	const b = a * 2;
	const c = b - 3;
	return c;
}
`;
		const file = join(dir, "unique.ts");
		writeFileSync(file, content);
		expect(checkCodeClones(content, file)).toEqual([]);
	});

	it("N3: does not pair a function with a callback nested inside its own span", () => {
		// The outer function's body literally contains the inner arrow's
		// tokens, so naive Jaccard similarity is near-1.0 by construction —
		// this must never be reported as a clone pair.
		const content = `
function loadRows(rows: Row[]): number[] ${cloneBody}
`;
		const file = join(dir, "nested-own-closure.ts");
		writeFileSync(file, content);
		expect(checkCodeClones(content, file)).toEqual([]);
	});

	it("P5: still flags two anonymous callbacks nested under the same parent when their bodies are genuinely identical", () => {
		// Adversarial case: two `forEach(function (row) {...})` siblings under
		// one parent, with byte-for-byte identical bodies -- a real DRY
		// violation. `isNestingNoisePair` must NOT suppress this: sharing an
		// enclosing parent gives no structural guarantee of token-set
		// containment the way actual nesting does, so it is not detector
		// noise and must still fire.
		const content = `
function processAll(rowsA: Row[], rowsB: Row[]) {
	rowsA.forEach(function (row) {
		const out = [];
		for (const r of row.items) {
			if (r.enabled) {
				out.push(r.value);
			}
		}
		return out;
	});
	rowsB.forEach(function (row) {
		const out = [];
		for (const r of row.items) {
			if (r.enabled) {
				out.push(r.value);
			}
		}
		return out;
	});
}
`;
		const file = join(dir, "sibling-callbacks.ts");
		writeFileSync(file, content);
		const matches = checkCodeClones(content, file);
		expect(matches.some((m) => m.text.includes("(callback)"))).toBe(true);
	});

	it("P3: still flags two named same-file functions with equivalent bodies (not nested)", () => {
		const content = `
function collectA(rows: Row[]): number[] ${cloneBody}
function collectB(rows: Row[]): number[] ${cloneBody}
`;
		const file = join(dir, "siblings.ts");
		writeFileSync(file, content);
		const matches = checkCodeClones(content, file);
		expect(matches.length).toBe(1);
		expect(nonNull(matches[0]).text).toContain("collectB");
	});

	it("P4: a finding carries a non-empty detail", () => {
		const content = `
function collectA(rows: Row[]): number[] ${cloneBody}
function collectB(rows: Row[]): number[] ${cloneBody}
`;
		const file = join(dir, "detail.ts");
		writeFileSync(file, content);
		const matches = checkCodeClones(content, file);
		expect(matches.length).toBeGreaterThanOrEqual(1);
		const detail = nonNull(matches[0]).detail;
		expect(detail?.length).toBeGreaterThan(0);
		expect(detail).toContain("collectA");
		expect(detail).toContain("collectB");
	});
});
