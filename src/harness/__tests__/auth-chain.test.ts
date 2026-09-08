// Phase A3 — auth-chain.ts unit tests.
// Per-framework positive + negative cases. The auth-chain module is the
// only place where middleware/Depends/matcher resolution lives, so this
// suite is the source of truth for what counts as "an auth marker".

import { describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import { detectAuthChain } from "../auth-chain.js";

describe("detectAuthChain — express", () => {
	it("picks up app.use(requireAuth) above the route", () => {
		const content = [
			"const app = express();",
			"app.use(requireAuth);", // line 2
			"app.get('/x', getX);", // line 3
		].join("\n");
		const chain = detectAuthChain("express", "/abs/app.ts", content, 3);
		expect(chain.map((c) => c.name)).toEqual(["requireAuth"]);
		expect(nonNull(chain[0]).kind).toBe("middleware");
		expect(nonNull(chain[0]).line).toBe(2);
	});

	it("recognizes router.use(authn) where the name matches the auth regex", () => {
		const content = ["const router = Router();", "router.use(authn);", "router.get('/y', getY);"].join(
			"\n",
		);
		expect(detectAuthChain("express", "/abs/r.ts", content, 3).map((c) => c.name)).toEqual([
			"authn",
		]);
	});

	it("recognizes requireUser / verifyToken / sessionUser / currentUser", () => {
		const samples = ["requireUser", "verifyToken", "sessionUser", "currentUser", "authorize"];
		for (const ident of samples) {
			const content = `app.use(${ident});\napp.get('/x', getX);`;
			const chain = detectAuthChain("express", "/abs/app.ts", content, 2);
			expect(chain.map((c) => c.name)).toEqual([ident]);
		}
	});

	it("ignores non-auth middleware like logger / cors / json", () => {
		const content = ["app.use(cors());", "app.use(logger);", "app.get('/x', getX);"].join("\n");
		expect(detectAuthChain("express", "/abs/app.ts", content, 3)).toEqual([]);
	});

	it("ignores .use calls AFTER the route line", () => {
		const content = ["app.get('/x', getX);", "app.use(requireAuth);"].join("\n");
		expect(detectAuthChain("express", "/abs/app.ts", content, 1)).toEqual([]);
	});

	it("returns [] when no middleware sits above the route", () => {
		const content = "app.get('/x', getX);";
		expect(detectAuthChain("express", "/abs/app.ts", content, 1)).toEqual([]);
	});
});

describe("detectAuthChain — hono", () => {
	it("recognizes chained .use(authMiddleware) before the route", () => {
		const content = ["const app = new Hono();", "app.use(authMiddleware);", "app.get('/x', h);"].join(
			"\n",
		);
		const chain = detectAuthChain("hono", "/abs/h.ts", content, 3);
		expect(chain.map((c) => c.name)).toEqual(["authMiddleware"]);
	});

	it("recognizes inline app.use('/admin', requireAuth) before a route", () => {
		const content = ["app.use('/admin', requireAuth);", "app.get('/admin/x', h);"].join("\n");
		const chain = detectAuthChain("hono", "/abs/h.ts", content, 2);
		expect(chain.map((c) => c.name)).toEqual(["requireAuth"]);
	});

	it("ignores non-auth middleware in the chain", () => {
		const content = ["app.use(logger);", "app.get('/x', h);"].join("\n");
		expect(detectAuthChain("hono", "/abs/h.ts", content, 2)).toEqual([]);
	});
});

describe("detectAuthChain — fastapi", () => {
	it("picks up Depends(get_current_user) in the handler signature", () => {
		const content = [
			"@app.get('/items/{id}')",
			"async def read_item(id: int, user: User = Depends(get_current_user)):",
			"    return {}",
		].join("\n");
		const chain = detectAuthChain("fastapi", "/abs/main.py", content, 1);
		expect(chain.map((c) => c.name)).toEqual(["get_current_user"]);
		expect(nonNull(chain[0]).kind).toBe("depends");
	});

	it("picks up route-level dependencies=[Depends(requireAuth)]", () => {
		const content = [
			"@app.get('/items', dependencies=[Depends(requireAuth)])",
			"def list_items():",
			"    return []",
		].join("\n");
		expect(detectAuthChain("fastapi", "/abs/m.py", content, 1).map((c) => c.name)).toEqual([
			"requireAuth",
		]);
	});

	it("ignores Depends(get_db) — non-auth dependency", () => {
		const content = [
			"@app.get('/items')",
			"def list_items(db: Session = Depends(get_db)):",
			"    return []",
		].join("\n");
		expect(detectAuthChain("fastapi", "/abs/m.py", content, 1)).toEqual([]);
	});

	it("returns [] when no Depends() appears in the handler", () => {
		const content = "@app.get('/items')\ndef list_items():\n    return []";
		expect(detectAuthChain("fastapi", "/abs/m.py", content, 1)).toEqual([]);
	});
});

describe("detectAuthChain — nextjs", () => {
	it("returns [] when no middleware.ts file is given via the matcher hook", () => {
		expect(detectAuthChain("nextjs", "/abs/route.ts", "export async function GET() {}", 1)).toEqual(
			[],
		);
	});
});

describe("detectAuthChain — extraNames extension hook", () => {
	// These cases drive nameLooksLikeAuth's `extraNames` fallback path
	// (the Phase A1 sanitizer-registry `identity` bucket). A name that does
	// NOT match AUTH_NAME_RE but DOES appear in extraNames must still count.

	it("recognizes a project-specific identifier supplied via extraNames", () => {
		// `gatekeeper` matches no auth token in the regex; only the extraNames
		// loop can promote it. Express .use form.
		const content = ["app.use(gatekeeper);", "app.get('/x', getX);"].join("\n");
		const chain = detectAuthChain("express", "/abs/app.ts", content, 2, {
			extraNames: ["gatekeeper"],
		});
		expect(chain.map((c) => c.name)).toEqual(["gatekeeper"]);
		expect(nonNull(chain[0]).kind).toBe("middleware");
		expect(nonNull(chain[0]).line).toBe(1);
	});

	it("matches extraNames case-insensitively", () => {
		// Identifier `GateKeeper`, allow-list entry `gatekeeper` — the loop
		// lower-cases both sides before comparing.
		const content = ["app.use(GateKeeper);", "app.get('/x', getX);"].join("\n");
		const chain = detectAuthChain("express", "/abs/app.ts", content, 2, {
			extraNames: ["gatekeeper"],
		});
		expect(chain.map((c) => c.name)).toEqual(["GateKeeper"]);
	});

	it("does NOT promote an identifier absent from a non-empty extraNames list", () => {
		// `gatekeeper` is not in the (non-empty) allow-list, and matches no
		// regex token → loop runs to completion and returns false.
		const content = ["app.use(gatekeeper);", "app.get('/x', getX);"].join("\n");
		const chain = detectAuthChain("express", "/abs/app.ts", content, 2, {
			extraNames: ["someOtherIdentity", "tenantGuard"],
		});
		expect(chain).toEqual([]);
	});

	it("treats an empty extraNames array as no extension (early-return path)", () => {
		// Empty array hits the `extraNames.length === 0` short-circuit, so a
		// non-regex name is rejected without entering the loop.
		const content = ["app.use(gatekeeper);", "app.get('/x', getX);"].join("\n");
		const chain = detectAuthChain("express", "/abs/app.ts", content, 2, {
			extraNames: [],
		});
		expect(chain).toEqual([]);
	});

	it("still matches a regex-recognized name even when extraNames is provided", () => {
		// `requireAuth` matches the regex directly; the extraNames branch is
		// never consulted (regex short-circuits first).
		const content = ["app.use(requireAuth);", "app.get('/x', getX);"].join("\n");
		const chain = detectAuthChain("express", "/abs/app.ts", content, 2, {
			extraNames: ["unrelated"],
		});
		expect(chain.map((c) => c.name)).toEqual(["requireAuth"]);
	});

	it("applies extraNames to the FastAPI Depends() scanner too", () => {
		// extraNames is threaded into detectFastApiChain as well — a custom
		// dependency name not matching the regex is promoted.
		const content = [
			"@app.get('/items')",
			"def list_items(principal = Depends(tenant_principal)):",
			"    return []",
		].join("\n");
		const chain = detectAuthChain("fastapi", "/abs/m.py", content, 1, {
			extraNames: ["tenant_principal"],
		});
		expect(chain.map((c) => c.name)).toEqual(["tenant_principal"]);
		expect(nonNull(chain[0]).kind).toBe("depends");
	});
});

describe("detectAuthChain — frameworks with no in-file auth scan", () => {
	// sveltekit / nuxt / mcp deliberately return [] (their auth model is not
	// expressed as inline middleware/Depends the in-file scanner can read).
	it.each(["sveltekit", "nuxt", "mcp"] as const)("returns [] for %s", (framework) => {
		const content = ["export const load = () => ({});", "app.use(requireAuth);"].join("\n");
		expect(detectAuthChain(framework, "/abs/file.ts", content, 2)).toEqual([]);
	});
});
