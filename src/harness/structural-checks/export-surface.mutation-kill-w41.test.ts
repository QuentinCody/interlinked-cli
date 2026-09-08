// Mutation-kill suite for export-surface.ts (wave 41, pass1_w41).
// Targets specific live survivors from scratch/fleet-r3/w41-briefs/src_harness_structural-checks_export-surface.ts.json.
// Mirrors the mocking approach of export-surface.integration.test.ts (own
// module-level mocks required for vi.mock hoisting).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import type { ProjectGraph } from "../project-graph.js";
import type { ExportedSymbol, ImportEdge } from "../types/graph.js";

let existsImpl: (p: string) => boolean = () => false;
vi.mock("node:fs", () => ({
	existsSync: (p: string) => existsImpl(p),
}));

type SpawnResult = {
	status: number | null;
	stdout?: string;
	stderr?: string;
	error?: NodeJS.ErrnoException | null;
};
let spawnImpl: () => SpawnResult = () => ({ status: 0, stdout: "", stderr: "", error: null });
const spawnSyncMock = vi.fn((..._args: unknown[]) => spawnImpl());
vi.mock("node:child_process", () => ({
	spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}));

type EngineStub = {
	projectRoot: string;
	discoverTools: () => Array<{ id: string; available: boolean }>;
	runChecks: (...args: unknown[]) => { results: Array<{ severity: string }> };
};
let engineStub: EngineStub;
vi.mock("../check-engine/index.js", () => ({
	getOrCreateEngine: (root: string) => {
		engineStub.projectRoot = engineStub.projectRoot || root;
		return engineStub;
	},
}));

import {
	checkExportRippleCompilation,
	checkExportSurface,
	checkRippleTests,
	findTestFileForSource,
} from "./export-surface.js";

function exp(name: string, kind: ExportedSymbol["kind"] = "function"): ExportedSymbol {
	return { name, kind, isTypeOnly: false, line: 1 };
}

function edge(symbols: string[], fromFile: string): ImportEdge {
	return {
		fromFile,
		toFile: "/proj/target.ts",
		specifier: "./target",
		symbols,
		isTypeOnly: false,
	};
}

function makeGraph(
	opts: {
		exports?: ExportedSymbol[];
		dependents?: string[];
		importers?: ImportEdge[];
		role?: "leaf" | "internal" | "hub" | "root";
		projectBoundary?: string;
	} = {},
): Pick<ProjectGraph, "getExports" | "getDependents" | "getImporters" | "classifyModule" | "getProjectBoundary" | "toRelative"> {
	const boundary = opts.projectBoundary ?? "/proj";
	return {
		getExports: vi.fn().mockReturnValue(opts.exports ?? []),
		getDependents: vi.fn().mockReturnValue(opts.dependents ?? []),
		getImporters: vi.fn().mockReturnValue(opts.importers ?? []),
		classifyModule: vi.fn().mockReturnValue(opts.role ?? "leaf"),
		getProjectBoundary: vi.fn().mockReturnValue(boundary),
		toRelative: vi.fn((f: string) => f.replace(`${boundary}/`, "")),
	};
}

const FILE = "/proj/target.ts";
const REL = "target.ts";

beforeEach(() => {
	existsImpl = () => false;
	spawnImpl = () => ({ status: 0, stdout: "", stderr: "", error: null });
	spawnSyncMock.mockClear();
	vi.clearAllMocks();
	engineStub = {
		projectRoot: "/proj",
		discoverTools: () => [{ id: "tsc", available: true }],
		runChecks: () => ({ results: [] }),
	};
});

afterEach(() => {
	vi.clearAllMocks();
});

describe("checkExportSurface — mutation kills", () => {
	// test-contract: public-api — the L33 early-exit only fires when
	// exportSurfaceChanged truly reports no change; killing "!x -> false".
	it("does not early-exit when exportSurfaceChanged is falsely bypassed (0b1590a9)", () => {
		// exportSurfaceChanged(old,new) reports UNCHANGED here (new has two
		// entries matching one old key each, tripping its Set-membership gap),
		// yet graph.getExports() genuinely omits "bar" — so continuing past
		// L33 (the mutant) would wrongly report a removal.
		const old = [exp("foo"), exp("bar")];
		const graph = makeGraph({
			exports: [exp("foo"), exp("foo")],
			dependents: ["/proj/a.ts"],
			importers: [edge(["bar"], "/proj/a.ts")],
		});
		expect(checkExportSurface(FILE, REL, old, graph)).toEqual([]);
	});

	// test-contract: public-api — kills both "removedExports.length===0 -> false"
	// and its BlockStatement sibling (empty-block fallthrough).
	it("early-exits on the no-removal path even with dependents+namespace importers (c4944cf4, 222f2d93)", () => {
		const graph = makeGraph({
			exports: [exp("foo"), exp("bar")],
			dependents: ["/proj/ns.ts"],
			importers: [edge([], "/proj/ns.ts")],
		});
		expect(checkExportSurface(FILE, REL, [exp("foo")], graph)).toEqual([]);
	});

	// test-contract: public-api — kills "dependents.length===0 -> false".
	it("early-exits on no-dependents even when importers exist (a837fa05)", () => {
		const graph = makeGraph({
			exports: [],
			dependents: [],
			importers: [edge(["foo"], "/proj/a.ts")],
		});
		expect(checkExportSurface(FILE, REL, [exp("foo")], graph)).toEqual([]);
	});

	// test-contract: public-api — kills ".some -> .every" on the usesRemoved check.
	it("flags an importer using ANY removed symbol, not ALL its symbols (c7d90622)", () => {
		const graph = makeGraph({
			exports: [],
			dependents: ["/proj/a.ts"],
			importers: [edge(["foo", "bar"], "/proj/a.ts")],
		});
		const out = checkExportSurface(FILE, REL, [exp("foo")], graph);
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).affectedFiles).toEqual(["/proj/a.ts"]);
	});

	// test-contract: public-api — kills the removal of `.slice(0, 6)` on the
	// affected-file list.
	it("lists only the first 6 affected files by name (b3ed11bb)", () => {
		const importers: ImportEdge[] = [];
		const dependents: string[] = [];
		for (let i = 0; i < 8; i++) {
			const f = `/proj/imp${i}.ts`;
			importers.push(edge(["foo"], f));
			dependents.push(f);
		}
		const graph = makeGraph({ exports: [], dependents, importers });
		const out = checkExportSurface(FILE, REL, [exp("foo")], graph);
		expect(nonNull(out[0]).message).toContain("imp5.ts");
		expect(nonNull(out[0]).message).not.toContain("imp6.ts");
		expect(nonNull(out[0]).message).not.toContain("imp7.ts");
	});

	// test-contract: public-api — kills the file-list join separator
	// ", " -> "" (distinct from the already-covered removedNames join).
	it("joins the affected-file list with comma-space (3cab21d1)", () => {
		const graph = makeGraph({
			exports: [],
			dependents: ["/proj/a.ts", "/proj/b.ts"],
			importers: [edge(["foo"], "/proj/a.ts"), edge(["foo"], "/proj/b.ts")],
		});
		const out = checkExportSurface(FILE, REL, [exp("foo")], graph);
		expect(nonNull(out[0]).message).toContain("a.ts, b.ts");
	});

	// test-contract: public-api — exact-message assertion kills both
	// `"" -> "Stryker was here!"` injections (hub-annotation else-branch and
	// the "and N more" else-branch) since neither literal appears in text
	// that a mere toContain/not.toContain pair would catch.
	it("produces the exact non-hub, no-truncation message text (4480b939, 1557746d)", () => {
		const graph = makeGraph({
			exports: [],
			dependents: ["/proj/a.ts"],
			importers: [edge(["foo"], "/proj/a.ts")],
			role: "leaf",
		});
		const out = checkExportSurface(FILE, REL, [exp("foo")], graph);
		expect(nonNull(out[0]).message).toBe(
			"Removed export(s) `foo` from target.ts. These files import them: a.ts. Update or remove the stale imports.",
		);
	});

	// test-contract: public-api — kills both the `e.name !== "*" -> true`
	// filter-condition mutant (L39) and the `"*" -> ""` string-literal mutant
	// (L39): with either mutation the "*" entry survives the removedExports
	// filter and (because an importer's symbols include the literal string
	// "*") gets reported as a broken import, which real code never does.
	it("never treats a wildcard export entry as a real removal (b90a0017, d04640ce, source L39)", () => {
		const old = [exp("foo"), exp("*", "namespace")];
		const graph = makeGraph({
			exports: [exp("foo")],
			dependents: ["/proj/a.ts"],
			importers: [edge(["*"], "/proj/a.ts")],
		});
		expect(checkExportSurface(FILE, REL, old, graph)).toEqual([]);
	});
});

describe("checkExportRippleCompilation — mutation kills", () => {
	// test-contract: public-api — kills "affectedFiles.length===0 -> false"
	// by proving the function never touches the engine when there's nothing
	// to check (not merely that the final result happens to be empty).
	it("never resolves the project boundary or engine when affectedFiles is empty (0f9c4435)", () => {
		const graph = makeGraph();
		checkExportRippleCompilation(FILE, REL, [], graph);
		expect(graph.getProjectBoundary).not.toHaveBeenCalled();
	});

	// test-contract: public-api — kills the tsc-availability guard mutant by
	// proving runChecks is never invoked when tsc is unavailable, even though
	// it WOULD report errors if called.
	it("never runs checks when tsc is unavailable (26a8b400)", () => {
		engineStub.discoverTools = () => [{ id: "tsc", available: false }];
		const runChecks = vi.fn(() => ({ results: [{ severity: "error" }] }));
		engineStub.runChecks = runChecks;
		const graph = makeGraph();
		const out = checkExportRippleCompilation(FILE, REL, ["/proj/a.ts"], graph);
		expect(out).toEqual([]);
		expect(runChecks).not.toHaveBeenCalled();
	});

	// test-contract: public-api — kills the "\n" -> "" join-separator on the
	// per-broken-file detail lines.
	it("joins multiple broken-file detail lines with newline (37331d8e)", () => {
		engineStub.runChecks = vi.fn(() => ({ results: [{ severity: "error" }] }));
		const graph = makeGraph();
		const out = checkExportRippleCompilation(FILE, REL, ["/proj/a.ts", "/proj/b.ts"], graph);
		expect(nonNull(out[0]).detail).toContain("a.ts: 1 error(s)\n  b.ts: 1 error(s)");
	});

	// test-contract: boundary — kills "> RIPPLE_MAX_FILES -> >=" at the exact
	// boundary where affectedFiles.length === RIPPLE_MAX_FILES (5).
	it("does not append a skip suffix when exactly RIPPLE_MAX_FILES were checked (584c1d59)", () => {
		engineStub.runChecks = vi.fn(() => ({ results: [{ severity: "error" }] }));
		const affected = Array.from({ length: 5 }, (_, i) => `/proj/imp${i}.ts`);
		const graph = makeGraph();
		const out = checkExportRippleCompilation(FILE, REL, affected, graph);
		expect(nonNull(out[0]).detail).not.toContain("not checked");
	});

	// test-contract: public-api — exact-detail assertion kills the
	// `"" -> "Stryker was here!"` skip-suffix else-branch mutant.
	it("produces the exact detail text with no skip suffix (66576d60)", () => {
		engineStub.runChecks = () => ({
			results: [{ severity: "error" }, { severity: "error" }],
		});
		const graph = makeGraph();
		const out = checkExportRippleCompilation(FILE, REL, ["/proj/a.ts"], graph);
		expect(nonNull(out[0]).detail).toBe("  a.ts: 2 error(s)");
	});

	// test-contract: public-api — kills the `t.id === "tsc" -> true` mutant
	// by placing tsc second in the tool list behind an unavailable tool.
	it("locates the tsc entry by id, not merely the first tool (e22e8ea4)", () => {
		engineStub.discoverTools = () => [
			{ id: "biome", available: false },
			{ id: "tsc", available: true },
		];
		engineStub.runChecks = () => ({ results: [{ severity: "error" }] });
		const graph = makeGraph();
		const out = checkExportRippleCompilation(FILE, REL, ["/proj/a.ts"], graph);
		expect(out).toHaveLength(1);
	});
});

describe("checkRippleTests — mutation kills", () => {
	// test-contract: public-api — kills the "utf-8" -> "" and the
	// stdio-array literal mutants (["pipe","pipe","pipe"] -> [] and each
	// individual "pipe" -> "") in a single spawnSync-args assertion.
	it("spawns vitest with utf-8 encoding and full pipe stdio (bdc0f614, 0e2456f5, a90fa5fc, c6c553dc, b60d7ee3)", () => {
		existsImpl = (p) => p.endsWith("target.test.ts");
		spawnImpl = () => ({ status: 0, stdout: "ok", stderr: "", error: null });
		const graph = makeGraph();
		const out = checkRippleTests(FILE, REL, graph);
		// Real code passes clean options through to spawnSync and a status:0
		// run produces no findings — the observable outcome, not just the call.
		expect(out).toEqual([]);
		expect(spawnSyncMock).toHaveBeenCalledWith(
			"npx",
			["vitest", "run", "target.test.ts", "--reporter=verbose"],
			expect.objectContaining({
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			}),
		);
	});

	// test-contract: public-api — kills the ENOENT-guard condition mutant
	// ("false"), the "ENOENT" -> "" literal mutant, and the BlockStatement
	// fallthrough mutant: all three would let a non-empty, status:1 result
	// fall through to a reported failure instead of the correct silent skip.
	it("short-circuits on ENOENT regardless of exit status or output (66619982, e93f2d69, 3adfd19c)", () => {
		existsImpl = (p) => p.endsWith("target.test.ts");
		spawnImpl = () => ({
			status: 1,
			stdout: "should be ignored",
			stderr: "",
			error: Object.assign(new Error("not found"), { code: "ENOENT" }),
		});
		const graph = makeGraph();
		expect(checkRippleTests(FILE, REL, graph)).toEqual([]);
	});

	// test-contract: public-api — kills the `.trim()` removal on the stdout
	// branch of the output-selection expression.
	it("trims stdout before building the failure detail (f1ce5374)", () => {
		existsImpl = (p) => p.endsWith("target.test.ts");
		spawnImpl = () => ({ status: 1, stdout: "\n  line-a  \n", stderr: "", error: null });
		const graph = makeGraph();
		const out = checkRippleTests(FILE, REL, graph);
		expect(nonNull(out[0]).detail).toBe("line-a");
	});

	// test-contract: public-api — kills the `.trim()` removal on the stderr
	// fallback branch (only reached when stdout is empty).
	it("trims the stderr fallback before building the failure detail (88ab3756)", () => {
		existsImpl = (p) => p.endsWith("target.test.ts");
		spawnImpl = () => ({ status: 1, stdout: "", stderr: "\n  err-b  \n", error: null });
		const graph = makeGraph();
		const out = checkRippleTests(FILE, REL, graph);
		expect(nonNull(out[0]).detail).toBe("err-b");
	});

	// test-contract: public-api — exact-string assertion on the
	// split/join("\n") pipeline kills the "\n" -> "" literal regardless of
	// which of the two occurrences Stryker mutated.
	it("joins the last 8 output lines with newline separators (0ea068bc)", () => {
		existsImpl = (p) => p.endsWith("target.test.ts");
		const stdout = Array.from({ length: 12 }, (_, i) => `line${i}`).join("\n");
		spawnImpl = () => ({ status: 1, stdout, stderr: "", error: null });
		const graph = makeGraph();
		const out = checkRippleTests(FILE, REL, graph);
		expect(nonNull(out[0]).detail).toBe(
			"line4\nline5\nline6\nline7\nline8\nline9\nline10\nline11",
		);
	});
});

describe("findTestFileForSource — mutation kills", () => {
	// test-contract: public-api — kills the OR->false and OR->AND mutants on
	// the "am I already a test file" guard, and the endsWith(".test")->
	// startsWith(".test") mutant, by proving the guard fires even though a
	// (contrived) matching candidate file exists on disk.
	it("never treats a .test file as needing a companion test (22d238bd, 96b14bc8, 89b8e25a)", () => {
		existsImpl = (p) => p === "/proj/foo.test.test.ts";
		expect(findTestFileForSource("/proj/foo.test.ts")).toBeNull();
	});

	// test-contract: public-api — kills the endsWith(".spec")->
	// startsWith(".spec") mutant the same way, from the .spec side.
	it("never treats a .spec file as needing a companion test (bc87453b)", () => {
		existsImpl = (p) => p === "/proj/foo.spec.test.ts";
		expect(findTestFileForSource("/proj/foo.spec.ts")).toBeNull();
	});
});
