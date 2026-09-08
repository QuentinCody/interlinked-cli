import { makeRouteMap as completeRouteMapFixture } from "./fixtures/managers.js";
// Phase C — tests for `reachability-annotator.ts`.
//
// Covers the `annotateReachability` transformer:
//   - reachable → [reachable] tag
//   - unreachable → [unreachable-from-entrypoints] tag
//   - mixed batch (two reachable, one unreachable)
//   - empty input
//   - verbose mode appends "Entry points considered: …"
//   - verbose mode truncates to 5 when >5 entry points
//   - one graph query per unique file (call-shape memoization)
//   - input findings and finding objects are not mutated
//
// Plus `buildHttpHandlerEntryPoints`:
//   - empty route map → []
//   - 3 distinct files → 3 entry points
//   - duplicate files collapsed
//   - reason string formatting
//
// SUT reads files via `node:fs.readFileSync` (transitively through
// ProjectGraph); we mock the module so the tests don't touch the
// real filesystem. The mock pattern mirrors `reachability.test.ts`.

import { beforeEach, describe, expect, it, vi } from "vitest";

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
import { nonNull } from "../../lib/non-null.js";
import type { DetectorFinding } from "../checks/endpoint-security.js";
import type { EntryPoint } from "../entry-points.js";
import { ProjectGraph } from "../project-graph.js";
import {
	annotateReachability,
	buildHttpHandlerEntryPoints,
} from "../reachability-annotator.js";
import { RouteMap } from "../route-map.js";
import type { Endpoint } from "../types/session.js";

const mockedExistsSync = vi.mocked(existsSync);
const mockedStatSync = vi.mocked(statSync);
const mockedReadFileSync = vi.mocked(readFileSync);
const mockedReaddirSync = vi.mocked(readdirSync);
const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
const regularFileStat = realFs.statSync(import.meta.filename);

function mockFileSystem(files: Map<string, string>): void {
	const pathSet = new Set(files.keys());
	mockedExistsSync.mockImplementation((p) => pathSet.has(String(p)));
	mockedStatSync.mockImplementation((p) => {
		if (pathSet.has(String(p))) {
			return regularFileStat;
		}
		throw new Error("ENOENT");
	});
	mockedReadFileSync.mockImplementation((p) => {
		const content = files.get(String(p));
		if (content !== undefined) return content;
		throw new Error("ENOENT");
	});
	mockedReaddirSync.mockImplementation(() => []);
}

/** Build a small graph: entry.ts imports target.ts (reachable);
 * orphan.ts is unreferenced (unreachable). */
function buildSampleGraph(): { graph: ProjectGraph; entryPoint: EntryPoint } {
	const files = new Map<string, string>([
		["/project/entry.ts", `import { t } from './target';`],
		["/project/target.ts", "export const t = 1;"],
		["/project/orphan.ts", "export const o = 1;"],
	]);
	mockFileSystem(files);
	const graph = new ProjectGraph("/project");
	graph.updateFile("/project/target.ts", files.get("/project/target.ts"));
	graph.updateFile("/project/orphan.ts", files.get("/project/orphan.ts"));
	graph.updateFile("/project/entry.ts", files.get("/project/entry.ts"));
	const entryPoint: EntryPoint = {
		kind: "http_handler",
		file: "/project/entry.ts",
		reason: "http_handler:express:GET:/health",
	};
	return { graph, entryPoint };
}

function makeFinding(file: string, message = "base message"): DetectorFinding {
	return {
		check_id: "endpoint_auth_missing",
		file,
		line: 12,
		message,
		endpoint_path: "/x",
		endpoint_method: "GET",
	};
}

describe("annotateReachability", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("appends [reachable] to findings whose file is reachable from an entry point", () => {
		const { graph, entryPoint } = buildSampleGraph();
		const findings = [makeFinding("/project/target.ts", "auth missing on /x")];

		const annotated = annotateReachability(findings, {
			projectGraph: graph,
			entryPoints: [entryPoint],
		});

		expect(annotated).toHaveLength(1);
		expect(nonNull(annotated[0]).message).toBe("auth missing on /x\n[reachable]");
		// Tag lands on its own line so the formatter's newline-aware
		// rendering keeps it visually separate.
		expect(nonNull(annotated[0]).message.split("\n").pop()).toBe("[reachable]");
	});

	it("appends [unreachable-from-entrypoints] to findings whose file is not reachable", () => {
		const { graph, entryPoint } = buildSampleGraph();
		const findings = [makeFinding("/project/orphan.ts", "auth missing on /o")];

		const annotated = annotateReachability(findings, {
			projectGraph: graph,
			entryPoints: [entryPoint],
		});

		expect(annotated).toHaveLength(1);
		expect(nonNull(annotated[0]).message).toBe("auth missing on /o\n[unreachable-from-entrypoints]");
	});

	it("annotates a mixed batch correctly — two reachable, one unreachable", () => {
		const { graph, entryPoint } = buildSampleGraph();
		const findings = [
			makeFinding("/project/target.ts", "msg-a"),
			makeFinding("/project/orphan.ts", "msg-b"),
			makeFinding("/project/target.ts", "msg-c"),
		];

		const annotated = annotateReachability(findings, {
			projectGraph: graph,
			entryPoints: [entryPoint],
		});

		expect(annotated).toHaveLength(3);
		expect(nonNull(annotated[0]).message).toBe("msg-a\n[reachable]");
		expect(nonNull(annotated[1]).message).toBe("msg-b\n[unreachable-from-entrypoints]");
		expect(nonNull(annotated[2]).message).toBe("msg-c\n[reachable]");
	});

	it("returns an empty array for empty input without touching the graph", () => {
		const { graph, entryPoint } = buildSampleGraph();
		const spy = vi.spyOn(graph, "isFileReachableFromEntryPoints");

		const annotated = annotateReachability([], {
			projectGraph: graph,
			entryPoints: [entryPoint],
		});

		expect(annotated).toEqual([]);
		expect(spy).not.toHaveBeenCalled();
	});

	it("verbose mode appends an 'Entry points considered:' line with basenames", () => {
		const { graph, entryPoint } = buildSampleGraph();
		const findings = [makeFinding("/project/target.ts", "msg")];

		const annotated = annotateReachability(findings, {
			projectGraph: graph,
			entryPoints: [entryPoint],
			verbose: true,
		});

		expect(annotated).toHaveLength(1);
		const lines = nonNull(annotated[0]).message.split("\n");
		expect(lines[0]).toBe("msg");
		expect(lines[1]).toBe("[reachable]");
		expect(lines[2]).toBe("Entry points considered: entry.ts");
	});

	it("verbose mode truncates entry-point list to 5 when more are supplied", () => {
		const { graph } = buildSampleGraph();
		const entryPoints: EntryPoint[] = Array.from({ length: 7 }, (_, i) => ({
			kind: "http_handler",
			file: `/project/ep${i}.ts`,
			reason: `http_handler:express:GET:/r${i}`,
		}));
		const findings = [makeFinding("/project/target.ts", "msg")];

		const annotated = annotateReachability(findings, {
			projectGraph: graph,
			entryPoints,
			verbose: true,
		});

		const verboseLine = nonNull(annotated[0]).message.split("\n")[2];
		// First five entry-point basenames, then an ellipsis marker.
		expect(verboseLine).toBe("Entry points considered: ep0.ts, ep1.ts, ep2.ts, ep3.ts, ep4.ts, …");
	});

	it("queries the graph once per unique file even when multiple findings share a file", () => {
		const { graph, entryPoint } = buildSampleGraph();
		const spy = vi.spyOn(graph, "isFileReachableFromEntryPoints");
		const findings = [
			makeFinding("/project/target.ts", "msg-a"),
			makeFinding("/project/target.ts", "msg-b"),
			makeFinding("/project/orphan.ts", "msg-c"),
			makeFinding("/project/target.ts", "msg-d"),
			makeFinding("/project/orphan.ts", "msg-e"),
		];

		annotateReachability(findings, {
			projectGraph: graph,
			entryPoints: [entryPoint],
		});

		// Two unique files (target, orphan) → at most two graph queries.
		expect(spy.mock.calls.length).toBeLessThanOrEqual(2);
		// And we did query both unique files.
		const queriedFiles = spy.mock.calls.map((call) => call[0]);
		expect(new Set(queriedFiles)).toEqual(
			new Set(["/project/target.ts", "/project/orphan.ts"]),
		);
	});

	it("does not mutate the input findings array or its elements", () => {
		const { graph, entryPoint } = buildSampleGraph();
		const original = makeFinding("/project/target.ts", "untouched");
		const snapshot = { ...original };
		const findings = [original];
		const findingsSnapshot = [...findings];

		const annotated = annotateReachability(findings, {
			projectGraph: graph,
			entryPoints: [entryPoint],
		});

		// Output is a new array, not the input array.
		expect(annotated).not.toBe(findings);
		// Input array length and contents unchanged.
		expect(findings).toEqual(findingsSnapshot);
		// Original finding object unchanged (deep field equality).
		expect(original).toEqual(snapshot);
		// And the output message is the annotated one.
		expect(nonNull(annotated[0]).message).toBe("untouched\n[reachable]");
	});
});

describe("buildHttpHandlerEntryPoints", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("returns an empty array when the route map has no endpoints", () => {
		mockFileSystem(new Map());
		const routeMap = new RouteMap("/project");
		routeMap.initialize([]);

		const eps = buildHttpHandlerEntryPoints(routeMap);

		expect(eps).toEqual([]);
	});

	it("produces one entry per unique file when endpoints span three distinct files", () => {
		// We stub `extractAllEndpoints` directly: the per-framework
		// extractors are tested independently and bringing them in
		// here would couple this test to fixture content. A typed stub
		// is a clean seam — the annotator only consumes the public
		// shape `extractAllEndpoints(): Endpoint[]`.
		const fakeEndpoints: Endpoint[] = [
			{
				framework: "express",
				method: "GET",
				path: "/a",
				file: "/project/a.ts",
				line: 1,
				auth_chain: [],
				declared_params: [],
			},
			{
				framework: "hono",
				method: "POST",
				path: "/b",
				file: "/project/b.ts",
				line: 1,
				auth_chain: [],
				declared_params: [],
			},
			{
				framework: "fastapi",
				method: "DELETE",
				path: "/c",
				file: "/project/c.py",
				line: 1,
				auth_chain: [],
				declared_params: [],
			},
		];
		const routeMapStub = completeRouteMapFixture({
			extractAllEndpoints: () => fakeEndpoints,
		});

		const eps = buildHttpHandlerEntryPoints(routeMapStub);

		expect(eps).toHaveLength(3);
		expect(eps.map((e: EntryPoint) => e.file).sort()).toEqual([
			"/project/a.ts",
			"/project/b.ts",
			"/project/c.py",
		]);
		for (const ep of eps) {
			expect(ep.kind).toBe("http_handler");
		}
	});

	it("dedupes endpoints by file — two endpoints on the same file collapse to one entry", () => {
		const fakeEndpoints: Endpoint[] = [
			{
				framework: "express",
				method: "GET",
				path: "/items",
				file: "/project/api.ts",
				line: 5,
				auth_chain: [],
				declared_params: [],
			},
			{
				framework: "express",
				method: "POST",
				path: "/items",
				file: "/project/api.ts",
				line: 10,
				auth_chain: [],
				declared_params: [],
			},
			{
				framework: "express",
				method: "DELETE",
				path: "/items/:id",
				file: "/project/api.ts",
				line: 15,
				auth_chain: [],
				declared_params: [],
			},
		];
		const routeMapStub = completeRouteMapFixture({
			extractAllEndpoints: () => fakeEndpoints,
		});

		const eps = buildHttpHandlerEntryPoints(routeMapStub);

		expect(eps).toHaveLength(1);
		expect(nonNull(eps[0]).file).toBe("/project/api.ts");
	});

	it("formats the reason string as http_handler:<framework>:<method>:<path>", () => {
		const fakeEndpoints: Endpoint[] = [
			{
				framework: "hono",
				method: "PATCH",
				path: "/users/:id",
				file: "/project/users.ts",
				line: 42,
				auth_chain: [],
				declared_params: [],
			},
		];
		const routeMapStub = completeRouteMapFixture({
			extractAllEndpoints: () => fakeEndpoints,
		});

		const eps = buildHttpHandlerEntryPoints(routeMapStub);

		expect(eps).toHaveLength(1);
		expect(nonNull(eps[0]).reason).toBe("http_handler:hono:PATCH:/users/:id");
	});
});
