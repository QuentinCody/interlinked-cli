// Companion tests for src/harness/route-map/nuxt.ts — Phase A3.

import { describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import { extractEndpoints } from "./nuxt.js";

describe("route-map/nuxt.extractEndpoints", () => {
	it("extracts a route from server/api/users.get.ts", () => {
		const filePath = "/abs/server/api/users.get.ts";
		const [endpoint] = extractEndpoints(filePath, "export default defineEventHandler(() => []);");
		expect(endpoint).toBeDefined();
		expect(nonNull(endpoint).framework).toBe("nuxt");
		expect(nonNull(endpoint).method).toBe("GET");
		expect(nonNull(endpoint).path).toBe("/api/users");
	});

	it("infers method=ALL when filename has no method suffix", () => {
		const filePath = "/abs/server/api/health.ts";
		const [endpoint] = extractEndpoints(filePath, "export default defineEventHandler(() => 'ok');");
		expect(nonNull(endpoint).method).toBe("ALL");
		expect(nonNull(endpoint).path).toBe("/api/health");
	});

	it("converts [id] segments to :id", () => {
		const filePath = "/abs/server/api/users/[id].get.ts";
		const [endpoint] = extractEndpoints(filePath, "export default defineEventHandler(() => ({}));");
		expect(nonNull(endpoint).path).toBe("/api/users/:id");
		expect(nonNull(endpoint).declared_params.map((p) => p.name)).toContain("id");
	});

	it("returns [] for non-Nuxt files", () => {
		expect(extractEndpoints("/abs/util.ts", "export const x = 1;")).toEqual([]);
	});

	it("returns [] for src/lib/* helper modules even if path looks similar", () => {
		expect(extractEndpoints("/abs/src/lib/api/foo.ts", "export const x = 1;")).toEqual([]);
	});

	it("returns [] when content has no recognized helper AND no `export default`", () => {
		const filePath = "/abs/server/api/users.get.ts";
		// Neither a defineEventHandler-family call nor a default export — the
		// convention's fallback sanity check has nothing to accept on, so the
		// file is rejected even though the path matched the Nuxt convention.
		// Inverting this guard would make the file pass through and produce
		// an endpoint instead of [].
		expect(extractEndpoints(filePath, "export const helper = () => 1;")).toEqual([]);
	});

	it("accepts a bare `export default` function even without a recognized helper call", () => {
		const filePath = "/abs/server/api/users.get.ts";
		// No defineEventHandler/eventHandler/etc, but a default export is
		// present — the fallback sanity check lets this through. Inverting the
		// guard would return [] here instead of an endpoint.
		const [endpoint] = extractEndpoints(filePath, "export default function handler() { return 1; }");
		expect(nonNull(endpoint).path).toBe("/api/users");
		expect(nonNull(endpoint).method).toBe("GET");
	});
});
