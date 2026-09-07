import { describe, expect, it } from "vitest";
import { checkFixedPortInTest } from "./test-isolation-port.js";

function run(content: string, path = "foo.test.ts"): ReturnType<typeof checkFixedPortInTest> {
	return checkFixedPortInTest(content, path);
}

describe("checkFixedPortInTest — positive (must fire)", () => {
	it("flags a direct numeric .listen(port) call", () => {
		const found = run(`it("boots", () => { server.listen(8787); });`);
		expect(found).toHaveLength(1);
		expect(found[0]?.text).toContain("fixed_port_in_test");
	});

	it("flags .listen(port, host) with two positional args", () => {
		const found = run(`it("boots", () => { server.listen(8787, "127.0.0.1"); });`);
		expect(found).toHaveLength(1);
	});

	it("flags .listen({ port: N }) object-form binding", () => {
		const found = run(`it("boots", () => { server.listen({ port: 8787 }); });`);
		expect(found).toHaveLength(1);
	});

	it("flags process.env.PORT fixed-string assignment", () => {
		const found = run(`it("sets env", () => { process.env.PORT = "8787"; });`);
		expect(found).toHaveLength(1);
	});

	it("flags a fetch() call against a fixed-port URL literal", () => {
		const found = run(`it("hits server", async () => { await fetch("http://127.0.0.1:8787/health"); });`);
		expect(found).toHaveLength(1);
	});

	it("flags new WebSocket() against a fixed-port URL literal", () => {
		const found = run(`it("connects", () => { new WebSocket("ws://localhost:8787"); });`);
		expect(found).toHaveLength(1);
	});

	it("flags createServer(...).listen(...) with a port: key in context", () => {
		const found = run(`it("boots", () => { createServer(handler).listen({ port: 9200 }); });`);
		expect(found).toHaveLength(1);
	});

	it("fires once per offending line even with multiple cues", () => {
		const found = run(`it("boots", () => { server.listen(8787); server.listen(8787); });`);
		expect(found).toHaveLength(1);
	});
});

describe("checkFixedPortInTest — negative (must not fire)", () => {
	it("does not flag listen(0) — OS-assigned ephemeral port", () => {
		expect(run(`it("boots", () => { server.listen(0); });`)).toEqual([]);
	});

	it("does not flag port: 0 in an options object", () => {
		expect(run(`it("boots", () => { server.listen({ port: 0 }); });`)).toEqual([]);
	});

	it("does not flag a port read back from server.address()", () => {
		expect(run(`it("boots", () => { server.listen(0); const p = server.address().port; fetch(\`http://127.0.0.1:\${p}\`); });`)).toEqual([]);
	});

	it("does not flag a sub-1024 URL literal used as a deliberate unreachable upstream", () => {
		expect(run(`it("fails over", async () => { await fetch("http://127.0.0.1:9"); });`)).toEqual([]);
	});

	it("does not flag a fixed port appearing only in an assertion", () => {
		expect(run(`it("reports url", () => { expect(url).toBe("http://127.0.0.1:8787"); });`)).toEqual([]);
	});

	it("does not flag a fixed-port bind inside an it.skip block", () => {
		expect(run(`it.skip("boots", () => { server.listen(8787); });`)).toEqual([]);
	});

	it("does not flag a fixed-port bind inside a describe.todo block", () => {
		expect(run(`describe.todo("legacy", () => { it("boots", () => { server.listen(8787); }); });`)).toEqual([]);
	});

	it("does not flag a commented-out fixed port bind", () => {
		expect(run(`it("boots", () => { // server.listen(8787);\n server.listen(0); });`)).toEqual([]);
	});

	it("does not flag a non-test file", () => {
		expect(run(`server.listen(8787);`, "src/server.ts")).toEqual([]);
	});

	it("does not flag a variable named port used as the listen argument", () => {
		expect(run(`it("boots", () => { const port = 0; server.listen(port); });`)).toEqual([]);
	});
});
