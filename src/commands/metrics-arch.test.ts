// ===========================================
// metrics-arch unit tests — pure core (dir fold → Ca/Ce/I, propagation cost)
// ===========================================
// ProjectGraph extraction is exercised via the live command; the metric math
// below is pure and tested against hand-computed oracles.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { ProjectGraph } from "../harness/project-graph.js";
import {
	computeDirMetrics,
	computePropagationCost,
	dirAtDepth,
	isProductionSource,
	metricsArchCommand,
} from "./metrics-arch.js";

describe("dirAtDepth", () => {
	it("folds a path to its first N segments", () => {
		expect(dirAtDepth("src/harness/checks/foo.ts", 2)).toBe("src/harness");
		expect(dirAtDepth("src/index.ts", 2)).toBe("src");
		expect(dirAtDepth("src/harness/checks/foo.ts", 3)).toBe("src/harness/checks");
	});
});

describe("isProductionSource", () => {
	it("keeps plain source files", () => {
		expect(isProductionSource("src/harness/server.ts")).toBe(true);
	});
	it("drops test files, __tests__ dirs, and d.ts", () => {
		expect(isProductionSource("src/a/foo.test.ts")).toBe(false);
		expect(isProductionSource("src/a/__tests__/foo.ts")).toBe(false);
		expect(isProductionSource("src/types.d.ts")).toBe(false);
	});
});

describe("computeDirMetrics", () => {
	// harness/a → lib/x ; commands/b → lib/x ; commands/b → harness/a
	const EDGES = [
		{ from: "src/harness/a.ts", to: "src/lib/x.ts" },
		{ from: "src/commands/b.ts", to: "src/lib/x.ts" },
		{ from: "src/commands/b.ts", to: "src/harness/a.ts" },
	];

	it("computes Ca (files outside importing in) and Ce (files inside importing out) per dir", () => {
		const rows = computeDirMetrics(EDGES, 2);
		const lib = rows.find((r) => r.dir === "src/lib");
		// two distinct outside files import into lib; lib imports nothing
		expect(lib).toMatchObject({ ca: 2, ce: 0, instability: 0 });
		const commands = rows.find((r) => r.dir === "src/commands");
		// commands/b imports out (counted once as a file, even with 2 outward edges)
		expect(commands).toMatchObject({ ca: 0, ce: 1, instability: 1 });
		const harness = rows.find((r) => r.dir === "src/harness");
		// one outside file (commands/b) imports in; harness/a imports out
		expect(harness).toMatchObject({ ca: 1, ce: 1, instability: 0.5 });
	});

	it("ignores intra-dir edges entirely", () => {
		const rows = computeDirMetrics(
			[{ from: "src/lib/a.ts", to: "src/lib/b.ts" }],
			2,
		);
		const lib = rows.find((r) => r.dir === "src/lib");
		expect(lib).toMatchObject({ ca: 0, ce: 0, instability: null });
	});

	it("counts files per dir from both edge endpoints", () => {
		const rows = computeDirMetrics(EDGES, 2);
		expect(rows.find((r) => r.dir === "src/lib")?.files).toBe(1);
		expect(rows.find((r) => r.dir === "src/commands")?.files).toBe(1);
	});
});

describe("computePropagationCost", () => {
    it("includes isolated modules in the measured population", () => {
        const graph = [{ from: "a", to: "b" }, { from: "b", to: "c" }];
        expect(computePropagationCost(graph, ["a", "b", "c", "isolated"])).toEqual({ files: 4, cost: 3 / 16 });
        expect(computePropagationCost([], ["isolated"])).toEqual({ files: 1, cost: 0 });
        expect(computeDirMetrics([], 2, ["src/isolated.ts"])).toEqual([
            { dir: "src", files: 1, ca: 0, ce: 0, instability: null },
        ]);
    });
	it("chain a→b→c: reachable sets are 2,1,0 → cost = 3/9", () => {
		const cost = computePropagationCost([
			{ from: "a", to: "b" },
			{ from: "b", to: "c" },
		]);
		expect(cost.files).toBe(3);
		expect(cost.cost).toBeCloseTo(3 / 9, 5);
	});

	it("2-cycle: each reaches the other → 2/4", () => {
		const cost = computePropagationCost([
			{ from: "a", to: "b" },
			{ from: "b", to: "a" },
		]);
		expect(cost.cost).toBeCloseTo(0.5, 5);
	});

	it("star (hub imports 3 leaves): hub reaches 3, leaves reach 0 → 3/16", () => {
		const cost = computePropagationCost([
			{ from: "hub", to: "l1" },
			{ from: "hub", to: "l2" },
			{ from: "hub", to: "l3" },
		]);
		expect(cost.cost).toBeCloseTo(3 / 16, 5);
	});

	it("empty graph costs 0", () => {
		expect(computePropagationCost([]).cost).toBe(0);
	});
});

// ===========================================
// metricsArchCommand — live command against a real tmp project tree
// ===========================================
// `extractEdges` walks a real `ProjectGraph`, so it is exercised through the
// live command rather than mocked — same convention as metrics-rework.test.ts
// / metrics-coupling.test.ts (real fs, no git needed here since ProjectGraph
// doesn't shell out).
//
// Fixture reproduces the exact edge shape already proven against the pure
// `computeDirMetrics` oracle above: harness/a → lib/x ; commands/b → lib/x ;
// commands/b → harness/a. So the JSON assertions below can be checked against
// the SAME hand-computed numbers as the pure-function tests.
function buildFixtureProject(): string {
	const root = mkdtempSync(join(tmpdir(), "metrics-arch-"));
	const put = (rel: string, contents: string) => {
		const abs = join(root, rel);
		mkdirSync(dirname(abs), { recursive: true });
		writeFileSync(abs, contents);
	};
	put("src/lib/x.ts", "export const x = 1;\n");
	put("src/harness/a.ts", 'import { x } from "../lib/x.js";\nexport const a = x + 1;\n');
	put(
		"src/commands/b.ts",
		'import { x } from "../lib/x.js";\nimport { a } from "../harness/a.js";\nexport const b = x + a;\n',
	);
	// A test file for the same module, in a same-depth-2 dir (src/commands) so
	// its import edge to b.ts is intra-dir and doesn't perturb Ca/Ce — only
	// `files` count differs between includeTests true/false.
	put("src/commands/__tests__/b.test.ts", 'import { b } from "../b.js";\nexport const t = b;\n');
	return root;
}

let project = "";

beforeAll(() => {
	project = buildFixtureProject();
});

afterAll(() => {
	if (project) rmSync(project, { recursive: true, force: true });
});

async function runArch(
	opts: Parameters<typeof metricsArchCommand>[0],
): Promise<{ out: string; err: string[]; exitCode: number | undefined }> {
	const priorExit = process.exitCode;
	process.exitCode = undefined;
	const logged: string[] = [];
	const err: string[] = [];
	const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
		logged.push(args.map(String).join(" "));
	});
	const errSpy = vi
		.spyOn(process.stderr, "write")
		.mockImplementation((chunk: string | Uint8Array) => {
			err.push(String(chunk));
			return true;
		});
	try {
		await metricsArchCommand(opts);
		return { out: logged.join("\n"), err, exitCode: process.exitCode };
	} finally {
		logSpy.mockRestore();
		errSpy.mockRestore();
		process.exitCode = priorExit;
	}
}

describe("metricsArchCommand — JSON output", () => {
	it("reports depth, propagation cost, and per-dir Ca/Ce/I matching the pure oracle", async () => {
		const { out, exitCode } = await runArch({ cwd: project, json: true });
		expect(exitCode).toBeUndefined();
		const payload = JSON.parse(out) as {
			depth: number;
			propagation: { files: number; cost: number };
			dirs: Array<{ dir: string; files: number; ca: number; ce: number; instability: number | null }>;
		};
		expect(payload.depth).toBe(2);
		expect(payload.propagation.files).toBe(3);
		expect(payload.propagation.cost).toBeCloseTo(3 / 9, 5);
		const lib = payload.dirs.find((d) => d.dir === "src/lib");
		expect(lib).toMatchObject({ ca: 2, ce: 0, instability: 0 });
		const commands = payload.dirs.find((d) => d.dir === "src/commands");
		expect(commands).toMatchObject({ ca: 0, ce: 1, instability: 1, files: 1 });
		const harness = payload.dirs.find((d) => d.dir === "src/harness");
		expect(harness).toMatchObject({ ca: 1, ce: 1, instability: 0.5 });
	});

    it("retains an isolated module in the live graph and normalized denominator", async () => {
        const root = buildFixtureProject();
        try {
            writeFileSync(join(root, "src/lib/isolated.ts"), "export const isolated = 1;\n");
            const { out } = await runArch({ cwd: root, json: true });
            const payload = JSON.parse(out);
            expect(payload.graphVersion).toBe(2);
            expect(payload.propagation).toEqual({ files: 4, cost: 3 / 16 });
            expect(payload.normalizedReach).toBeCloseTo(3 / 12, 8);
            expect(payload.dirs.find((row: { dir: string }) => row.dir === "src/lib").files).toBe(2);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

	it("counts the test file into `files` only when --include-tests is set", async () => {
		const withoutTests = await runArch({ cwd: project, json: true, includeTests: false });
		const withTests = await runArch({ cwd: project, json: true, includeTests: true });
		const dirsWithout = (JSON.parse(withoutTests.out) as { dirs: Array<{ dir: string; files: number }> }).dirs;
		const dirsWith = (JSON.parse(withTests.out) as { dirs: Array<{ dir: string; files: number }> }).dirs;
		expect(dirsWithout.find((d) => d.dir === "src/commands")?.files).toBe(1);
		expect(dirsWith.find((d) => d.dir === "src/commands")?.files).toBe(2);
	});

	it("falls back to depth 2 when --depth is omitted", async () => {
		const { out } = await runArch({ cwd: project, json: true });
		expect((JSON.parse(out) as { depth: number }).depth).toBe(2);
	});

	it("falls back to depth 2 when --depth is empty or non-numeric", async () => {
		for (const depth of ["", "not-a-number"]) {
			const { out } = await runArch({ cwd: project, json: true, depth });
			expect((JSON.parse(out) as { depth: number }).depth).toBe(2);
		}
	});

	it("honors an explicit --depth, folding everything into one root dir", async () => {
		const { out } = await runArch({ cwd: project, json: true, depth: "1" });
		const payload = JSON.parse(out) as {
			depth: number;
			dirs: Array<{ dir: string; files: number; ca: number; ce: number; instability: number | null }>;
		};
		expect(payload.depth).toBe(1);
		expect(payload.dirs).toEqual([
			{ dir: "src", files: 3, ca: 0, ce: 0, instability: null },
		]);
	});
});

describe("metricsArchCommand — human-readable rendering", () => {
	it("renders the header line with file count and propagation cost", async () => {
		const { out } = await runArch({ cwd: project });
		expect(out).toContain("Architecture — 3 files, propagation cost 33.3%");
		expect(out).toContain("(mean share of modules transitively imported; isolated modules included)");
	});

	it("renders the table header and one row per dir", async () => {
		const { out } = await runArch({ cwd: project });
		expect(out).toMatch(/dir\s+files\s+Ca\s+Ce\s+I/);
		expect(out).toContain("src/lib");
		expect(out).toContain("src/commands");
		expect(out).toContain("src/harness");
	});

	it("renders the depth/instability-formula footer", async () => {
		const { out } = await runArch({ cwd: project });
		expect(out).toContain(
			"depth 2; I = Ce/(Ca+Ce) — 0 stable/depended-upon, 1 unstable/dependent.",
		);
	});

	it("renders '—' for instability when a dir has no cross-dir coupling at all", async () => {
		const { out } = await runArch({ cwd: project, depth: "1" });
		expect(out).toMatch(/src\s+3\s+0\s+0\s+—/);
	});

	it("renders a one-line summary in --short mode", async () => {
		const { out } = await runArch({ cwd: project, short: true });
		expect(out).toBe("3 files, propagation 33.3%, 3 dirs");
	});
});

describe("metricsArchCommand — project graph failure", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("reports the failure to stderr and exits 1 without printing anything", async () => {
		vi.spyOn(ProjectGraph.prototype, "initialize").mockImplementation(() => {
			throw new Error("boom");
		});
		const { out, err, exitCode } = await runArch({ cwd: project });
		expect(exitCode).toBe(1);
		expect(out).toBe("");
		expect(err).toEqual(["project graph unavailable (initialize failed)\n"]);
	});
});
