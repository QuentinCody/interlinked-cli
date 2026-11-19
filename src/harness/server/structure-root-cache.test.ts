import { describe, expect, it } from "vitest";
import { ArtifactGraph } from "../structure/artifact-graph.js";
import { resolveStructureConfig } from "../structure/schema-validator.js";
import { STRUCTURE_CACHE_MAX_ROOTS, StructureRootCache } from "./structure-root-cache.js";

const declared = resolveStructureConfig({ version: 1 });

describe("StructureRootCache — positive (must fire)", () => {
	it("P1: a root gets back exactly the entry created for it", () => {
		const cache = new StructureRootCache();
		const a = cache.create("/work/a", declared);
		a.graph = new ArtifactGraph();
		expect(cache.get("/work/a")).toBe(a);
		expect(cache.get("/work/a")?.config).toBe(declared);
	});

	it("P2: a negative answer (no structure.json) is cached as an entry with a null config", () => {
		const cache = new StructureRootCache();
		cache.create("/work/plain", null);
		expect(cache.get("/work/plain")).toEqual({ config: null, graph: null });
	});

	it("P3: the key is the resolved root, so equivalent spellings share one entry", () => {
		const cache = new StructureRootCache();
		const entry = cache.create("/work/a/../b/", declared);
		expect(cache.get("/work/b")).toBe(entry);
	});

	it("P4: past the bound, the least recently used root is dropped", () => {
		const cache = new StructureRootCache();
		for (let i = 0; i < STRUCTURE_CACHE_MAX_ROOTS; i++) cache.create(`/work/r${i}`, null);
		// Touch r0 so r1 becomes the least recently used root.
		cache.get("/work/r0");
		cache.create("/work/extra", null);
		expect(cache.get("/work/r1")).toBeUndefined();
		expect(cache.get("/work/r0")).toBeDefined();
		expect(cache.get("/work/extra")).toBeDefined();
	});
});

describe("StructureRootCache — negative (must not fire)", () => {
	it("N1: a root never receives another root's entry", () => {
		const cache = new StructureRootCache();
		cache.create("/work/a", declared).graph = new ArtifactGraph();
		expect(cache.get("/work/b")).toBeUndefined();
	});

	it("N2: a deleted root misses, and other roots stay", () => {
		const cache = new StructureRootCache();
		cache.create("/work/a", declared);
		cache.create("/work/b", null);
		cache.delete("/work/a");
		expect(cache.get("/work/a")).toBeUndefined();
		expect(cache.get("/work/b")).toBeDefined();
	});

	it("N3: at the bound, no root is dropped", () => {
		const cache = new StructureRootCache();
		for (let i = 0; i < STRUCTURE_CACHE_MAX_ROOTS; i++) cache.create(`/work/r${i}`, null);
		for (let i = 0; i < STRUCTURE_CACHE_MAX_ROOTS; i++) expect(cache.get(`/work/r${i}`)).toBeDefined();
	});
});
