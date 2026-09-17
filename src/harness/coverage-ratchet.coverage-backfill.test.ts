import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { baselinePath, emptyBaseline, loadBaseline } from "./coverage-ratchet.js";

describe("loadBaseline — top-level shape guard (parseCoverageBaseline)", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "cov-ratchet-shape-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("N1: rejects a baseline whose top-level JSON value is an array, not an object", () => {
		// isJsonObject rejects arrays even though typeof [] === "object" — a
		// baseline file that somehow serialized as a bare array must fall
		// back to empty rather than crash on `.version` / `.files` access.
		mkdirSync(tmp, { recursive: true });
		writeFileSync(baselinePath(tmp), JSON.stringify(["not", "an", "object"]), "utf-8");
		expect(loadBaseline(tmp)).toEqual(emptyBaseline());
	});

	it("N2: rejects a baseline whose top-level JSON value is a bare string", () => {
		mkdirSync(tmp, { recursive: true });
		writeFileSync(baselinePath(tmp), JSON.stringify("just a string"), "utf-8");
		expect(loadBaseline(tmp)).toEqual(emptyBaseline());
	});

	it("N3: rejects a baseline whose top-level JSON value is null", () => {
		mkdirSync(tmp, { recursive: true });
		writeFileSync(baselinePath(tmp), "null", "utf-8");
		expect(loadBaseline(tmp)).toEqual(emptyBaseline());
	});

	it("P1: accepts a well-formed top-level object baseline (control case)", () => {
		mkdirSync(tmp, { recursive: true });
		writeFileSync(
			baselinePath(tmp),
			JSON.stringify({
				version: 1,
				updated_at: "2026-01-01",
				files: { "src/ok.ts": { lines_pct: 90, branches_pct: 70 } },
			}),
			"utf-8",
		);
		expect(loadBaseline(tmp).files).toEqual({ "src/ok.ts": { lines_pct: 90, branches_pct: 70 } });
	});

	it("P2: keeps a numeric statements_pct and functions_pct on a file entry (the newer optional metrics)", () => {
		mkdirSync(tmp, { recursive: true });
		writeFileSync(
			baselinePath(tmp),
			JSON.stringify({
				version: 1,
				updated_at: "2026-01-01",
				files: { "src/full.ts": { lines_pct: 100, branches_pct: 95, statements_pct: 98, functions_pct: 100 } },
			}),
			"utf-8",
		);
		expect(loadBaseline(tmp).files).toEqual({
			"src/full.ts": { lines_pct: 100, branches_pct: 95, statements_pct: 98, functions_pct: 100 },
		});
	});

	it("N4: drops a non-numeric statements_pct / functions_pct rather than coercing it, keeping the required fields", () => {
		mkdirSync(tmp, { recursive: true });
		writeFileSync(
			baselinePath(tmp),
			JSON.stringify({
				version: 1,
				updated_at: "2026-01-01",
				files: {
					"src/bad-optional.ts": {
						lines_pct: 80,
						branches_pct: 60,
						statements_pct: "not-a-number",
						functions_pct: "also-not-a-number",
					},
				},
			}),
			"utf-8",
		);
		const result = loadBaseline(tmp);
		expect(result.files).toEqual({ "src/bad-optional.ts": { lines_pct: 80, branches_pct: 60 } });
	});
});
