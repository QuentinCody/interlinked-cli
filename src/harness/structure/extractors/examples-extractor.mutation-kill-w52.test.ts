import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyFile, extract, metadata } from "./examples-extractor.js";
import type { WalkBudget } from "./bounded-walk.js";

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "examples-extractor-w52-"));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── classifyFile — symbol 0911c1aae4b77d1e ──────────────────────────────────

describe("classifyFile — positive (must fire)", () => {
	it("kills LogicalOperator: a non-'.' dir with no EXAMPLE_DIRS segment must NOT produce a node", () => {
		// dir === "lib" (not ".") so the first disjunct is false; the second
		// disjunct is true (no segment matches EXAMPLE_DIRS) so the || short
		// circuits to true and the file is correctly skipped. Under &&, the
		// false first operand would force the whole expression false, wrongly
		// treating "lib/foo.txt" as an example.
		const result = classifyFile("/repo", "lib/foo.txt");
		expect(result).toEqual({ nodes: [], edges: [] });
	});

	it("kills ArrayDeclaration in the early-return branch: skipped files return an empty node array, not a poisoned one", () => {
		const result = classifyFile("/repo", "lib/foo.txt");
		expect(result.nodes).toEqual([]);
	});

	it("kills 'sample' StringLiteral in EXAMPLE_DIRS: a file under sample/ must be classified as an example", () => {
		const result = classifyFile("/repo", "sample/foo.txt");
		expect(result.nodes).toHaveLength(1);
	});

	it("strips only the LAST extension on a multi-dot path (kills Regex mutant dropping the $ anchor)", () => {
		const result = classifyFile("/repo", "examples/foo.test.ts");
		expect(result.nodes).toHaveLength(1);
		expect(result.nodes[0]?.id).toContain("examples-foo.test");
		expect(result.nodes[0]?.id).not.toContain(".ts");
	});

	it("fully strips a single extension and joins dirs with '-' (kills the ext-regex char-class/quantifier mutants, the '-' literal, and the '' replacement literal)", () => {
		const result = classifyFile("/repo", "examples/bar.ts");
		expect(result.nodes).toHaveLength(1);
		const node = result.nodes[0]!;
		expect(node.id).toContain("examples-bar");
		expect(node.id).not.toMatch(/\.ts$/);
		expect(node.label).toBe("examples/bar.ts");
		expect(node.file).toBe("examples/bar.ts");
	});

	it("sets kind, provenance, and determinism_ceiling to their exact literal values", () => {
		const result = classifyFile("/repo", "examples/bar.ts");
		const node = result.nodes[0]!;
		expect(node.kind).toBe("example");
		expect(node.provenance).toBe("inferred");
		expect(node.determinism_ceiling).toBe("heuristic");
	});

	it("returns an empty edges array for a matched example file (kills the second ArrayDeclaration mutant)", () => {
		const result = classifyFile("/repo", "examples/bar.ts");
		expect(result.edges).toEqual([]);
	});
});

// ── extract() / walkDir() — filesystem walk behavior ────────────────────────

function makeBudget(overrides: Partial<WalkBudget>): WalkBudget {
	return {
		entriesVisited: 0,
		deadline: performance.now() + 100_000,
		truncated: false,
		...overrides,
	};
}

describe("extract — positive (must fire)", () => {
	it("kills the entry-budget short-circuit mutant: an already-truncated budget must stop the walk before it visits anything", () => {
		fs.mkdirSync(path.join(tmpDir, "examples"), { recursive: true });
		fs.writeFileSync(path.join(tmpDir, "examples", "foo.txt"), "x");
		const budget = makeBudget({ truncated: true });
		const result = extract(tmpDir, budget);
		expect(result.nodes).toEqual([]);
	});

	it("kills entry.isFile()->true: a broken symlink (neither file nor directory) inside examples/ must not produce a node", () => {
		const examplesDir = path.join(tmpDir, "examples");
		fs.mkdirSync(examplesDir, { recursive: true });
		fs.symlinkSync(path.join(tmpDir, "does-not-exist"), path.join(examplesDir, "linky"));
		const result = extract(tmpDir);
		expect(result.nodes).toEqual([]);
	});

	it("still finds a real file after a broken symlink sibling (control case for the isFile() mutant)", () => {
		const examplesDir = path.join(tmpDir, "examples");
		fs.mkdirSync(examplesDir, { recursive: true });
		fs.symlinkSync(path.join(tmpDir, "does-not-exist"), path.join(examplesDir, "linky"));
		fs.writeFileSync(path.join(examplesDir, "real.txt"), "x");
		const result = extract(tmpDir);
		expect(result.nodes).toHaveLength(1);
	});

	it("kills the post-recursion truncated-check mutant: iteration must stop, not continue to the next sibling, once truncated mid-recursion", () => {
		// Two symmetric top-level subdirectories, each with exactly one file.
		// Whichever is visited first: its own directory-entry consumption is
		// call #1, and the file inside it is call #2. Priming entriesVisited
		// to 510 makes call #2 land on the 512th overall visit, which trips
		// the (already-expired) deadline and sets budget.truncated = true
		// mid-recursion. The real code then returns immediately without
		// touching the second subdirectory at all (entriesVisited stays 512).
		// A mutant that guts the post-recursion truncated check keeps
		// iterating to the second subdirectory, consuming one more entry
		// (513) before the per-entry gate finally catches it.
		fs.mkdirSync(path.join(tmpDir, "a_dir"));
		fs.writeFileSync(path.join(tmpDir, "a_dir", "x.txt"), "x");
		fs.mkdirSync(path.join(tmpDir, "z_dir"));
		fs.writeFileSync(path.join(tmpDir, "z_dir", "y.txt"), "y");

		const budget = makeBudget({ entriesVisited: 510, deadline: performance.now() - 1_000 });
		extract(tmpDir, budget);
		expect(budget.entriesVisited).toBe(512);
	});

	it("warns via stderr when the walk is actually truncated", () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		try {
			fs.mkdirSync(path.join(tmpDir, "examples"), { recursive: true });
			fs.writeFileSync(path.join(tmpDir, "examples", "foo.txt"), "x");
			const budget = makeBudget({ truncated: true });
			extract(tmpDir, budget);
			expect(spy).toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});

	it("kills the extract() edges-array literal and the never-truncated inversion: a normal small walk yields edges: [] and never warns", () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		try {
			fs.mkdirSync(path.join(tmpDir, "examples"), { recursive: true });
			fs.writeFileSync(path.join(tmpDir, "examples", "foo.txt"), "x");
			const result = extract(tmpDir);
			expect(result.edges).toEqual([]);
			expect(spy).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});
});

// ── metadata — module-level literals ─────────────────────────────────────────

describe("metadata — positive (must fire)", () => {
	it("has the exact supported_patterns array", () => {
		expect(metadata.supported_patterns).toEqual(["examples/**", "sample/**", "samples/**", "demo/**"]);
	});

	it("has the exact output_kinds array", () => {
		expect(metadata.output_kinds).toEqual(["example"]);
	});

	it("has provenance 'inferred' and max_determinism 'heuristic'", () => {
		expect(metadata.provenance).toBe("inferred");
		expect(metadata.max_determinism).toBe("heuristic");
	});
});
