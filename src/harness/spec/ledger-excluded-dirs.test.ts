import { describe, expect, it } from "vitest";
import {
	EXCLUDED_DIRS,
	FACT_FINDING_CAP,
	FACT_SUMMARY_CAP,
	MAX_DEPTH,
	MAX_FILES,
	MAX_FILE_BYTES,
} from "./ledger-excluded-dirs.js";

describe("ledger-excluded-dirs", () => {
	it("excludes common non-source directories from the bounded walk", () => {
		expect(EXCLUDED_DIRS.has("node_modules")).toBe(true);
		expect(EXCLUDED_DIRS.has(".git")).toBe(true);
		expect(EXCLUDED_DIRS.has("dist")).toBe(true);
		expect(EXCLUDED_DIRS.has("src")).toBe(false);
	});

	it("bounds walk size, depth, and per-file bytes", () => {
		expect(MAX_FILES).toBe(500);
		expect(MAX_FILE_BYTES).toBe(2 * 1024 * 1024);
		expect(MAX_DEPTH).toBe(8);
	});

	it("bounds declared-fact-drift summary/finding output", () => {
		expect(FACT_SUMMARY_CAP).toBe(8);
		expect(FACT_FINDING_CAP).toBe(10);
	});
});
