// Tests for the registry-call-site shim that bridges the multi-arg
// endpoint-security detectors to the standard `(content, filePath) →
// InlineMatch[]` registry shape. The detector logic itself is exercised
// in `src/harness/__tests__/endpoint-security.test.ts`; here we just
// verify the adapter wiring (project-root discovery, RouteMap construction,
// config/sanitizer loading, finding → InlineMatch conversion, fail-open).
//
// Each adapter:
//   - Returns [] when the file has no endpoints (cheap exit before
//     loading config / sanitizers).
//   - Returns [] when the file is unparsable or the loaders throw
//     (fail-open — never bricks the pipeline on a stray edit).
//   - Returns InlineMatch[] with `line` + `text` mirroring the detector
//     finding's line + message when the detector fires.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import { RouteMap } from "../route-map.js";
import { ProjectGraph } from "../project-graph.js";
import {
	adaptEndpointAuthMissing,
	adaptEndpointIdorShape,
	adaptEndpointMassAssignment,
	adaptEndpointMissingTenantFilter,
	adaptEndpointSsrfShape,
} from "./endpoint-security-adapters.js";

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "interlinked-eps-adapter-"));
	// Mark this directory as a project root so the adapter's findProjectRoot
	// walker terminates here (otherwise it climbs to the real cwd and the
	// per-project cache mixes test runs).
	writeFileSync(join(tmpRoot, "package.json"), JSON.stringify({ name: "fixture" }));
});

afterEach(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
});

describe("endpoint-security-adapters: short-circuit on no endpoints", () => {
	it("returns [] when the file has no detected endpoints", () => {
        const initialize = vi.spyOn(ProjectGraph.prototype, "initialize");
		const file = join(tmpRoot, "plain.ts");
		const content = "export const greet = (name: string) => `Hello ${name}`;";
		writeFileSync(file, content);
		expect(adaptEndpointAuthMissing(content, file)).toEqual([]);
		expect(adaptEndpointIdorShape(content, file)).toEqual([]);
		expect(adaptEndpointMissingTenantFilter(content, file)).toEqual([]);
		expect(adaptEndpointSsrfShape(content, file)).toEqual([]);
		expect(adaptEndpointMassAssignment(content, file)).toEqual([]);
        expect(initialize).not.toHaveBeenCalled();
	});
});

describe("endpoint-security-adapters: fail-open on broken input", () => {
	it("returns [] when given a path that doesn't exist on disk", () => {
		// Detector adapters must never throw on a missing file — same
		// fail-open posture as checkExtraneousDependencies when the
		// nearest package.json is broken.
		const file = join(tmpRoot, "nonexistent.ts");
		expect(adaptEndpointAuthMissing("", file)).toEqual([]);
		expect(adaptEndpointIdorShape("", file)).toEqual([]);
		expect(adaptEndpointMissingTenantFilter("", file)).toEqual([]);
		expect(adaptEndpointSsrfShape("", file)).toEqual([]);
		expect(adaptEndpointMassAssignment("", file)).toEqual([]);
	});
});

describe("endpoint-security-adapters: detector fires (positive case)", () => {
	it("auth_missing fires on an Express route with no recognized auth middleware", () => {
		const file = join(tmpRoot, "routes.ts");
		const content = [
			'import express from "express";',
			"const app = express();",
			'app.get("/admin/users", (req, res) => {',
			"  res.json({ ok: true });",
			"});",
		].join("\n");
		writeFileSync(file, content);
		const matches = adaptEndpointAuthMissing(content, file);
		expect(matches.length).toBeGreaterThan(0);
		const m = matches[0];
		expect(typeof nonNull(m).line).toBe("number");
		expect(typeof nonNull(m).text).toBe("string");
		// The detector's message embeds the endpoint method + path, so a
		// minimum subject check is fine without pinning the exact wording.
		expect(nonNull(m).text.toLowerCase()).toContain("auth");
	});

	it("idor_shape fires when path param feeds a DB key with no auth context", () => {
		const file = join(tmpRoot, "users.ts");
		const content = [
			'import express from "express";',
			"const app = express();",
			'app.get("/users/:id", async (req, res) => {',
			"  const user = await prisma.user.findUnique({ where: { id: req.params.id } });",
			"  res.json(user);",
			"});",
		].join("\n");
		writeFileSync(file, content);
		const matches = adaptEndpointIdorShape(content, file);
		expect(matches.length).toBeGreaterThan(0);
	});

	it("missing_tenant_filter fires when a DB query omits every tenant column", () => {
		const file = join(tmpRoot, "projects.ts");
		const content = [
			"app.get('/api/projects', async (req, res) => {",
			"  const projects = await prisma.project.findMany({ where: { status: 'active' } });",
			"  res.json(projects);",
			"});",
		].join("\n");
		writeFileSync(file, content);
		const matches = adaptEndpointMissingTenantFilter(content, file);
		expect(matches.length).toBeGreaterThan(0);
		const m = matches[0];
		expect(typeof nonNull(m).line).toBe("number");
		expect(nonNull(m).text.toLowerCase()).toContain("tenant");
	});

	it("ssrf_shape fires when a request-supplied URL flows into fetch() unchecked", () => {
		const file = join(tmpRoot, "proxy.ts");
		const content = [
			"app.post('/api/proxy', async (req, res) => {",
			"  const url = req.body.url;",
			"  const r = await fetch(url);",
			"  res.json(await r.json());",
			"});",
		].join("\n");
		writeFileSync(file, content);
		const matches = adaptEndpointSsrfShape(content, file);
		expect(matches.length).toBeGreaterThan(0);
		const m = matches[0];
		expect(typeof nonNull(m).line).toBe("number");
		expect(nonNull(m).text.toLowerCase()).toContain("allow-list");
	});

	it("mass_assignment fires when req.body is spread into a create() call", () => {
		const file = join(tmpRoot, "users.ts");
		const content = [
			"app.post('/api/users', async (req, res) => {",
			"  const user = await prisma.user.create({ data: req.body });",
			"  res.json(user);",
			"});",
		].join("\n");
		writeFileSync(file, content);
		const matches = adaptEndpointMassAssignment(content, file);
		expect(matches.length).toBeGreaterThan(0);
		const m = matches[0];
		expect(typeof nonNull(m).line).toBe("number");
		expect(nonNull(m).text.toLowerCase()).toContain("allowlist");
	});
});

describe("adaptEndpointAuthMissing — negative (must not fire)", () => {
	it("N1: does not fire when the route carries an inline auth chain (app.use(requireAuth) above the route)", () => {
		const file = join(tmpRoot, "routes.ts");
		const content = [
			"app.use(requireAuth);",
			'app.get("/admin/users", (req, res) => {',
			"  res.json({ ok: true });",
			"});",
		].join("\n");
		writeFileSync(file, content);
		expect(adaptEndpointAuthMissing(content, file)).toEqual([]);
	});

	it("N2: does not fire when a mount-level auth middleware appears anywhere in the file (scanForMountLevelAuth is whole-file, not position-scoped)", () => {
		// Auth is wired below the route (would not actually protect it in real
		// Express), but checkEndpointAuthMissing's in-file backstop scans the
		// entire file for `<receiver>.use(<authIdent>)`, not just lines above
		// the route -- this is the documented "second pass" behavior.
		const file = join(tmpRoot, "routes-late-mount.ts");
		const content = [
			'app.get("/admin/users", (req, res) => {',
			"  res.json({ ok: true });",
			"});",
			"app.use(requireAuth);",
		].join("\n");
		writeFileSync(file, content);
		expect(adaptEndpointAuthMissing(content, file)).toEqual([]);
	});
});

describe("adaptEndpointIdorShape — negative (must not fire)", () => {
	it("N1: does not fire when the query is scoped to an auth-context identifier alongside the path param", () => {
		const file = join(tmpRoot, "users-owned.ts");
		const content = [
			'import express from "express";',
			"const app = express();",
			'app.get("/users/:id", async (req, res) => {',
			"  const user = await prisma.user.findUnique({ where: { id: req.params.id, ownerId: req.user.id } });",
			"  res.json(user);",
			"});",
		].join("\n");
		writeFileSync(file, content);
		expect(adaptEndpointIdorShape(content, file)).toEqual([]);
	});

	it("N2: does not fire when the path param is read but never used as a DB key", () => {
		const file = join(tmpRoot, "users-echo.ts");
		const content = [
			'app.get("/users/:id", async (req, res) => {',
			"  const id = req.params.id;",
			"  res.json({ id });",
			"});",
		].join("\n");
		writeFileSync(file, content);
		expect(adaptEndpointIdorShape(content, file)).toEqual([]);
	});
});

describe("adaptEndpointMissingTenantFilter — negative (must not fire)", () => {
	it("N1: does not fire when the WHERE clause already includes a configured tenant column", () => {
		const file = join(tmpRoot, "projects-scoped.ts");
		const content = [
			"app.get('/api/projects', async (req, res) => {",
			"  const projects = await prisma.project.findMany({ where: { org_id: req.user.orgId, status: 'active' } });",
			"  res.json(projects);",
			"});",
		].join("\n");
		writeFileSync(file, content);
		expect(adaptEndpointMissingTenantFilter(content, file)).toEqual([]);
	});

	it("N2: does not fire when the query targets a table on the exempt list (default: sessions)", () => {
		const file = join(tmpRoot, "sessions.ts");
		const content = [
			"app.get('/api/sessions', async (req, res) => {",
			"  const rows = await prisma.session.findMany({ where: { userId: id } });",
			"  res.json(rows);",
			"});",
		].join("\n");
		writeFileSync(file, content);
		expect(adaptEndpointMissingTenantFilter(content, file)).toEqual([]);
	});
});

describe("adaptEndpointSsrfShape — negative (must not fire)", () => {
	it("N1: does not fire when a URL-shaped value is read but never passed to an HTTP client", () => {
		const file = join(tmpRoot, "webhook-store.ts");
		const content = [
			"app.post('/api/webhook', async (req, res) => {",
			"  const webhookUrl = req.body.webhookUrl;",
			"  await prisma.subscription.create({ data: { webhookUrl } });",
			"  res.json({ ok: true });",
			"});",
		].join("\n");
		writeFileSync(file, content);
		expect(adaptEndpointSsrfShape(content, file)).toEqual([]);
	});

	it("N2: does not fire when the URL passes through a registered url-bucket sanitizer first", () => {
		// Register an allow-list-style sanitizer under the `url` sink class so
		// isSanitized() finds it in the handler body.
		mkdirSync(join(tmpRoot, ".interlinked"), { recursive: true });
		writeFileSync(
			join(tmpRoot, ".interlinked", "sanitizers.json"),
			JSON.stringify({
				version: 1,
				sanitizers: {
					url: [{ name: "isAllowedHost", kind: "function", pattern: "isAllowedHost" }],
				},
			}),
		);
		const file = join(tmpRoot, "proxy-validated.ts");
		const content = [
			"app.post('/api/proxy', async (req, res) => {",
			"  const url = req.body.url;",
			"  if (!isAllowedHost(url)) return res.status(400).json({ error: 'blocked' });",
			"  const r = await fetch(url);",
			"  res.json(await r.json());",
			"});",
		].join("\n");
		writeFileSync(file, content);
		expect(adaptEndpointSsrfShape(content, file)).toEqual([]);
	});
});

describe("adaptEndpointMassAssignment — negative (must not fire)", () => {
	it("N1: does not fire when the body is destructured and rebuilt before the create() call", () => {
		const file = join(tmpRoot, "users-destructured.ts");
		const content = [
			"app.post('/api/users', async (req, res) => {",
			"  const { name, email } = req.body;",
			"  const user = await prisma.user.create({ data: req.body });",
			"  res.json(user);",
			"});",
		].join("\n");
		writeFileSync(file, content);
		expect(adaptEndpointMassAssignment(content, file)).toEqual([]);
	});

	it("N2: does not fire when a zod safeParse() call precedes the spread in the handler body", () => {
		const file = join(tmpRoot, "users-safeparse.ts");
		const content = [
			"app.post('/api/users', async (req, res) => {",
			"  const parsed = UserCreateSchema.safeParse(req.body);",
			"  const user = await prisma.user.create({ data: req.body });",
			"  res.json(user);",
			"});",
		].join("\n");
		writeFileSync(file, content);
		expect(adaptEndpointMassAssignment(content, file)).toEqual([]);
	});
});

describe("endpoint-security-adapters: endpoints exist but the detector reports nothing", () => {
	it("returns [] and skips annotation when endpoints are detected but no finding fires", () => {
		// Endpoint exists (GET /api/ping) but its handler makes no DB call, so
		// tenant-filter has nothing to flag -- exercises applyAnnotations'
		// `findings.length === 0` early-return branch.
		const file = join(tmpRoot, "ping.ts");
		const content = [
			"app.get('/api/ping', (req, res) => {",
			"  res.json({ ok: true });",
			"});",
		].join("\n");
		writeFileSync(file, content);
		expect(adaptEndpointMissingTenantFilter(content, file)).toEqual([]);
	});
});

describe("endpoint-security-adapters: catch-all fail-open on adapter-level throw", () => {
	it("returns [] when RouteMap.extractEndpointsForFile throws mid-pipeline", () => {
		const file = join(tmpRoot, "routes.ts");
		const content = [
			'app.get("/admin/users", (req, res) => {',
			"  res.json({ ok: true });",
			"});",
		].join("\n");
		writeFileSync(file, content);
		const spy = vi
			.spyOn(RouteMap.prototype, "extractEndpointsForFile")
			.mockImplementation(() => {
				throw new Error("route-map extraction blew up");
			});
		try {
			expect(adaptEndpointAuthMissing(content, file)).toEqual([]);
		} finally {
			spy.mockRestore();
		}
	});
});
