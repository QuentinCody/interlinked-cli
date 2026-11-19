import { describe, expect, it } from "vitest";
import { parseSuite } from "./policy-suites.js";

const SERVICE = { argv: ["node", "server.js", "--port", "{port}"], ready: { kind: "http", path: "/health", status: 200 } };

describe("parseSuite service env placeholders", () => {
	// test-contract: security — a service env value with an unknown placeholder is rejected
	it("rejects an unknown placeholder in a service env value", () => {
		const bad = { id: "api", adapter: "managed-contracts", services: [{ id: "app", ...SERVICE, env: { TOKEN: "{bogus}" } }] };
		expect(() => parseSuite(bad, "s")).toThrow(/unknown placeholder \{bogus\}/);
	});
	// test-contract: public-api — a service env value with the allowed {port} placeholder is kept
	it("keeps an env value that uses the allowed {port} placeholder", () => {
		const ok = { id: "api", adapter: "managed-contracts", services: [{ id: "app", ...SERVICE, env: { PORT_URL: "http://127.0.0.1:{port}" } }] };
		expect(parseSuite(ok, "s").services?.[0]?.env).toEqual({ PORT_URL: "http://127.0.0.1:{port}" });
	});
});
