// Phase A2 — tests for `ProjectGraph.isFileReachableFromEntryPoints`.
//
// Covers:
//   - self-reach (target === entry point)
//   - direct reach (1 hop)
//   - transitive reach (3 hops)
//   - unreachable orphan
//   - multi-entry shortest-path selection
//   - cycle safety
//   - depth-cap behavior (30-hop chain > cap of 25)
//   - memo invalidation after `updateFile`
//   - synthetic 1000-file microbenchmark
//
// The SUT (`../project-graph.js`) reads files via `node:fs.readFileSync`,
// so the test mocks the module at vitest module-graph time and drives
// the in-memory file map. The companion `entry-points.test.ts` covers
// the entry-point composer with real tempdirs (no mock collision).

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock node:fs BEFORE the SUT is imported. vitest hoists vi.mock above
// the static imports.
vi.mock("node:fs", () => ({
	existsSync: vi.fn(() => false),
	statSync: vi.fn(() => {
		throw new Error("ENOENT");
	}),
	readFileSync: vi.fn(() => {
		throw new Error("ENOENT");
	}),
	readdirSync: vi.fn(() => []),
}));

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { ProjectGraph } from "../project-graph.js";
import { REACHABILITY_DEPTH_CAP } from "../project-graph-reachability.js";

const mockedExistsSync = existsSync as unknown as ReturnType<typeof vi.fn>;
const mockedStatSync = statSync as unknown as ReturnType<typeof vi.fn>;
const mockedReadFileSync = readFileSync as unknown as ReturnType<typeof vi.fn>;
const mockedReaddirSync = readdirSync as unknown as ReturnType<typeof vi.fn>;

// Mock the filesystem so ProjectGraph reads from `files` and resolves
// extensions correctly.
function mockFileSystem(files: Map<string, string>): void {
	const pathSet = new Set(files.keys());
	mockedExistsSync.mockImplementation((p: string) => pathSet.has(p));
	mockedStatSync.mockImplementation((p: string) => {
		if (pathSet.has(p)) {
			return {
				isFile: () => true,
				isDirectory: () => false,
			} as unknown as ReturnType<typeof statSync>;
		}
		throw new Error("ENOENT");
	});
	mockedReadFileSync.mockImplementation((p: string) => {
		const content = files.get(p);
		if (content !== undefined) return content;
		throw new Error("ENOENT");
	});
	mockedReaddirSync.mockImplementation(() => []);
}

describe("ProjectGraph.isFileReachableFromEntryPoints", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("returns reachable=true with distance 0 when target is itself an entry point", () => {
		const files = new Map<string, string>([["/project/entry.ts", "export const x = 1;"]]);
		mockFileSystem(files);
		const g = new ProjectGraph("/project");
		g.updateFile("/project/entry.ts", files.get("/project/entry.ts"));

		const v = g.isFileReachableFromEntryPoints("/project/entry.ts", ["/project/entry.ts"]);
		expect(v.reachable).toBe(true);
		expect(v.distance).toBe(0);
		expect(v.path).toEqual(["/project/entry.ts"]);
		expect(v.entry_points_considered).toEqual(["/project/entry.ts"]);
	});

	it("finds direct reach: entry → target → distance 1", () => {
		const files = new Map<string, string>([
			["/project/entry.ts", `import { y } from './target';`],
			["/project/target.ts", "export const y = 1;"],
		]);
		mockFileSystem(files);
		const g = new ProjectGraph("/project");
		g.updateFile("/project/target.ts", files.get("/project/target.ts"));
		g.updateFile("/project/entry.ts", files.get("/project/entry.ts"));

		const v = g.isFileReachableFromEntryPoints("/project/target.ts", ["/project/entry.ts"]);
		expect(v.reachable).toBe(true);
		expect(v.distance).toBe(1);
		expect(v.path?.[0]).toBe("/project/entry.ts");
		expect(v.path?.[(v.path?.length ?? 0) - 1]).toBe("/project/target.ts");
	});

	it("finds transitive reach: entry → A → B → target → distance 3", () => {
		const files = new Map<string, string>([
			["/project/entry.ts", `import { a } from './a';`],
			["/project/a.ts", `import { b } from './b';\nexport const a = b;`],
			["/project/b.ts", `import { t } from './target';\nexport const b = t;`],
			["/project/target.ts", "export const t = 1;"],
		]);
		mockFileSystem(files);
		const g = new ProjectGraph("/project");
		g.updateFile("/project/target.ts", files.get("/project/target.ts"));
		g.updateFile("/project/b.ts", files.get("/project/b.ts"));
		g.updateFile("/project/a.ts", files.get("/project/a.ts"));
		g.updateFile("/project/entry.ts", files.get("/project/entry.ts"));

		const v = g.isFileReachableFromEntryPoints("/project/target.ts", ["/project/entry.ts"]);
		expect(v.reachable).toBe(true);
		expect(v.distance).toBe(3);
		expect(v.path).toEqual([
			"/project/entry.ts",
			"/project/a.ts",
			"/project/b.ts",
			"/project/target.ts",
		]);
	});

	it("returns reachable=false for an orphan file with no importers", () => {
		const files = new Map<string, string>([
			["/project/entry.ts", "export const e = 1;"],
			["/project/orphan.ts", "export const o = 1;"],
		]);
		mockFileSystem(files);
		const g = new ProjectGraph("/project");
		g.updateFile("/project/entry.ts", files.get("/project/entry.ts"));
		g.updateFile("/project/orphan.ts", files.get("/project/orphan.ts"));

		const v = g.isFileReachableFromEntryPoints("/project/orphan.ts", ["/project/entry.ts"]);
		expect(v.reachable).toBe(false);
		expect(v.distance).toBeUndefined();
		expect(v.path).toBeUndefined();
		expect(v.entry_points_considered).toEqual(["/project/entry.ts"]);
	});

	it("picks the closest entry point when multiple are provided", () => {
		// Two entry points: A (distance 1) and B (distance 2).
		const files = new Map<string, string>([
			["/project/a.ts", `import { t } from './target';`],
			["/project/b.ts", `import { a } from './a';`],
			["/project/target.ts", "export const t = 1;"],
		]);
		mockFileSystem(files);
		const g = new ProjectGraph("/project");
		g.updateFile("/project/target.ts", files.get("/project/target.ts"));
		g.updateFile("/project/a.ts", files.get("/project/a.ts"));
		g.updateFile("/project/b.ts", files.get("/project/b.ts"));

		const v = g.isFileReachableFromEntryPoints("/project/target.ts", [
			"/project/b.ts",
			"/project/a.ts",
		]);
		expect(v.reachable).toBe(true);
		// A is 1 hop, B is 2 hops — BFS should pick A.
		expect(v.distance).toBe(1);
		expect(v.path?.[0]).toBe("/project/a.ts");
	});

	it("does not loop through import cycles", () => {
		const files = new Map<string, string>([
			// entry imports a, a imports b, b imports a (cycle), b also imports target.
			["/project/entry.ts", `import { a } from './a';`],
			["/project/a.ts", `import { b } from './b';\nexport const a = b;`],
			[
				"/project/b.ts",
				`import { a as _a } from './a';\nimport { t } from './target';\nexport const b = t;`,
			],
			["/project/target.ts", "export const t = 1;"],
		]);
		mockFileSystem(files);
		const g = new ProjectGraph("/project");
		g.updateFile("/project/target.ts", files.get("/project/target.ts"));
		g.updateFile("/project/b.ts", files.get("/project/b.ts"));
		g.updateFile("/project/a.ts", files.get("/project/a.ts"));
		g.updateFile("/project/entry.ts", files.get("/project/entry.ts"));

		const v = g.isFileReachableFromEntryPoints("/project/target.ts", ["/project/entry.ts"]);
		expect(v.reachable).toBe(true);
		// Sanity-bound: don't loop indefinitely.
		const distance = v.distance ?? -1;
		expect(distance).toBeGreaterThanOrEqual(1);
		expect(distance).toBeLessThanOrEqual(3);
	});

	it("returns reachable=false when the chain exceeds REACHABILITY_DEPTH_CAP", () => {
		// 30-link chain: entry → l0 → l1 → ... → l28 → target. Cap is 25.
		const files = new Map<string, string>();
		const LINKS = 30;
		files.set("/project/entry.ts", `import { l0 } from './l0';`);
		for (let i = 0; i < LINKS - 1; i++) {
			files.set(
				`/project/l${i}.ts`,
				`import { l${i + 1} } from './l${i + 1}';\nexport const l${i} = l${i + 1};`,
			);
		}
		files.set(
			`/project/l${LINKS - 1}.ts`,
			`import { t } from './target';\nexport const l${LINKS - 1} = t;`,
		);
		files.set("/project/target.ts", "export const t = 1;");

		mockFileSystem(files);
		const g = new ProjectGraph("/project");
		g.updateFile("/project/target.ts", files.get("/project/target.ts"));
		for (let i = LINKS - 1; i >= 0; i--) {
			g.updateFile(`/project/l${i}.ts`, files.get(`/project/l${i}.ts`));
		}
		g.updateFile("/project/entry.ts", files.get("/project/entry.ts"));

		const v = g.isFileReachableFromEntryPoints("/project/target.ts", ["/project/entry.ts"]);
		// Chain is 31 hops; cap kicks in before reach is established.
		expect(v.reachable).toBe(false);
		expect(REACHABILITY_DEPTH_CAP).toBe(25);
	});

	it("memo invalidates when updateFile is called (topology change)", () => {
		const files = new Map<string, string>([
			["/project/entry.ts", "export const e = 1;"],
			["/project/target.ts", "export const t = 1;"],
		]);
		mockFileSystem(files);
		const g = new ProjectGraph("/project");
		g.updateFile("/project/entry.ts", files.get("/project/entry.ts"));
		g.updateFile("/project/target.ts", files.get("/project/target.ts"));

		// Initially: target is not reachable from entry.
		let v = g.isFileReachableFromEntryPoints("/project/target.ts", ["/project/entry.ts"]);
		expect(v.reachable).toBe(false);

		// Now add an import edge entry → target and re-index.
		const newEntry = `import { t } from './target';`;
		files.set("/project/entry.ts", newEntry);
		mockFileSystem(files);
		g.updateFile("/project/entry.ts", newEntry);

		// After the topology change, the memo must be invalidated.
		v = g.isFileReachableFromEntryPoints("/project/target.ts", ["/project/entry.ts"]);
		expect(v.reachable).toBe(true);
	});

	it("synthetic 1000-file graph — query completes within reasonable budget", () => {
		// Build a wide tree: 1 entry → 999 leaves. Then query a couple of
		// leaves and assert reach succeeds. The runtime budget itself is a
		// soft note (perf is logged separately via the in-repo probes); the
		// hard assertion is correctness over a 1000-file graph.
		const files = new Map<string, string>();
		const NODES = 1000;
		const leafImports: string[] = [];
		for (let i = 1; i < NODES; i++) {
			files.set(`/project/leaf${i}.ts`, `export const x${i} = ${i};`);
			leafImports.push(`import { x${i} } from './leaf${i}';`);
		}
		files.set("/project/entry.ts", leafImports.join("\n"));
		mockFileSystem(files);

		const g = new ProjectGraph("/project");
		for (let i = 1; i < NODES; i++) {
			g.updateFile(`/project/leaf${i}.ts`, files.get(`/project/leaf${i}.ts`));
		}
		g.updateFile("/project/entry.ts", files.get("/project/entry.ts"));

		// Sample 50 leaves spread across the graph and assert each is reachable.
		const ITERATIONS = 50;
		for (let i = 0; i < ITERATIONS; i++) {
			const leafIdx = 1 + ((i * 7) % (NODES - 1));
			const target = `/project/leaf${leafIdx}.ts`;
			const v = g.isFileReachableFromEntryPoints(target, ["/project/entry.ts"]);
			expect(v.reachable).toBe(true);
			expect(v.distance).toBe(1);
		}
	});
});
