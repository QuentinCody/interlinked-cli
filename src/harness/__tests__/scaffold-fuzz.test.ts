// ===========================================
// Tests — scaffold-fuzz (Phase E)
// ===========================================
// Pure unit tests for the `attachScaffolds(findings, opts)` transformer:
// each test constructs `DetectorFinding[]` and `Endpoint[]` literally,
// runs the transformer, and asserts on the rewritten `message`.
//
// No filesystem, no daemon, no harness state.

import { describe, expect, it } from "vitest";

import { nonNull } from "../../lib/non-null.js";
import type { DetectorFinding } from "../checks/endpoint-security.js";
import { attachScaffolds, polyglotsForPython, polyglotsForTs } from "../scaffold-fuzz.js";
import type { Endpoint } from "../types/session.js";

const TS_FILE = "/tmp/handler.ts";
const PY_FILE = "/tmp/handler.py";

function makeFinding(over: Partial<DetectorFinding> = {}): DetectorFinding {
	return {
		check_id: "endpoint_idor_shape",
		file: TS_FILE,
		line: 1,
		message: "base message",
		endpoint_path: "/api/users/:id",
		endpoint_method: "GET",
		...over,
	};
}

function makeEndpoint(over: Partial<Endpoint> = {}): Endpoint {
	return {
		framework: "express",
		method: "GET",
		path: "/api/users/:id",
		file: TS_FILE,
		line: 1,
		auth_chain: [],
		declared_params: [{ name: "id", source: "path" }],
		...over,
	};
}

function fenceCount(s: string): number {
	const matches = s.match(/```/g);
	return matches ? matches.length : 0;
}

// ===========================================
// 1. Single TS endpoint finding → scaffold appended to message
// ===========================================

describe("attachScaffolds — TS endpoint", () => {
	it("appends a fast-check scaffold containing it.prop, the param, and the path", () => {
		const findings = [makeFinding()];
		const endpoints = [makeEndpoint()];

		const out = attachScaffolds(findings, { endpoints });

		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).message).toMatch(/base message/);
		expect(nonNull(out[0]).message).toMatch(/it\.prop/);
		expect(nonNull(out[0]).message).toContain("id");
		expect(nonNull(out[0]).message).toContain("/api/users/:id");
		expect(nonNull(out[0]).message).toContain("@fast-check/vitest");
	});
});

// ===========================================
// 2. Single FastAPI finding → Hypothesis scaffold
// ===========================================

describe("attachScaffolds — FastAPI endpoint", () => {
	it("appends a Hypothesis @given scaffold with the hypothesis import", () => {
		const findings = [
			makeFinding({
				file: PY_FILE,
				endpoint_path: "/items/{item_id}",
				endpoint_method: "GET",
				check_id: "endpoint_idor_shape",
			}),
		];
		const endpoints = [
			makeEndpoint({
				framework: "fastapi",
				file: PY_FILE,
				path: "/items/{item_id}",
				declared_params: [{ name: "item_id", source: "path" }],
			}),
		];

		const out = attachScaffolds(findings, { endpoints });

		expect(nonNull(out[0]).message).toContain("@given");
		expect(nonNull(out[0]).message).toContain("from hypothesis");
		expect(nonNull(out[0]).message).toContain("import pytest");
		expect(nonNull(out[0]).message).toContain("item_id");
	});
});

// ===========================================
// 3. Finding with no matching endpoint → message unchanged
// ===========================================

describe("attachScaffolds — no matching endpoint", () => {
	it("returns the finding with message unchanged when endpoint cannot be located", () => {
		const findings = [
			makeFinding({
				endpoint_path: "/totally/different",
				endpoint_method: "POST",
			}),
		];
		const endpoints = [makeEndpoint()];

		const out = attachScaffolds(findings, { endpoints });

		expect(nonNull(out[0]).message).toBe("base message");
		expect(fenceCount(nonNull(out[0]).message)).toBe(0);
	});
});

// ===========================================
// 4. Multiple findings on same endpoint → each gets a scaffold; idempotent shape
// ===========================================

describe("attachScaffolds — multiple findings on same endpoint", () => {
	it("appends a scaffold to each finding (same endpoint, same check_id → identical scaffolds)", () => {
		const findings = [makeFinding(), makeFinding()];
		const endpoints = [makeEndpoint()];

		const out = attachScaffolds(findings, { endpoints });

		expect(out).toHaveLength(2);
		expect(nonNull(out[0]).message).toContain("it.prop");
		expect(nonNull(out[1]).message).toContain("it.prop");
		// The appended fenced block is identical for both — pure-function property.
		const block0 = nonNull(out[0]).message.replace("base message\n\n", "");
		const block1 = nonNull(out[1]).message.replace("base message\n\n", "");
		expect(block0).toBe(block1);
	});
});

// ===========================================
// 5. Per-detector polyglot variety
// ===========================================

describe("attachScaffolds — per-detector polyglots", () => {
	it("endpoint_ssrf_shape scaffold contains link-local + localhost URL polyglots", () => {
		const findings = [makeFinding({ check_id: "endpoint_ssrf_shape" })];
		const endpoints = [makeEndpoint()];
		const out = attachScaffolds(findings, { endpoints });
		expect(nonNull(out[0]).message).toContain("169.254.169.254");
		expect(nonNull(out[0]).message).toContain("localhost");
		expect(nonNull(out[0]).message).toContain("file:///etc/passwd");
	});

	it("endpoint_mass_assignment scaffold contains isAdmin / role-owner body injections", () => {
		const findings = [makeFinding({ check_id: "endpoint_mass_assignment" })];
		const endpoints = [makeEndpoint()];
		const out = attachScaffolds(findings, { endpoints });
		expect(nonNull(out[0]).message).toContain("isAdmin");
		expect(nonNull(out[0]).message).toContain("role");
	});

	it("endpoint_idor_shape scaffold contains UUID-shaped values", () => {
		const findings = [makeFinding({ check_id: "endpoint_idor_shape" })];
		const endpoints = [makeEndpoint()];
		const out = attachScaffolds(findings, { endpoints });
		// At least one UUID-like literal must appear.
		expect(nonNull(out[0]).message).toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
	});

	it("endpoint_auth_missing scaffold omits SQL/path polyglots and probes empty auth", () => {
		const findings = [makeFinding({ check_id: "endpoint_auth_missing" })];
		const endpoints = [makeEndpoint()];
		const out = attachScaffolds(findings, { endpoints });
		// Auth-missing scaffold does NOT carry the SQL polyglot.
		expect(nonNull(out[0]).message).not.toContain("DROP TABLE");
		expect(nonNull(out[0]).message).toContain("auth");
	});
});

// ===========================================
// 6. Unknown framework → falls back to TS template
// ===========================================

describe("attachScaffolds — unknown framework fallback", () => {
	it("falls back to TS / fast-check template for non-fastapi frameworks", () => {
		const findings = [makeFinding()];
		const endpoints = [makeEndpoint({ framework: "mcp" })];
		const out = attachScaffolds(findings, { endpoints });
		expect(nonNull(out[0]).message).toContain("@fast-check/vitest");
		expect(nonNull(out[0]).message).not.toContain("from hypothesis");
	});

	it("falls back to TS for sveltekit / nuxt / hono / nextjs", () => {
		const frameworks: Array<Endpoint["framework"]> = ["sveltekit", "nuxt", "hono", "nextjs"];
		for (const fw of frameworks) {
			const findings = [makeFinding()];
			const endpoints = [makeEndpoint({ framework: fw })];
			const out = attachScaffolds(findings, { endpoints });
			expect(nonNull(out[0]).message).toContain("@fast-check/vitest");
		}
	});
});

// ===========================================
// 7. emitFor filter — only requested check_ids get scaffolds
// ===========================================

describe("attachScaffolds — emitFor opt-in", () => {
	it("only IDOR findings get scaffolds; other findings unchanged", () => {
		const findings = [
			makeFinding({ check_id: "endpoint_idor_shape" }),
			makeFinding({ check_id: "endpoint_ssrf_shape" }),
			makeFinding({ check_id: "endpoint_auth_missing" }),
		];
		const endpoints = [makeEndpoint()];

		const out = attachScaffolds(findings, {
			endpoints,
			emitFor: new Set(["endpoint_idor_shape"]),
		});

		expect(nonNull(out[0]).message).toContain("it.prop");
		expect(nonNull(out[1]).message).toBe("base message");
		expect(nonNull(out[2]).message).toBe("base message");
	});
});

// ===========================================
// 8. Mutation safety
// ===========================================

describe("attachScaffolds — purity", () => {
	it("does not mutate the input array or the finding objects", () => {
		const findings = [makeFinding()];
		const original = nonNull(findings[0]);
		const originalMessage = original.message;
		const endpoints = [makeEndpoint()];

		const out = attachScaffolds(findings, { endpoints });

		expect(findings).toHaveLength(1);
		expect(findings[0]).toBe(original);
		expect(nonNull(findings[0]).message).toBe(originalMessage);
		expect(out).not.toBe(findings);
		expect(out[0]).not.toBe(original);
	});

	it("does not mutate the endpoints array", () => {
		const findings = [makeFinding()];
		const endpoint = makeEndpoint();
		const endpoints = [endpoint];
		const originalLine = endpoint.line;
		const originalDeclaredParams = endpoint.declared_params;

		attachScaffolds(findings, { endpoints });

		expect(endpoints).toHaveLength(1);
		expect(endpoints[0]).toBe(endpoint);
		expect(nonNull(endpoints[0]).line).toBe(originalLine);
		expect(nonNull(endpoints[0]).declared_params).toBe(originalDeclaredParams);
	});
});

// ===========================================
// 9. Scaffold rendering — exactly one fenced code block
// ===========================================

describe("attachScaffolds — fence structure", () => {
	it("result message contains exactly one triple-backtick fence pair (2 fences total)", () => {
		const findings = [makeFinding()];
		const endpoints = [makeEndpoint()];
		const out = attachScaffolds(findings, { endpoints });
		expect(fenceCount(nonNull(out[0]).message)).toBe(2);
	});

	it("FastAPI scaffold also has exactly one fenced block", () => {
		const findings = [
			makeFinding({ file: PY_FILE, endpoint_path: "/items/{item_id}" }),
		];
		const endpoints = [
			makeEndpoint({
				framework: "fastapi",
				file: PY_FILE,
				path: "/items/{item_id}",
				declared_params: [{ name: "item_id", source: "path" }],
			}),
		];
		const out = attachScaffolds(findings, { endpoints });
		expect(fenceCount(nonNull(out[0]).message)).toBe(2);
	});
});

// ===========================================
// 10. Endpoint without declared_params → uses default `id`
// ===========================================

describe("attachScaffolds — default param fallback", () => {
	it("uses a default `id` placeholder when declared_params is empty", () => {
		const findings = [
			makeFinding({ endpoint_path: "/api/things", endpoint_method: "POST" }),
		];
		const endpoints = [
			makeEndpoint({
				path: "/api/things",
				method: "POST",
				declared_params: [],
			}),
		];
		const out = attachScaffolds(findings, { endpoints });
		expect(nonNull(out[0]).message).toMatch(/\bid\b/);
		expect(nonNull(out[0]).message).toContain("it.prop");
	});

	it("prefers a path param over a body param when both are declared", () => {
		const findings = [
			makeFinding({
				endpoint_path: "/api/widgets/:widgetId",
				endpoint_method: "PUT",
			}),
		];
		const endpoints = [
			makeEndpoint({
				path: "/api/widgets/:widgetId",
				method: "PUT",
				declared_params: [
					{ name: "name", source: "body" },
					{ name: "widgetId", source: "path" },
				],
			}),
		];
		const out = attachScaffolds(findings, { endpoints });
		expect(nonNull(out[0]).message).toContain("widgetId");
	});
});

// ===========================================
// Extra: method casing — match findings whose `endpoint_method` casing
// differs from the endpoint's stored casing.
// ===========================================

describe("attachScaffolds — method-casing tolerance", () => {
	it("matches an endpoint registered as 'GET' against a finding tagged 'get'", () => {
		const findings = [makeFinding({ endpoint_method: "get" })];
		const endpoints = [makeEndpoint({ method: "GET" })];
		const out = attachScaffolds(findings, { endpoints });
		expect(nonNull(out[0]).message).toContain("it.prop");
	});
});

// ===========================================
// 11. Endpoint-matching skip branches (findMatchingEndpoint)
// ===========================================
// The three early-`continue` arms of the matcher loop are each exercised
// by giving the finding a single candidate endpoint that differs on
// exactly one axis (file / path / method), then a second endpoint that
// DOES match — proving the loop skips the mismatch and keeps scanning.

describe("attachScaffolds — matcher skip branches", () => {
	it("skips an endpoint in a different file, then matches the right one", () => {
		const findings = [makeFinding()];
		const endpoints = [
			makeEndpoint({ file: "/tmp/other-handler.ts" }), // file mismatch → continue
			makeEndpoint({ file: TS_FILE }), // matches
		];
		const out = attachScaffolds(findings, { endpoints });
		expect(nonNull(out[0]).message).toContain("it.prop");
		expect(fenceCount(nonNull(out[0]).message)).toBe(2);
	});

	it("skips an endpoint whose path differs (same file), then matches", () => {
		const findings = [makeFinding({ endpoint_path: "/api/users/:id" })];
		const endpoints = [
			makeEndpoint({ path: "/api/admins/:id" }), // path mismatch → continue
			makeEndpoint({ path: "/api/users/:id" }), // matches
		];
		const out = attachScaffolds(findings, { endpoints });
		expect(nonNull(out[0]).message).toContain("/api/users/:id");
		expect(nonNull(out[0]).message).not.toContain("/api/admins/:id");
	});

	it("skips an endpoint whose method differs (same file+path), then matches", () => {
		const findings = [
			makeFinding({ endpoint_path: "/api/users/:id", endpoint_method: "DELETE" }),
		];
		const endpoints = [
			makeEndpoint({ path: "/api/users/:id", method: "GET" }), // method mismatch → continue
			makeEndpoint({ path: "/api/users/:id", method: "DELETE" }), // matches
		];
		const out = attachScaffolds(findings, { endpoints });
		expect(nonNull(out[0]).message).toContain("DELETE /api/users/:id");
		// fast-check `it` block uses the DELETE method in the fetch call.
		expect(nonNull(out[0]).message).toContain('method: "DELETE"');
	});

	it("returns finding unchanged when the only candidate differs solely by method", () => {
		// Exercises method-mismatch continue → loop exhausts → undefined.
		const findings = [
			makeFinding({ endpoint_path: "/api/users/:id", endpoint_method: "PATCH" }),
		];
		const endpoints = [makeEndpoint({ path: "/api/users/:id", method: "GET" })];
		const out = attachScaffolds(findings, { endpoints });
		expect(nonNull(out[0]).message).toBe("base message");
		expect(fenceCount(nonNull(out[0]).message)).toBe(0);
	});

	it("matches purely on file when finding omits path and method", () => {
		// endpoint_path / endpoint_method absent → both guard branches are
		// short-circuited, so a same-file endpoint always matches. The keys
		// are omitted entirely (exactOptionalPropertyTypes), not set undefined.
		const finding: DetectorFinding = {
			check_id: "endpoint_idor_shape",
			file: TS_FILE,
			line: 1,
			message: "base message",
		};
		const endpoints = [makeEndpoint({ path: "/whatever", method: "PUT" })];
		const out = attachScaffolds([finding], { endpoints });
		expect(nonNull(out[0]).message).toContain("it.prop");
		expect(nonNull(out[0]).message).toContain("/whatever");
	});
});

// ===========================================
// 12. primaryParamName — non-path param fallback chain
// ===========================================

describe("attachScaffolds — param selection fallbacks", () => {
	it("falls back to the first declared param when no path param exists", () => {
		// declared_params has only a query param → primaryParamName returns it
		// (the `if (anyParam)` arm), not the literal `id` default.
		const findings = [
			makeFinding({ endpoint_path: "/api/search", endpoint_method: "GET" }),
		];
		const endpoints = [
			makeEndpoint({
				path: "/api/search",
				declared_params: [{ name: "queryTerm", source: "query" }],
			}),
		];
		const out = attachScaffolds(findings, { endpoints });
		expect(nonNull(out[0]).message).toContain("queryTerm");
	});
});

// ===========================================
// 13. endpointTestId — Python test-name sanitization + empty fallback
// ===========================================

describe("attachScaffolds — Python test-id sanitization", () => {
	it("sanitizes method+path into a snake_case python test name", () => {
		const findings = [
			makeFinding({
				file: PY_FILE,
				endpoint_path: "/items/{item_id}",
				endpoint_method: "GET",
			}),
		];
		const endpoints = [
			makeEndpoint({
				framework: "fastapi",
				file: PY_FILE,
				path: "/items/{item_id}",
				declared_params: [{ name: "item_id", source: "path" }],
			}),
		];
		const out = attachScaffolds(findings, { endpoints });
		// "GET_/items/{item_id}" → lowercased → non-[a-z0-9_] runs collapse to
		// "_": "get_" + "/items/{item_id}" → "get__items_item_id".
		expect(nonNull(out[0]).message).toContain("def test_get__items_item_id_");
		// No raw braces / slashes survive into the identifier.
		expect(nonNull(out[0]).message).toMatch(/def test_get__items_item_id_rejects_adversarial\(/);
	});

	it("uses the `endpoint` fallback id when method+path sanitize to empty", () => {
		// method "" + path "/" → "_/" → strip non-[a-z0-9_] → "" → "endpoint".
		const findings = [
			makeFinding({ file: PY_FILE, endpoint_path: "/", endpoint_method: "" }),
		];
		const endpoints = [
			makeEndpoint({
				framework: "fastapi",
				file: PY_FILE,
				path: "/",
				method: "",
				declared_params: [{ name: "id", source: "path" }],
			}),
		];
		const out = attachScaffolds(findings, { endpoints });
		expect(nonNull(out[0]).message).toContain("def test_endpoint_rejects_adversarial(");
	});
});

// ===========================================
// 14. FastAPI per-detector scaffolds (auth / mass-assignment)
// ===========================================
// pyAuthScaffold + pyMassAssignScaffold + the shared pyScaffoldBlock
// renderer were previously unexercised — only the generic IDOR Python
// path ran. These drive both per-detector Python templates.

function makePyEndpoint(over: Partial<Endpoint> = {}): Endpoint {
	return makeEndpoint({
		framework: "fastapi",
		file: PY_FILE,
		path: "/items/{item_id}",
		method: "POST",
		declared_params: [{ name: "item_id", source: "path" }],
		...over,
	});
}

function makePyFinding(over: Partial<DetectorFinding> = {}): DetectorFinding {
	return makeFinding({
		file: PY_FILE,
		endpoint_path: "/items/{item_id}",
		endpoint_method: "POST",
		...over,
	});
}

describe("attachScaffolds — FastAPI auth scaffold", () => {
	it("emits a Hypothesis auth scaffold tagged endpoint_auth_missing", () => {
		const out = attachScaffolds([makePyFinding({ check_id: "endpoint_auth_missing" })], {
			endpoints: [makePyEndpoint()],
		});
		const msg = nonNull(out[0]).message;
		expect(msg).toContain("endpoint_auth_missing");
		expect(msg).toContain("from hypothesis");
		expect(msg).toContain("# no auth header");
		expect(msg).toContain("# Expect 401 / 403");
		expect(msg).toContain("def test_post__items_item_id_requires_auth(");
		// lowercased HTTP verb in the client call.
		expect(msg).toContain("await client.post(");
		// auth probe strategy varies text length only — no SQL polyglot.
		expect(msg).not.toContain("DROP TABLE");
		expect(msg).toContain("st.text(min_size=0, max_size=32)");
		expect(fenceCount(msg)).toBe(2);
	});
});

describe("attachScaffolds — FastAPI mass-assignment scaffold", () => {
	it("emits a Hypothesis mass-assignment scaffold with a BODY_INJECTIONS setup block", () => {
		const out = attachScaffolds([makePyFinding({ check_id: "endpoint_mass_assignment" })], {
			endpoints: [makePyEndpoint()],
		});
		const msg = nonNull(out[0]).message;
		expect(msg).toContain("endpoint_mass_assignment");
		// The setup-lines branch of pyScaffoldBlock fires for this detector.
		expect(msg).toContain("BODY_INJECTIONS = [");
		expect(msg).toContain("sampled_from(BODY_INJECTIONS)");
		expect(msg).toContain('"is_admin": True');
		expect(msg).toContain("json=injection");
		expect(msg).toContain("def test_post__items_item_id_mass_assignment(");
		expect(msg).toContain("did not land on the persisted row");
		expect(fenceCount(msg)).toBe(2);
	});
});

// ===========================================
// 15. FastAPI generic-path detectors (ssrf / tenant / default check_id)
// ===========================================
// Drives the remaining live arms of polyglotsForPython through the
// generic Python scaffold (anything that is not auth / mass-assignment).

describe("attachScaffolds — FastAPI generic-path polyglots", () => {
	it("ssrf finding routes through the generic Python scaffold with URL polyglots", () => {
		const out = attachScaffolds([makePyFinding({ check_id: "endpoint_ssrf_shape" })], {
			endpoints: [makePyEndpoint()],
		});
		const msg = nonNull(out[0]).message;
		expect(msg).toContain("169.254.169.254");
		expect(msg).toContain("localhost");
		expect(msg).toContain("POLYGLOTS = [");
		// generic Python scaffold uses sampled_from(POLYGLOTS), not BODY_INJECTIONS
		expect(msg).toContain("sampled_from(POLYGLOTS)");
		expect(msg).not.toContain("BODY_INJECTIONS");
	});

	it("tenant finding routes through the generic Python scaffold with org polyglots", () => {
		const out = attachScaffolds(
			[makePyFinding({ check_id: "endpoint_missing_tenant_filter" })],
			{ endpoints: [makePyEndpoint()] },
		);
		const msg = nonNull(out[0]).message;
		expect(msg).toContain("org_attacker");
		expect(msg).toContain("org_victim");
		expect(msg).toContain("POLYGLOTS = [");
	});

	it("unknown check_id falls back to the generic Python SQL polyglot corpus", () => {
		const out = attachScaffolds([makePyFinding({ check_id: "endpoint_unknown_kind" })], {
			endpoints: [makePyEndpoint()],
		});
		const msg = nonNull(out[0]).message;
		// default case → POLYGLOTS_GENERIC_PY (contains the SQL injection probe).
		expect(msg).toContain("DROP TABLE users");
		expect(msg).toContain("../../../etc/passwd");
	});
});

// ===========================================
// 16. TS generic-path detectors (tenant / default check_id)
// ===========================================

describe("attachScaffolds — TS generic-path polyglots", () => {
	it("tenant finding routes through the generic TS scaffold with org polyglots", () => {
		const out = attachScaffolds(
			[makeFinding({ check_id: "endpoint_missing_tenant_filter" })],
			{ endpoints: [makeEndpoint()] },
		);
		const msg = nonNull(out[0]).message;
		expect(msg).toContain("org_attacker");
		expect(msg).toContain("org_victim");
		expect(msg).toContain("@fast-check/vitest");
	});

	it("unknown check_id falls back to the generic TS SQL polyglot corpus", () => {
		const out = attachScaffolds([makeFinding({ check_id: "endpoint_unknown_kind" })], {
			endpoints: [makeEndpoint()],
		});
		const msg = nonNull(out[0]).message;
		expect(msg).toContain("DROP TABLE users");
		expect(msg).toContain("<script>alert(1)</script>");
	});
});

// ===========================================
// 17. pythonStringLiteral escaping
// ===========================================
// A path containing a backslash and a double-quote must be emitted as a
// safely-escaped Python double-quoted literal inside the generated code.

describe("attachScaffolds — Python string-literal escaping", () => {
	it("escapes backslashes and double-quotes in the endpoint path literal", () => {
		const weirdPath = '/items/{id}\\"x';
		const findings = [
			makeFinding({
				file: PY_FILE,
				endpoint_path: weirdPath,
				endpoint_method: "GET",
			}),
		];
		const endpoints = [
			makeEndpoint({
				framework: "fastapi",
				file: PY_FILE,
				path: weirdPath,
				method: "GET",
				declared_params: [{ name: "id", source: "path" }],
			}),
		];
		const out = attachScaffolds(findings, { endpoints });
		// Backslash doubled, embedded quote backslash-escaped.
		expect(nonNull(out[0]).message).toContain('"/items/{id}\\\\\\"x"');
	});
});

// ===========================================
// 18. Corpus selectors — the mass-assignment arm
// ===========================================
// `synthesizeTsScaffold` / `synthesizePythonScaffold` route
// `endpoint_mass_assignment` to their own builders BEFORE the generic
// scaffold runs, so the selectors' mass-assignment `case` never fires
// through `attachScaffolds`. Drive each selector directly and pin the whole
// corpus: falling through to `default` would yield the SQL/path corpus.

describe("polyglotsForTs", () => {
	it("returns the body-injection corpus for endpoint_mass_assignment", () => {
		expect(polyglotsForTs("endpoint_mass_assignment")).toEqual([
			"{ isAdmin: true }",
			'{ role: "owner" }',
			'{ is_admin: true, role: "owner", org_id: "attacker" }',
			'{ stripeCustomerId: "cus_attacker" }',
		]);
	});
});

describe("polyglotsForPython", () => {
	it("returns the Python body-injection corpus for endpoint_mass_assignment", () => {
		expect(polyglotsForPython("endpoint_mass_assignment")).toEqual([
			'{"is_admin": True}',
			'{"role": "owner"}',
			'{"is_admin": True, "role": "owner", "org_id": "attacker"}',
		]);
	});
});
