import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverSingleTool, discoverTools, formatToolReport, tryBinary } from "../discovery.js";

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

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
		const unavailable = tools.filter((t) => !t.available);
		expect(unavailable.length).toBeGreaterThan(0);
		for (const t of unavailable) {
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

	it("discovers stable TypeScript when the primary compiler cannot spawn", async () => {
		writeFileSync(join(tmp, "tsconfig.json"), "{}");
		const native = await vi.importActual<typeof import("node:child_process")>("node:child_process");
		const missing = native.spawnSync(join(tmp, "missing-tsgo"), ["--version"], { encoding: "utf8", timeout: 5000 });
		const stable = native.spawnSync(process.execPath, ["-e", "console.log('Version 5.9.3')"], { encoding: "utf8", timeout: 5000 });
		const spawn = vi.mocked(spawnSync);
		spawn.mockClear();
		spawn.mockReturnValueOnce(missing).mockReturnValueOnce(stable);
		expect(discoverSingleTool("tsc", tmp)).toEqual({ id: "tsc", available: true, version: "5.9.3" });
		expect(spawn.mock.calls.map(([command, args]) => [command, args])).toEqual([
			["npx", ["tsgo", "--version"]],
			["npx", ["tsc", "--version"]],
		]);
	});

	it("returns undefined for an unknown id", () => {
		const r = discoverSingleTool("not-a-tool", tmp);
		expect(r).toBeUndefined();
	});
});

describe("tryBinary — spawnSync throws synchronously", () => {
	it("returns unavailable when spawnSync throws instead of reporting result.error", () => {
		// An empty command is a string, but Node rejects it synchronously
		// instead of returning the ENOENT result of an absent executable.
		const malformed = {
			versionCmd: [""],
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
