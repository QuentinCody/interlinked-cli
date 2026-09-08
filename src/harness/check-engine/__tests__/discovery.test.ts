import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverSingleTool, discoverTools, formatToolReport, tryBinary } from "../discovery.js";

describe("discoverTools", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "disc-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("returns an entry per registered tool", () => {
		const tools = discoverTools(tmp);
		expect(tools.length).toBeGreaterThan(10);
		// Every entry has id + available shape.
		for (const t of tools) {
			expect(t.id).toBeTruthy();
			expect(typeof t.available).toBe("boolean");
		}
	});

	it("marks unavailable tools with a reason", () => {
		const tools = discoverTools(tmp);
		for (const t of tools.filter((t) => !t.available)) {
			expect(t.reason, `${t.id}`).toBeTruthy();
		}
	});
});

describe("discoverSingleTool", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "disc-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("returns the ToolAvailability for a known tool id", () => {
		const r = discoverSingleTool("tsc", tmp);
		expect(r).toBeDefined();
		expect(r?.id).toBe("tsc");
	});

	it("returns undefined for an unknown id", () => {
		// SAFETY: the invalid tool ID deliberately exercises the runtime unknown-tool fallback outside the declared ID union.
		const r = discoverSingleTool("not-a-tool" as never, tmp);
		expect(r).toBeUndefined();
	});
});

describe("tryBinary — spawnSync throws synchronously", () => {
	it("returns unavailable when spawnSync throws instead of reporting result.error", () => {
		// A non-string `file` argument makes Node's spawnSync throw a
		// TypeError synchronously (distinct from an ENOENT, which surfaces
		// via `result.error` and is handled by the branch above this one).
		// The cast mirrors a malformed spec reaching this internal helper.
		const malformed = {
			// SAFETY: intentionally malformed to force spawnSync's synchronous throw path
			versionCmd: [123 as unknown as string],
			versionRegex: /x/,
		};
		expect(tryBinary(malformed)).toEqual({ available: false });
	});
});

describe("formatToolReport", () => {
	it("renders a multi-line `tool coverage:` report", () => {
		const out = formatToolReport([
			{ id: "tsc", available: true, version: "5.4.0" },
			{ id: "eslint", available: false, reason: "not installed" },
		]);
		expect(out.startsWith("tool coverage:")).toBe(true);
		expect(out).toContain("tsc");
		expect(out).toContain("v5.4.0");
		expect(out).toContain("eslint");
		expect(out).toContain("(not installed)");
	});
});
