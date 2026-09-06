import { afterEach, describe, expect, it, vi } from "vitest";
import * as sanitizerRegistry from "../sanitizer-registry.js";
import {
	_resetSanitizerRegistryCacheForTests,
	checkTaintedToPrivilegedSink,
} from "./tainted-sink.js";

const TS = "src/handlers/admin.ts";

describe("checkTaintedToPrivilegedSink — positive cases", () => {
	it("flags eval(req.body.code) — direct external input to eval", () => {
		const code = [
			"function handler(req: any) {",
			"  return eval(req.body.code);",
			"}",
		].join("\n");
		const out = checkTaintedToPrivilegedSink(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("flags child_process.exec(req.params.cmd) — direct exec of external input", () => {
		const code = [
			'import * as cp from "child_process";',
			"function handler(req: any) {",
			"  cp.exec(req.params.cmd);",
			"}",
		].join("\n");
		const out = checkTaintedToPrivilegedSink(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("flags new Function(req.query.fn) — dynamic function from external", () => {
		const code = [
			"function handler(req: any) {",
			"  const f = new Function(req.query.fn);",
			"  return f();",
			"}",
		].join("\n");
		const out = checkTaintedToPrivilegedSink(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("flags two-step: const cmd = req.body.cmd; exec(cmd);", () => {
		const code = [
			'import { exec } from "child_process";',
			"function handler(req: any) {",
			"  const cmd = req.body.cmd;",
			"  exec(cmd);",
			"}",
		].join("\n");
		const out = checkTaintedToPrivilegedSink(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("flags fs.writeFileSync with external-controlled path", () => {
		const code = [
			'import * as fs from "node:fs";',
			"function handler(req: any) {",
			"  fs.writeFileSync(req.body.path, 'data');",
			"}",
		].join("\n");
		const out = checkTaintedToPrivilegedSink(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});
});

describe("checkTaintedToPrivilegedSink — negative cases (must NOT fire)", () => {
	it("ignores hardcoded sink arguments", () => {
		const code = [
			"function ok() {",
			'  return eval("1 + 1");',
			"}",
		].join("\n");
		expect(checkTaintedToPrivilegedSink(code, TS)).toEqual([]);
	});

	it("ignores when value passes through a known schema validator", () => {
		const code = [
			'import { z } from "zod";',
			"const Cmd = z.string();",
			'import { exec } from "child_process";',
			"function ok(req: any) {",
			"  const cmd = Cmd.parse(req.body.cmd);",
			"  exec(cmd);",
			"}",
		].join("\n");
		expect(checkTaintedToPrivilegedSink(code, TS)).toEqual([]);
	});

	it("ignores non-sink uses of external input", () => {
		const code = [
			"function ok(req: any) {",
			"  console.log(req.body.foo);",
			"  return { echoed: req.body.foo };",
			"}",
		].join("\n");
		expect(checkTaintedToPrivilegedSink(code, TS)).toEqual([]);
	});

	it("ignores process.env reads for control flow (no sink)", () => {
		const code = [
			"function ok() {",
			'  if (process.env.NODE_ENV === "test") return;',
			"  return loadProd();",
			"}",
		].join("\n");
		expect(checkTaintedToPrivilegedSink(code, TS)).toEqual([]);
	});

	it("ignores typeof / Array.isArray / instanceof guard before sink", () => {
		const code = [
			'import { exec } from "child_process";',
			"const allowList = new Set(['ls', 'pwd']);",
			"function ok(req: any) {",
			"  const cmd = req.body.cmd;",
			"  if (typeof cmd !== 'string' || !allowList.has(cmd)) return;",
			"  exec(cmd);",
			"}",
		].join("\n");
		expect(checkTaintedToPrivilegedSink(code, TS)).toEqual([]);
	});
});

describe("checkTaintedToPrivilegedSink — unbalanced sink call", () => {
	// test-contract: bug — a sink call whose opening paren never closes (a
	// truncated/malformed source) must not crash or mis-slice an argument;
	// findCloseParen's "no match within the scan window" fallback returns -1,
	// which extractFirstArg treats as "no argument" and the sink is skipped.
	it("does not flag eval( when its opening paren has no matching close", () => {
		const code = [
			"function handler(req: any) {",
			"  return eval(req.body.code;",
			"}",
		].join("\n");
		expect(checkTaintedToPrivilegedSink(code, TS)).toEqual([]);
	});
});

describe("_resetSanitizerRegistryCacheForTests", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		_resetSanitizerRegistryCacheForTests();
	});

	// test-contract: public-api — the lazy registry cache must actually be
	// clearable. Prove it by making `load()` return a registry that would
	// change the detector's answer, and showing the change only takes effect
	// once the cache is reset (not on the very next call, which still reads
	// the memoized value from before the reset call under test).
	it("drops the memoized registry so the next getRegistry() call reloads it", () => {
		const code = [
			'import { exec } from "child_process";',
			"function handler(req: any) {",
			"  const cmd = req.body.cmd;",
			"  exec(cmd);",
			"}",
		].join("\n");

		const emptyReg = sanitizerRegistry.validate({ version: 1, sanitizers: {} });
		const loadSpy = vi.spyOn(sanitizerRegistry, "load").mockReturnValue(emptyReg);
		_resetSanitizerRegistryCacheForTests();

		// First call populates the cache with the empty registry: no identity
		// sanitizer matches `req.body.cmd`, so the two-step exec is flagged.
		expect(checkTaintedToPrivilegedSink(code, TS).length).toBeGreaterThanOrEqual(1);

		// Swap in a registry whose identity sanitizer matches `req.body.cmd`
		// verbatim — but WITHOUT a reset the stale cached (empty) registry is
		// still what getRegistry() returns, so the same code is still flagged.
		const matchingReg = sanitizerRegistry.validate({
			version: 1,
			sanitizers: { identity: [{ name: "req-body-cmd-ok", kind: "regex", pattern: "req\\.body\\.cmd" }] },
		});
		loadSpy.mockReturnValue(matchingReg);
		expect(checkTaintedToPrivilegedSink(code, TS).length).toBeGreaterThanOrEqual(1);

		// Resetting drops the cache; the next getRegistry() call re-invokes
		// load() and picks up the matching entry, so the assignment is now
		// treated as validated and the sink no longer fires.
		_resetSanitizerRegistryCacheForTests();
		expect(checkTaintedToPrivilegedSink(code, TS)).toEqual([]);
	});
});
