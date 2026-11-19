import * as childProcess from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { computeFunctionTokens, selectFunctionTokenAnalyzer } from "./index.js";
import { functionTokenProvenance } from "./provenance.js";

vi.mock("node:child_process", async original => {
	const actual = await original<typeof import("node:child_process")>();
	return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

afterEach(() => { vi.restoreAllMocks(); vi.mocked(childProcess.spawnSync).mockClear(); });

it("keeps runtime token bounds and removes implicit limits only for an explicit foreground survey", () => {
	const spy = vi.spyOn(childProcess, "spawnSync");
	const source = "def f():\n    return 1\n";
	expect(computeFunctionTokens(source, "source.py")?.[0]?.canonicalTokens).toBe(7);
	expect(spy.mock.calls.at(-1)?.[2]).toMatchObject({ timeout: 2_000, maxBuffer: 8 * 1024 * 1024 });
	expect(computeFunctionTokens(source, "source.py", { resourcePolicy: "foreground-survey" })?.[0]?.canonicalTokens).toBe(7);
	expect(spy.mock.calls.at(-1)?.[1]?.slice(0, 4)).toEqual(["-I", "-S", "-B", "-c"]);
	expect(spy.mock.calls.at(-1)?.[2]).toMatchObject({ timeout: 0, maxBuffer: Infinity });
	expect(selectFunctionTokenAnalyzer("source.py", { resourcePolicy: "foreground-survey" })?.compute(source, "source.py")?.[0]?.canonicalTokens).toBe(7);
});

it("uses the same explicit foreground policy for the Python parser-version probe", () => {
	const spy = vi.spyOn(childProcess, "spawnSync");
	expect(functionTokenProvenance(["python"]).adapters[0]?.parserVersion).toMatch(/^Python /);
	expect(spy.mock.calls.at(-1)?.[2]).toMatchObject({ timeout: 2_000 });
	expect(functionTokenProvenance(["python"], { resourcePolicy: "foreground-survey" }).adapters[0]?.parserVersion).toMatch(/^Python /);
	expect(spy.mock.calls.at(-1)?.[2]).toMatchObject({ timeout: 0, maxBuffer: Infinity });
});

it("captures native token metadata beyond eight MiB without executing source", () => {
	const name = "f".repeat(4 * 1024 * 1024 + 1);
	const source = `def ${name}():\n    return 1\nraise RuntimeError('selected source must not execute')\n`;
	expect(computeFunctionTokens(source, "source.py")).toBeNull();
	const entries = computeFunctionTokens(source, "source.py", { resourcePolicy: "foreground-survey" });
	expect(entries?.length).toBe(1);
	expect(entries?.[0]?.name.length).toBe(name.length);
	expect(entries?.[0]?.canonicalTokens).toBe(7);
}, 20_000);

it("keeps malformed native output unavailable in foreground mode", () => {
	vi.spyOn(childProcess, "spawnSync").mockReturnValue({ pid: 0, output: [], status: 0, signal: null, stdout: "invalid-json", stderr: "" });
	expect(computeFunctionTokens("def f(): pass", "source.py", { resourcePolicy: "foreground-survey" })).toBeNull();
});
