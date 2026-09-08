import { wireAbsentOptional, parseWire, wireArray, wireBoolean, wireObject, wireOptional, wireString } from "../lib/value-validation.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const uninstallHooksMock = vi.fn();
const manifestPathMock = vi.fn((_cwd: string) => "/fake/manifest.json");

vi.mock("../harness/installer.js", () => ({
	uninstallHooks: (arg: unknown) => uninstallHooksMock(arg),
	manifestPath: (arg: string) => manifestPathMock(arg),
}));

import { uninstallHooksCommand } from "./uninstall-hooks.js";

let writeSpy: ReturnType<typeof vi.spyOn>;
let writes: string[];

beforeEach(() => {
	writes = [];
	writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
		writes.push(String(chunk));
		return true;
	});
	uninstallHooksMock.mockReset();
	manifestPathMock.mockClear();
});

afterEach(() => {
	writeSpy.mockRestore();
});

function setResult(
	removed: Array<{ runner: string; settings_path: string }>,
	remaining: Array<{ runner: string; settings_path: string }>,
) {
	uninstallHooksMock.mockReturnValue({ removed, remaining });
}

function lastCallArg(): { cwd: string; dryRun: boolean; runners?: string[] | undefined } {
	const call = uninstallHooksMock.mock.calls.at(-1);
	if (!call) throw new Error("uninstallHooks was not called");
	return parseWire(call[0], wireObject({ "cwd": wireString, "dryRun": wireBoolean, "runners": wireAbsentOptional(wireOptional(wireArray(wireString))) }), "test JSON value");
}

describe("uninstallHooksCommand — runner parsing (kills parseRunners mutants)", () => {
	// test-contract: invariant — parseRunners([]) means "no runner filter"; the
	// uninstallHooksCommand spread `...(runners.length === 0 ? {} : {runners})`
	// must omit the `runners` key entirely in that case.
	it("undefined runner => no 'runners' key passed (all runners)", async () => {
		setResult([], []);
		await uninstallHooksCommand({});
		const callArg = lastCallArg();
		expect(callArg).not.toHaveProperty("runners");
	});

	// test-contract: invariant — "all" is the documented sentinel for every runner.
	it("'all' runner => no 'runners' key passed", async () => {
		setResult([], []);
		await uninstallHooksCommand({ runner: "all" });
		const callArg = lastCallArg();
		expect(callArg).not.toHaveProperty("runners");
	});

	// test-contract: public-api — comma-separated --runner values are split and
	// whitespace-trimmed before matching against VALID_RUNNERS.
	it("valid comma-separated runners are all included, trimmed", async () => {
		setResult([], []);
		await uninstallHooksCommand({ runner: " codex , cursor " });
		const callArg = lastCallArg();
		expect(callArg.runners).toEqual(["codex", "cursor"]);
	});

	// test-contract: boundary — a typo must never expand into removing every runner.
	it("invalid runner name refuses removal before touching any configuration", async () => {
		setResult([], []);
		await expect(uninstallHooksCommand({ runner: "not-a-real-runner" })).rejects.toThrow("Unknown runner");
		expect(uninstallHooksMock).not.toHaveBeenCalled();
	});
	it.each(["factory-droid", "windsurf", "antigravity", "crush"])("keeps %s removal scoped to that adapter", async runner => {
		setResult([], []);
		await uninstallHooksCommand({ runner });
		expect(lastCallArg().runners).toEqual([runner]);
	});

	// test-contract: public-api — "copilot-cli" is a member of VALID_RUNNERS.
	it("'copilot-cli' is a recognized runner id", async () => {
		setResult([], []);
		await uninstallHooksCommand({ runner: "copilot-cli" });
		const callArg = lastCallArg();
		expect(callArg.runners).toEqual(["copilot-cli"]);
	});

	// test-contract: public-api — "gemini-cli" is a member of VALID_RUNNERS.
	it("'gemini-cli' is a recognized runner id", async () => {
		setResult([], []);
		await uninstallHooksCommand({ runner: "gemini-cli" });
		const callArg = lastCallArg();
		expect(callArg.runners).toEqual(["gemini-cli"]);
	});

	it("recognizes OpenCode and Pi runner ids", async () => {
		setResult([], []);
		await uninstallHooksCommand({ runner: "opencode,pi" });
		const callArg = lastCallArg();
		expect(callArg.runners).toEqual(["opencode", "pi"]);
	});
});

describe("uninstallHooksCommand — dryRun flag plumbing", () => {
	// test-contract: invariant — `options.dryRun === true` must actually be a
	// strict-equality-to-true test: a falsy/undefined dryRun forwards false.
	it("dryRun undefined/false passes dryRun: false to uninstallHooks and prints 'removed'", async () => {
		setResult([], []);
		await uninstallHooksCommand({});
		const callArg = lastCallArg();
		expect(callArg.dryRun).toBe(false);
		expect(writes.join("")).toContain("removed 0 hook registration(s)");
		expect(writes.join("")).not.toContain("would remove");
	});

	// test-contract: invariant — dryRun: true must forward exactly true and
	// select the "would remove" verb text.
	it("dryRun true passes dryRun: true to uninstallHooks and prints 'would remove'", async () => {
		setResult([], []);
		await uninstallHooksCommand({ dryRun: true });
		const callArg = lastCallArg();
		expect(callArg.dryRun).toBe(true);
		expect(writes.join("")).toContain("would remove 0 hook registration(s)");
	});

	// test-contract: public-api — the --json output's `dry_run` field mirrors
	// `options.dryRun === true`, independent of the plain-text verb logic.
	it("json mode: dry_run field is false when dryRun is falsy", async () => {
		setResult([], []);
		await uninstallHooksCommand({ json: true });
		const parsed = JSON.parse(writes.join(""));
		expect(parsed.ok).toBe(true);
		expect(parsed.dry_run).toBe(false);
	});

	// test-contract: public-api — same field, dryRun: true case.
	it("json mode: dry_run field is true when dryRun is true", async () => {
		setResult([], []);
		await uninstallHooksCommand({ json: true, dryRun: true });
		const parsed = JSON.parse(writes.join(""));
		expect(parsed.dry_run).toBe(true);
	});
});

describe("uninstallHooksCommand — remaining-entries block", () => {
	// test-contract: public-api — each removed entry prints as
	// `  ${runner} ← ${settings_path}\n` exactly (StringLiteral mutant guard).
	it("prints per-entry lines for removed entries with exact arrow format", async () => {
		setResult([{ runner: "codex", settings_path: "/a/settings.json" }], []);
		await uninstallHooksCommand({});
		expect(writes).toContain("  codex ← /a/settings.json\n");
	});

	// test-contract: invariant — `result.remaining.length > 0` gates the whole
	// "remaining" block; an empty remaining array must print nothing about it.
	it("remaining.length === 0 => no 'remaining' header or entries printed", async () => {
		setResult([], []);
		await uninstallHooksCommand({});
		const out = writes.join("");
		expect(out).not.toContain("remaining");
	});

	// test-contract: public-api — a non-empty remaining array prints the exact
	// `[interlinked] N remaining:\n` header plus one arrow line per entry.
	it("remaining.length > 0 => prints header with count and each entry line", async () => {
		setResult([], [{ runner: "cursor", settings_path: "/b/settings.json" }]);
		await uninstallHooksCommand({});
		const out = writes.join("");
		expect(out).toContain("[interlinked] 1 remaining:\n");
		expect(writes).toContain("  cursor ← /b/settings.json\n");
	});
});
