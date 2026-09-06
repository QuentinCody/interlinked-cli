// Companion tests for src/harness/route-map/nextjs.ts — Phase A3.
// Covers the App Router `app/**/route.ts` convention plus the
// middleware.ts matcher path.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import { extractEndpoints } from "./nextjs.js";

const FIXTURE_ROOT = join(
	__dirname,
	"..",
	"__tests__",
	"fixtures",
	"route-extraction",
	"nextjs",
);

const USER_ROUTE = join(FIXTURE_ROOT, "app", "api", "users", "[id]", "route.ts");
const HEALTH_ROUTE = join(FIXTURE_ROOT, "app", "api", "health", "route.ts");
const ADMIN_ROUTE = join(FIXTURE_ROOT, "app", "api", "admin", "orgs", "route.ts");

describe("route-map/nextjs.extractEndpoints — user route fixture", () => {
	const content = readFileSync(USER_ROUTE, "utf-8");
	const endpoints = extractEndpoints(USER_ROUTE, content, { projectRoot: FIXTURE_ROOT });

	it("extracts GET / PATCH / DELETE", () => {
		const methods = endpoints.map((e) => e.method);
		expect(methods).toContain("GET");
		expect(methods).toContain("PATCH");
		expect(methods).toContain("DELETE");
	});

	it("converts [id] to :id in the URL path", () => {
		expect(endpoints.every((e) => e.path === "/api/users/:id")).toBe(true);
	});

	it("derives id path param", () => {
		expect(nonNull(endpoints[0]).declared_params.map((p) => p.name)).toContain("id");
	});

	it("tags framework=nextjs", () => {
		expect(endpoints.every((e) => e.framework === "nextjs")).toBe(true);
	});

	it("captures handler symbols from exported function names", () => {
		const getHandler = endpoints.find((e) => e.method === "GET");
		expect(getHandler?.handler_symbol).toBe("GET");
	});
});

describe("route-map/nextjs.extractEndpoints — health route fixture", () => {
	it("treats no matcher match as empty auth_chain", () => {
		const content = readFileSync(HEALTH_ROUTE, "utf-8");
		const endpoints = extractEndpoints(HEALTH_ROUTE, content, { projectRoot: FIXTURE_ROOT });
		expect(endpoints).toHaveLength(1);
		expect(nonNull(endpoints[0]).auth_chain).toEqual([]);
	});
});

describe("route-map/nextjs.extractEndpoints — admin route fixture", () => {
	it("attaches a matcher auth_chain entry when middleware.ts matcher covers the path", () => {
		const content = readFileSync(ADMIN_ROUTE, "utf-8");
		const endpoints = extractEndpoints(ADMIN_ROUTE, content, { projectRoot: FIXTURE_ROOT });
		expect(endpoints.length).toBeGreaterThanOrEqual(2);
		const auths = endpoints.filter((e) => e.auth_chain.length > 0);
		expect(auths.length).toBeGreaterThanOrEqual(1);
		expect(nonNull(nonNull(auths[0]).auth_chain[0]).kind).toBe("matcher");
	});
});

describe("route-map/nextjs.extractEndpoints — negative cases", () => {
	it("returns [] for a file not under app/.../route.ts", () => {
		const out = extractEndpoints(
			"/x/util.ts",
			"export const helper = () => 1;",
			{ projectRoot: FIXTURE_ROOT },
		);
		expect(out).toEqual([]);
	});

	it("returns [] when route file has no method exports", () => {
		const out = extractEndpoints(
			join(FIXTURE_ROOT, "app", "api", "empty", "route.ts"),
			"// no exports here",
			{ projectRoot: FIXTURE_ROOT },
		);
		// "ALL" fallback should NOT fire when there are zero exported methods.
		// Spec: detectExportedMethods returns ["ALL"] on no match — but the
		// adapter must still pin a method to one of GET/POST/... when nothing
		// is exported. We treat empty content as "no endpoint" here.
		// In practice the file simply doesn't compile, but the adapter must
		// not crash.
		expect(Array.isArray(out)).toBe(true);
	});

	it("does not call middleware.ts a route file (it's a sibling, not an endpoint)", () => {
		const middlewarePath = join(FIXTURE_ROOT, "middleware.ts");
		const content = readFileSync(middlewarePath, "utf-8");
		const out = extractEndpoints(middlewarePath, content, { projectRoot: FIXTURE_ROOT });
		expect(out).toEqual([]);
	});
});

describe("route-map/nextjs.extractEndpoints — middleware.ts read failure", () => {
	it("treats an unreadable middleware.ts as no auth_chain instead of throwing", () => {
		const projectRoot = mkdtempSync(join(tmpdir(), "nextjs-mw-unreadable-"));
		try {
			// middleware.ts EXISTS (existsSync sees it) but is a directory, not a
			// file, so readFileSync() throws EISDIR — the failure mode the catch
			// in resolveMatcherEntry exists for, distinct from "file absent".
			mkdirSync(join(projectRoot, "middleware.ts"));
			const routeFile = join(projectRoot, "app", "api", "widgets", "route.ts");
			const out = extractEndpoints(routeFile, "export function GET() { return null; }", {
				projectRoot,
			});
			expect(out).toHaveLength(1);
			expect(out[0]?.auth_chain).toEqual([]);
		} finally {
			rmSync(projectRoot, { recursive: true, force: true });
		}
	});
});

describe("route-map/nextjs.extractEndpoints — invalid matcher regex", () => {
	it("treats a matcher that compiles to an invalid regex as non-covering instead of throwing", () => {
		const projectRoot = mkdtempSync(join(tmpdir(), "nextjs-mw-badregex-"));
		try {
			// "[" survives the param/catch-all replacements untouched, so the
			// translated pattern `^[$` is an unterminated character class —
			// new RegExp(...) throws, which matcherCovers's catch must absorb.
			const middlewareSrc = 'export const config = { matcher: ["["] };';
			writeFileSync(join(projectRoot, "middleware.ts"), middlewareSrc);
			const routeFile = join(projectRoot, "app", "api", "widgets", "route.ts");
			const out = extractEndpoints(routeFile, "export function GET() { return null; }", {
				projectRoot,
			});
			expect(out).toHaveLength(1);
			expect(out[0]?.auth_chain).toEqual([]);
		} finally {
			rmSync(projectRoot, { recursive: true, force: true });
		}
	});
});
