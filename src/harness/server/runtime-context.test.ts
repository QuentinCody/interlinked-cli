import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutoCoordinationState } from "../auto-coordinate.js";
import { ProjectGraph } from "../project-graph.js";
import {
	getAutoCoordState,
	getGraphForFile,
	type ServerRuntime,
	summarizeToolInput,
} from "./runtime-context.js";

let tmp = "";
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "interlinked-rt-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

/** Minimal ServerRuntime stub — only the fields the helpers under test
 *  actually read. Cast through unknown so we don't have to populate the
 *  ~30 managers the full interface declares. */
function makeCtx(overrides: Partial<ServerRuntime> = {}): ServerRuntime {
	const base = {
		cwd: tmp,
		interlinkedDir: join(tmp, ".interlinked"),
		graphCache: new Map(),
		autoCoordStates: new Map<string, AutoCoordinationState>(),
		log: () => {},
		logAlways: () => {},
	};
	return { ...base, ...overrides } as unknown as ServerRuntime;
}

describe("summarizeToolInput", () => {
	it("falls back to tool_name when tool_input is missing", () => {
		expect(summarizeToolInput({ tool_name: "Read" })).toBe("Read");
	});

	it("returns the command truncated to 200 chars", () => {
		const out = summarizeToolInput({ tool_input: { command: "x".repeat(500) } });
		expect(out.length).toBe(200);
	});

	it("returns file_path when command is absent", () => {
		expect(summarizeToolInput({ tool_name: "Edit", tool_input: { file_path: "/a/b.ts" } })).toBe(
			"/a/b.ts",
		);
	});

	it("returns the url truncated when present", () => {
		const out = summarizeToolInput({ tool_input: { url: `https://${"y".repeat(400)}` } });
		expect(out.length).toBe(200);
	});

	it("returns empty string when neither tool_name nor tool_input is present", () => {
		expect(summarizeToolInput({})).toBe("");
	});

	it("falls back to tool_name when tool_input carries none of the three known keys", () => {
		expect(summarizeToolInput({ tool_name: "Grep", tool_input: { pattern: "needle" } })).toBe(
			"Grep",
		);
	});
});

describe("getAutoCoordState", () => {
	it("creates a fresh state for an unseen session", () => {
		const ctx = makeCtx();
		const s = getAutoCoordState(ctx, "sess-1");
		expect(s).toBeDefined();
		expect(ctx.autoCoordStates.has("sess-1")).toBe(true);
	});

	it("returns the same instance on a repeat call (no churn)", () => {
		const ctx = makeCtx();
		const first = getAutoCoordState(ctx, "sess-1");
		const second = getAutoCoordState(ctx, "sess-1");
		expect(second).toBe(first);
	});

	it("keeps separate state per session id", () => {
		const ctx = makeCtx();
		const a = getAutoCoordState(ctx, "a");
		const b = getAutoCoordState(ctx, "b");
		expect(a).not.toBe(b);
	});
});

describe("getGraphForFile", () => {
	it("builds and caches a ProjectGraph keyed by project root", () => {
		writeFileSync(join(tmp, "package.json"), "{}");
		const ctx = makeCtx();
		const g1 = getGraphForFile(ctx, join(tmp, "src", "foo.ts"));
		expect(g1).toBeDefined();
		// Second call for a sibling file in the same project reuses the cache.
		const g2 = getGraphForFile(ctx, join(tmp, "src", "bar.ts"));
		expect(g2).toBe(g1);
		expect(ctx.graphCache.size).toBe(1);
	});

	it("logs the init failure as non-fatal and still caches the graph when initialize throws", () => {
		writeFileSync(join(tmp, "package.json"), "{}");
		const spy = vi.spyOn(ProjectGraph.prototype, "initialize").mockImplementation(() => {
			throw new Error("scan exploded");
		});
		const logs: string[] = [];
		const ctx = makeCtx({ log: (msg: string) => void logs.push(msg) });

		const graph = getGraphForFile(ctx, join(tmp, "src", "foo.ts"));
		spy.mockRestore();

		expect(logs).toHaveLength(1);
		expect(logs.join("\n")).toMatch(
			/^Project graph init failed for .+ \(non-fatal\): Error: scan exploded$/,
		);
		// The failed graph is still cached, so the next edit does not re-scan.
		expect([...ctx.graphCache.values()]).toEqual([graph]);
	});
});
