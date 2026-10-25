// Mutation-hardening tests for endpoint-security.ts (Campaign A, 2026-10-21).
// Each test pins one behavior that the module header / detector comments state
// and that an injected single-change mutant of the module could silently break.
import { describe, expect, it } from "vitest";

import { validate as validateSanitizers } from "../sanitizer-registry.js";
import { defaultConfig } from "../security-config.js";
import type { Endpoint } from "../types/session.js";
import {
	checkEndpointAuthMissing,
	checkEndpointIdorShape,
	checkEndpointMissingTenantFilter,
	checkEndpointSsrfShape,
} from "./endpoint-security.js";

const FILE = "/srv/app/routes.ts";
const OTHER_FILE = "/srv/app/other-routes.ts";
const CONFIG = defaultConfig();
const NO_SANITIZERS = validateSanitizers({});

function ep(over: Partial<Endpoint> = {}): Endpoint {
	return {
		framework: "express",
		method: "GET",
		path: "/things/:id",
		file: FILE,
		line: 1,
		auth_chain: [],
		declared_params: [],
		...over,
	};
}

describe("endpoint-security mutation hardening", () => {
	// Basis: endpoint-security.ts:107 SAFE_METHODS names OPTIONS and HEAD as the safe methods;
	// the lookup upper-cases the method (line 131), so HTTP method case must not matter.
	it("treats lower-case options/head methods as safe (no auth finding)", () => {
		const eps = [ep({ method: "options" }), ep({ method: "head", path: "/h" })];
		expect(checkEndpointAuthMissing(FILE, "x", eps, CONFIG)).toEqual([]);
	});

	// Basis: endpoint-security.ts:139 message and :108-109 regex name currentUser as a recognized
	// auth middleware, including at router mount level (:147-150).
	it("treats a mount-level app.use(currentUser) as recognized auth", () => {
		const content = "app.use(currentUser);\napp.post('/x', h);";
		const eps = [ep({ method: "POST", path: "/x", line: 2 })];
		expect(checkEndpointAuthMissing(FILE, content, eps, CONFIG)).toEqual([]);
	});

	// Basis: endpoint-security.ts:167-170 condition 3: a DB-style call using the param as key;
	// delete/update calls are DB-style calls (:179).
	it("flags an IDOR shape when the path param keys a delete call", () => {
		const content = "app.delete('/posts/:id', (req, res) => {\n  db.delete(req.params.id);\n});";
		const eps = [
			ep({
				method: "DELETE",
				path: "/posts/:id",
				declared_params: [{ name: "id", source: "path" }],
			}),
		];
		const f = checkEndpointIdorShape(FILE, content, eps, CONFIG);
		expect(f.map((x) => x.check_id)).toEqual(["endpoint_idor_shape"]);
	});

	it("flags an IDOR shape when the path param keys an update call", () => {
		const content = "app.put('/posts/:id', (req, res) => {\n  db.update(req.params.id, {});\n});";
		const eps = [
			ep({ method: "PUT", path: "/posts/:id", declared_params: [{ name: "id", source: "path" }] }),
		];
		expect(checkEndpointIdorShape(FILE, content, eps, CONFIG)).toHaveLength(1);
	});

	// Basis: endpoint-security.ts:58-59 and :66: the handler scope runs 200 lines forward.
	// A sink on the 200th line of the scope (route line + 199) is inside it.
	it("includes the 200th line from the route line in the handler scope", () => {
		const lines = ["app.get('/a/:id', (req, res) => {"];
		while (lines.length < 199) lines.push("  // filler");
		lines.push("  db.findOne(req.params.id);"); // line 200
		const eps = [ep({ path: "/a/:id", declared_params: [{ name: "id", source: "path" }] })];
		expect(checkEndpointIdorShape(FILE, lines.join("\n"), eps, CONFIG)).toHaveLength(1);
	});

	// Basis: endpoint-security.ts:55 "the next route-registration line" bounds the scope; a second
	// endpoint on the same line is not a later route, so the first keeps its body.
	it("does not truncate the handler scope for an endpoint registered on the same line", () => {
		const content = "app.get('/a/:id', (req, res) => { db.findOne(req.params.id); });";
		const eps = [
			ep({ path: "/a/:id", declared_params: [{ name: "id", source: "path" }] }),
			ep({ path: "/b/:id", declared_params: [{ name: "id", source: "path" }] }),
		];
		expect(checkEndpointIdorShape(FILE, content, eps, CONFIG)).toHaveLength(2);
	});

	// Basis: endpoint-security.ts:55 "the next route-registration line in the same file".
	it("ignores routes from other files when bounding the handler scope", () => {
		const content =
			"app.get('/a/:id', (req, res) => {\n  // nothing\n  db.findOne(req.params.id);\n});";
		const eps = [
			ep({ path: "/a/:id", declared_params: [{ name: "id", source: "path" }] }),
			ep({ path: "/z", file: OTHER_FILE, line: 2 }),
		];
		const f = checkEndpointIdorShape(FILE, content, eps, CONFIG);
		expect(f.map((x) => x.endpoint_path)).toEqual(["/a/:id"]);
	});

	// Basis: endpoint-security.ts:245-247 "if WHERE is dynamically built ... DON'T fire".
	it("does not flag a tenant-less query whose WHERE is built dynamically", () => {
		const content =
			"app.get('/items', async (req, res) => {\n  await prisma.item.findMany({ where: { ...buildWhere(req.query) } });\n});";
		expect(
			checkEndpointMissingTenantFilter(FILE, content, [ep({ path: "/items" })], CONFIG),
		).toEqual([]);
	});

	// Basis: endpoint-security.ts:286-288 "If at least one clause already includes a tenant col ...
	// don't muddy the waters with a finding."
	it("does not flag an endpoint when one of its WHERE clauses has a tenant column", () => {
		const content = [
			"app.get('/items', async (req, res) => {",
			"  await prisma.item.findMany({ where: { org_id: req.org, status: 'open' } });",
			"  await prisma.item.count({ where: { status: 'open' } });",
			"});",
		].join("\n");
		expect(
			checkEndpointMissingTenantFilter(FILE, content, [ep({ path: "/items" })], CONFIG),
		).toEqual([]);
	});

	// Basis: endpoint-security.ts:267-269 normalizes configured exempt table names to lower case,
	// while the table reference in the handler is compared lower-cased (tenant-helpers).
	it("matches configured exempt tables case-insensitively", () => {
		const cfg = defaultConfig();
		cfg.endpoint_missing_tenant_filter.exempt_tables = ["Sessions"];
		const content =
			"app.get('/s', async (req, res) => {\n  await prisma.sessions.findMany({ where: { id: 1 } });\n});";
		expect(checkEndpointMissingTenantFilter(FILE, content, [ep({ path: "/s" })], cfg)).toEqual([]);
	});

	// Basis: endpoint-security.ts:310-312 SSRF condition 1: the handler needs a URL-shaped param.
	it("does not flag an HTTP call to a fixed URL when no param is URL-shaped", () => {
		const content =
			"app.get('/ping', async (req, res) => {\n  await fetch('https://api.example.com/health');\n});";
		expect(
			checkEndpointSsrfShape(FILE, content, [ep({ path: "/ping" })], CONFIG, NO_SANITIZERS),
		).toEqual([]);
	});

	// Basis: endpoint-security.ts:311-313: a declared schema_name of "AnyUrl" is URL-shaped
	// regardless of the param's own name.
	it("treats a param declared with schema AnyUrl as URL-shaped", () => {
		const content = "app.post('/fetch', async (req, res) => {\n  await fetch(req.body.x);\n});";
		const eps = [
			ep({
				method: "POST",
				path: "/fetch",
				declared_params: [{ name: "x", source: "body", schema_name: "AnyUrl" }],
			}),
		];
		const f = checkEndpointSsrfShape(FILE, content, eps, CONFIG, NO_SANITIZERS);
		expect(f.map((x) => x.check_id)).toEqual(["endpoint_ssrf_shape"]);
	});

	// Basis: endpoint-security.ts:381-384 body-based detection of c.req.query/param shapes
	// (regex at :392 names both query and param).
	it("detects a URL-shaped value read through c.req.param in the handler body", () => {
		const content =
			"app.get('/go/:target', async (c) => {\n  await fetch(c.req.param('target'));\n});";
		const eps = [ep({ framework: "hono", path: "/go/:target" })];
		const f = checkEndpointSsrfShape(FILE, content, eps, CONFIG, NO_SANITIZERS);
		expect(f).toHaveLength(1);
	});

	// Basis: endpoint-security.ts:365-367 and :370 read `[async] def name(args)` signature lines.
	it("detects a URL-shaped argument in an async Python handler signature", () => {
		const content = [
			"@app.get('/proxy')",
			"async def proxy(url: str):",
			"    return httpx.get(url)",
		].join("\n");
		const eps = [ep({ framework: "fastapi", path: "/proxy", file: "/srv/app/main.py" })];
		const f = checkEndpointSsrfShape("/srv/app/main.py", content, eps, CONFIG, NO_SANITIZERS);
		expect(f).toHaveLength(1);
	});
});
