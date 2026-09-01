// Companion tests for src/harness/route-map.ts (dispatcher) — Phase A3.
// Cover the bulk + per-file APIs, the back-compat RouteInfo projection,
// and the getRouteContext string format used by structural-checks.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { nonNull } from "../../lib/non-null.js";
import { RouteMap } from "../route-map.js";

let workdir: string;
let expressFile: string;
let mcpFile: string;

beforeAll(() => {
	workdir = mkdtempSync(join(tmpdir(), "interlinked-route-map-"));
	expressFile = join(workdir, "api.ts");
	writeFileSync(
		expressFile,
		[
			"const app = express();",
			"function getHealth(req, res) { res.json({}); }",
			"app.get('/health', getHealth);",
			"app.post('/items', (req, res) => res.json({}));",
		].join("\n"),
	);
	mcpFile = join(workdir, "mcp.ts");
	writeFileSync(mcpFile, "server.tool('do_thing', {}, async () => ({}));\n");
});

afterAll(() => {
	rmSync(workdir, { recursive: true, force: true });
});

describe("RouteMap dispatcher", () => {
	it("extractAllEndpoints returns endpoints across initialized files", () => {
		const map = new RouteMap(workdir);
		map.initialize([expressFile, mcpFile]);
		const all = map.extractAllEndpoints();
		expect(all.length).toBeGreaterThanOrEqual(3);
		expect(all.some((e) => e.framework === "express")).toBe(true);
		expect(all.some((e) => e.framework === "mcp")).toBe(true);
	});

	it("extractEndpointsForFile re-scans when content is provided", () => {
		const map = new RouteMap(workdir);
		map.initialize([expressFile]);
		const before = map.extractEndpointsForFile(expressFile);
		expect(before.length).toBe(2);
		const after = map.extractEndpointsForFile(
			expressFile,
			"app.get('/only', h);",
		);
		expect(after.length).toBe(1);
	});

	it("getRoutesForFile projects Endpoint → RouteInfo for back-compat", () => {
		const map = new RouteMap(workdir);
		map.initialize([expressFile]);
		const routes = map.getRoutesForFile(expressFile);
		expect(routes.every((r) => r.handler_file === expressFile)).toBe(true);
		expect(routes.some((r) => r.method === "GET" && r.path === "/health")).toBe(true);
	});

	it("getRouteContext returns a 'This file handles: ...' string", () => {
		const map = new RouteMap(workdir);
		map.initialize([expressFile]);
		const ctx = map.getRouteContext(expressFile);
		expect(ctx).not.toBeNull();
		expect(ctx).toContain("GET /health");
	});

	it("getRouteContext returns null when the file has no routes", () => {
		const map = new RouteMap(workdir);
		const ctx = map.getRouteContext(join(workdir, "no-such-file.ts"));
		expect(ctx).toBeNull();
	});

	it("updateFile clears stale routes and re-scans", () => {
		const dynFile = join(workdir, "dynamic.ts");
		writeFileSync(dynFile, "app.get('/first', h);");
		const map = new RouteMap(workdir);
		map.initialize([dynFile]);
		expect(map.extractEndpointsForFile(dynFile)).toHaveLength(1);
		writeFileSync(dynFile, "app.get('/first', h);\napp.post('/second', h);");
		map.updateFile(dynFile);
		expect(map.extractEndpointsForFile(dynFile)).toHaveLength(2);
	});

	it("Python files only consult the FastAPI adapter", () => {
		const pyFile = join(workdir, "main.py");
		writeFileSync(
			pyFile,
			"@app.get('/items')\ndef list_items():\n    return []",
		);
		const map = new RouteMap(workdir);
		map.initialize([pyFile]);
		const endpoints = map.extractEndpointsForFile(pyFile);
		expect(endpoints.length).toBe(1);
		expect(nonNull(endpoints[0]).framework).toBe("fastapi");
	});
});
