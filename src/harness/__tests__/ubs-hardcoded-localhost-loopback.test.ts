// Deliberate-loopback exemptions for `ubs_hardcoded_localhost` (pre_block).
// Positives must keep firing; every exemption has its own negative case.

import { describe, expect, it } from "vitest";
import { checkUbsHardcodedLocalhost } from "../checks/ubs-language-specific.js";

const fires = (code: string, path = "src/lib/app.ts") =>
	checkUbsHardcodedLocalhost(code, path).length > 0;

describe("ubs_hardcoded_localhost loopback — positive (must fire)", () => {
	it("P1: fetch to a hardcoded loopback API", () => {
		expect(fires('const r = await fetch("http://localhost:3000/api/users");')).toBe(true);
	});
	it("P2: API base constant", () => {
		expect(fires('const API_BASE = "http://localhost:8080";')).toBe(true);
	});
	it("P11: a bind-shaped call after the loopback URL does not make it a bind address", () => {
		expect(fires('fetch("http://localhost:3000/api").then(handler.bind(this));')).toBe(true);
	});
	it("P12: serve( on the same line as an outbound loopback URL", () => {
		expect(fires('const res = await client.get("http://localhost:8080/x"); serve(res);')).toBe(true);
	});
	it("P3: WebSocket to a loopback literal", () => {
		expect(fires('const ws = new WebSocket("ws://localhost:4000");')).toBe(true);
	});
	it("P4: DB connection string in app code", () => {
		expect(fires('const db = connect("postgres://user@localhost/db");')).toBe(true);
	});
	it("P5: a fetch after an unrelated listen call is still flagged", () => {
		const code = [
			"server.listen(port);",
			"const x = 1;",
			'const r = await fetch("http://localhost:3000/api");',
		].join("\n");
		expect(fires(code)).toBe(true);
	});
	it("P6: loopback URL with a literal port not tied to any DevTools launch", () => {
		const code = [
			'spawn(chrome, ["--remote-debugging-port=9222"]);',
			'await fetch("http://localhost:3000/api");',
		].join("\n");
		expect(fires(code)).toBe(true);
	});
	it("P7: port from a non-env variable is a hardcoded endpoint", () => {
		const code = ["const PORT = 3000;", "const E = `http://127.0.0.1:${PORT}`;"].join("\n");
		expect(fires(code)).toBe(true);
	});
	it("P8: a loopback list element outside a loopback-named list", () => {
		const code = ["const upstreams = [", '  "localhost",', '  "other",', "];"].join("\n");
		expect(fires(code)).toBe(true);
	});
	it("P9: python requests to a baked loopback URL", () => {
		expect(fires('r = requests.get("http://localhost:5000/data")', "src/app/client.py")).toBe(true);
	});
});

describe("ubs_hardcoded_localhost loopback — negative (must not fire)", () => {
	it("N1: the reported CDP endpoint of a Chrome this file launches", () => {
		const code = [
			"const PORT = Number(process.env.DISCORD_ARCHIVE_CDP_PORT ?? 9333);",
			"const ENDPOINT = `http://127.0.0.1:${PORT}`;",
			"spawn(chrome, [`--remote-debugging-port=${PORT}`]);",
		].join("\n");
		expect(fires(code, "scratch/discord-archive/run.ts")).toBe(false);
	});
	it("N2: server.listen with a loopback bind host", () => {
		expect(fires('server.listen(port, "127.0.0.1", resolve);')).toBe(false);
	});
	it("N3: host option passed to listen across lines", () => {
		const code = ["server.listen({", "  port,", '  host: "127.0.0.1",', "});"].join("\n");
		expect(fires(code)).toBe(false);
	});
	it("N4: host option passed to createServer-style serve()", () => {
		const code = ["Bun.serve({", '  hostname: "localhost",', "  fetch,", "});"].join("\n");
		expect(fires(code)).toBe(false);
	});
	it("N5: --host flag", () => {
		expect(fires('const args = ["vite", "--host=127.0.0.1"];')).toBe(false);
		expect(fires('const args = ["vite", "--host", "127.0.0.1"];')).toBe(false);
	});
	it("N6: python bind", () => {
		expect(fires('uvicorn.run(app, host="127.0.0.1", port=8000)', "src/main.py")).toBe(false);
		expect(fires('app.run(host="127.0.0.1")', "src/main.py")).toBe(false);
	});
	it("N7: env-var fallbacks", () => {
		expect(fires('const u = process.env.API_URL ?? "http://localhost:3000";')).toBe(false);
		expect(fires('const h = process.env.HOST || "localhost";')).toBe(false);
		expect(fires('host = os.environ.get("DB_HOST", "localhost")', "src/db.py")).toBe(false);
		expect(fires('host = os.getenv("DB_HOST", "127.0.0.1")', "src/db.py")).toBe(false);
		expect(fires('let h = env::var("HOST").unwrap_or("localhost".into());', "src/main.rs")).toBe(false);
	});
	it("N8: env fallback with the literal on the next line", () => {
		const code = ["const u = process.env.API_URL ??", '  "http://localhost:3000";'].join("\n");
		expect(fires(code)).toBe(false);
	});
	it("N9: loopback comparison and membership", () => {
		expect(fires('if (host === "127.0.0.1") return true;')).toBe(false);
		expect(fires('if ("localhost" === host) return true;')).toBe(false);
		expect(fires('return ["localhost", "127.0.0.1"].includes(h);')).toBe(false);
		expect(fires('const ok = new Set(["localhost", "127.0.0.1"]).has(h);')).toBe(false);
		expect(fires('if host in ("localhost", "127.0.0.1"):', "src/net.py")).toBe(false);
		expect(fires('case "localhost":', "src/net.ts")).toBe(false);
	});
	it("N10: multi-line loopback-named list and isLoopback helper", () => {
		const code = ["const LOOPBACK_HOSTS = new Set([", '  "localhost",', '  "127.0.0.1",', "]);"].join("\n");
		expect(fires(code)).toBe(false);
		expect(fires('const isLoopback = (h) => h === "127.0.0.1";')).toBe(false);
	});
	it("N11: DevTools /json/version probe in a file that launches Chrome", () => {
		const code = [
			'const args = ["--remote-debugging-port=9222"];',
			'const v = await fetch("http://127.0.0.1:9222/json/version");',
		].join("\n");
		expect(fires(code)).toBe(false);
	});
	it("N12: connectOverCDP attach to a local browser", () => {
		const code = 'const b = await chromium.connectOverCDP("http://localhost:9222");';
		expect(fires(code)).toBe(false);
	});
	it("N13: template whose port is read from an env var in the same file", () => {
		const code = [
			"const PORT = Number(process.env.APP_PORT ?? 4000);",
			"const base = `http://localhost:${PORT}/api`;",
		].join("\n");
		expect(fires(code)).toBe(false);
		expect(fires("const b = `http://localhost:${process.env.APP_PORT}`;")).toBe(false);
	});
	it("N14: OAuth callback URL of a loopback server the file itself binds", () => {
		const code = [
			'server.listen(0, "127.0.0.1", () => {});',
			"const redirectUri = `http://localhost:${port}/callback`;",
		].join("\n");
		expect(fires(code)).toBe(false);
	});
	it("N15: a bind-named constant", () => {
		expect(fires('const BIND_HOST = "127.0.0.1";')).toBe(false);
	});
});

describe("ubs_hardcoded_localhost loopback — negative (must not fire) declared bind host", () => {
	it("N17: host constant that the file passes to listen", () => {
		const code = ['const host = "127.0.0.1";', "server.listen(port, host);"].join("\n");
		expect(fires(code)).toBe(false);
	});
	it("P10: host constant never passed to a bind call still fires", () => {
		expect(fires('const host = "127.0.0.1";\nclient.connect(host);')).toBe(true);
	});
});

describe("ubs_hardcoded_localhost loopback — negative (must not fire) bracketed hosts", () => {
	it("N16: IPv6 literal inside a loopback membership array, and a LOOPBACK-named constant", () => {
		expect(fires('const l = ["127.0.0.1", "[::1]"].includes(url.hostname);')).toBe(false);
		expect(fires('const LOOPBACK = "127.0.0.1";')).toBe(false);
	});
});
