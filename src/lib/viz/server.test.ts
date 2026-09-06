// Integration tests for the viz server: starts a real loopback server over a
// tiny temp project and drives it with fetch — exercises routing, the graph
// snapshot endpoint, html serving, the SSE stimulus stream, asset resolution,
// extra HTML-lens assets, resilience to a failed warm-up build, and the
// missing-asset / 404 failure paths.

import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ProjectGraph } from "../../harness/project-graph.js";
import { contentTypeFor, resolveVizAsset, startVizServer, type VizServerHandle } from "./server.js";

describe("contentTypeFor", () => {
	it("maps known extensions and defaults the rest", () => {
		expect(contentTypeFor("index.html")).toContain("text/html");
		expect(contentTypeFor("app.js")).toContain("javascript");
		expect(contentTypeFor("theme.css")).toContain("text/css");
		expect(contentTypeFor("data.json")).toContain("application/json");
		expect(contentTypeFor("blob.bin")).toContain("application/octet-stream");
	});
});

describe("resolveVizAsset", () => {
	it("finds the bundled dashboard asset", () => {
		expect(resolveVizAsset("index.html")).toContain("index.html");
	});

	it("returns null for an unknown asset", () => {
		expect(resolveVizAsset("nope-not-an-asset.xyz")).toBeNull();
	});
});

describe("startVizServer", () => {
	let dir: string;
	let activityFile: string;
	let checkFile: string;
	let server: VizServerHandle;

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "viz-srv-"));
		writeFileSync(join(dir, "a.ts"), "export const X = 1;\n");
		writeFileSync(join(dir, "b.ts"), 'import { X } from "./a.js";\nexport const y = X;\n');
		activityFile = join(dir, "activity.jsonl");
		writeFileSync(
			activityFile,
			`${JSON.stringify({ schema_version: 5, ts: "2026-06-23T12:00:00Z", type: "tool_use_start", tool: "Read", tool_input: { file_path: "a.ts" } })}\n`,
		);
		checkFile = join(dir, "check-results.jsonl");
		writeFileSync(
			checkFile,
			`${JSON.stringify({ ts: "2026-06-23T12:00:00Z", tool_use_id: "seed1", decision: "allow", ran: 1, checks: [{ id: "tsc", severity: "info", determinism: "proven" }] })}\n`,
		);
		server = await startVizServer({
			root: dir, port: 0, activityPath: activityFile, checkResultsPath: checkFile, pollMs: 30,
		});
	});

	afterAll(async () => {
		await server.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("binds an ephemeral loopback port", () => {
		expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
		expect(server.port).toBeGreaterThan(0);
	});

	it("serves the graph snapshot at /api/graph", async () => {
		const r = await fetch(`${server.url}/api/graph`);
		expect(r.status).toBe(200);
		expect(r.headers.get("content-type")).toContain("application/json");
		const g = await r.json();
		expect(g.node_count).toBe(2);
		expect(g.nodes.map((n: { id: string }) => n.id).sort()).toEqual(["a.ts", "b.ts"]);
	});

	it("reports health at /api/health", async () => {
		const r = await fetch(`${server.url}/api/health`);
		expect(r.status).toBe(200);
		const h = await r.json();
		expect(h.ok).toBe(true);
		expect(h.node_count).toBe(2);
	});

	it("serves the dashboard html at /", async () => {
		const r = await fetch(`${server.url}/`);
		expect(r.status).toBe(200);
		expect(r.headers.get("content-type")).toContain("text/html");
		expect(await r.text()).toContain("INTERLINKED");
	});

	it("streams hello, seed, and live events over SSE", async () => {
		const r = await fetch(`${server.url}/api/stream`);
		expect(r.status).toBe(200);
		expect(r.headers.get("content-type")).toContain("text/event-stream");
		const body = r.body;
		expect(body).not.toBeNull();
		if (!body) return;
		const reader = body.getReader();
		const dec = new TextDecoder();
		let buf = "";
		const pump = async () => {
			const { value, done } = await reader.read();
			if (value) buf += dec.decode(value);
			return !done;
		};
		await pump();
		expect(buf).toContain("baseline"); // hello comment
		expect(buf).toContain("tool_use_start"); // seeded backlog event
		appendFileSync(
			activityFile,
			`${JSON.stringify({ schema_version: 5, ts: "2026-06-23T12:01:00Z", type: "guard_block", guard_decision: "block", guard_rule_id: "raw_sql_concat" })}\n`,
		);
		for (let i = 0; i < 25 && !buf.includes("raw_sql_concat"); i++) await pump();
		expect(buf).toContain("raw_sql_concat"); // live broadcast event
		// Leave attached; the afterAll close() ends it (active-client cleanup path).
	});

	it("streams hello, seed, and live check decisions over /api/checks", async () => {
		const r = await fetch(`${server.url}/api/checks`);
		expect(r.status).toBe(200);
		expect(r.headers.get("content-type")).toContain("text/event-stream");
		const body = r.body;
		expect(body).not.toBeNull();
		if (!body) return;
		const reader = body.getReader();
		const dec = new TextDecoder();
		let buf = "";
		const pump = async () => {
			const { value, done } = await reader.read();
			if (value) buf += dec.decode(value);
			return !done;
		};
		await pump();
		expect(buf).toContain("checks"); // hello comment
		expect(buf).toContain("seed1"); // seeded backlog check row
		appendFileSync(
			checkFile,
			`${JSON.stringify({ ts: "2026-06-23T12:01:00Z", tool_use_id: "live1", tool: "Edit", file: "src/db.ts", decision: "block", ran: 2, checks: [{ id: "raw_sql_concat", severity: "high", determinism: "proven", phase: "pre_block" }] })}\n`,
		);
		for (let i = 0; i < 25 && !buf.includes("live1"); i++) await pump();
		expect(buf).toContain("live1"); // live broadcast check row
		// Leave attached; the afterAll close() ends it (active-client cleanup path).
	});

	it("404s unknown routes", async () => {
		const r = await fetch(`${server.url}/nope`);
		expect(r.status).toBe(404);
	});

	it("500s when the dashboard asset is missing", async () => {
		const empty = mkdtempSync(join(tmpdir(), "viz-noasset-"));
		const stub = await startVizServer({ root: dir, port: 0, webRoot: empty });
		try {
			const r = await fetch(`${stub.url}/`);
			expect(r.status).toBe(500);
		} finally {
			await stub.close();
			rmSync(empty, { recursive: true, force: true });
		}
	});

	it("serves an extra HTML lens by bare name", async () => {
		const r = await fetch(`${server.url}/mutation-runs.html`);
		expect(r.status).toBe(200);
		expect(r.headers.get("content-type")).toContain("text/html");
		expect(await r.text()).toContain("Mutation Runs");
	});

	it("404s an html-shaped path with no matching lens asset", async () => {
		const r = await fetch(`${server.url}/no-such-lens.html`);
		expect(r.status).toBe(404);
	});
});

describe("startVizServer — graph warm-up failure", () => {
	it("swallows a warm-up build failure and rebuilds the graph on the next request", async () => {
		const dir2 = mkdtempSync(join(tmpdir(), "viz-warmup-"));
		writeFileSync(join(dir2, "only.ts"), "export const Z = 1;\n");
		const initSpy = vi.spyOn(ProjectGraph.prototype, "initialize").mockImplementationOnce(() => {
			throw new Error("warm-up boom");
		});
		const stub = await startVizServer({
			root: dir2,
			port: 0,
			activityPath: join(dir2, "activity.jsonl"),
			checkResultsPath: join(dir2, "check-results.jsonl"),
		});
		try {
			// Wait for the deferred setImmediate warm-up to run and hit the mocked throw.
			for (let i = 0; i < 25 && initSpy.mock.calls.length < 1; i++) {
				await new Promise<void>((resolve) => setImmediate(resolve));
			}
			expect(initSpy.mock.calls.length).toBe(1);
			// The failed warm-up left no cached graph body, so this request rebuilds
			// it from scratch (the mock is now exhausted and calls the real method).
			const r = await fetch(`${stub.url}/api/graph`);
			expect(r.status).toBe(200);
			const g = await r.json();
			expect(g.node_count).toBe(1);
			expect(initSpy.mock.calls.length).toBe(2);
		} finally {
			await stub.close();
			initSpy.mockRestore();
			rmSync(dir2, { recursive: true, force: true });
		}
	});
});
