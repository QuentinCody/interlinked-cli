import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAdapter } from "../../harness/adapters/index.js";
import { nonNull } from "../non-null.js";
import type { ClientName } from "../settings.js";
import { installAllHooks, uninstallAllHooks } from "../hooks.js";

const MANAGED_CLIENT_CASES = [
	{
		client: "opencode",
		runner: "opencode",
		relativePath: [".opencode", "plugins", "interlinked.ts"],
	},
	{
		client: "pi",
		runner: "pi",
		relativePath: [".pi", "extensions", "interlinked.js"],
	},
] as const;

// `installAllHooks` routes through the adapter installer (the B refactor):
// hooks land in .gemini/settings.json in the adapter command shape
// (`node <binary> --runner gemini-cli --event ...`), and uninstall removes
// every Interlinked entry — including adapter-registered events the legacy
// per-client event lists omitted.

describe("hook installation", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "hooks-install-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("installs Gemini CLI hooks into .gemini/settings.json", () => {
		const results = installAllHooks(tmp, ["gemini"]);

		expect(results[0]?.installed).toBe(true);
		const settingsPath = join(tmp, ".gemini", "settings.json");
		expect(existsSync(settingsPath)).toBe(true);

		const content = readFileSync(settingsPath, "utf-8");
		expect(content).toContain('"BeforeTool"');
		expect(content).toContain('"AfterTool"');
		// Adapter command shape: `node <binary> --runner gemini-cli --event ...`.
		expect(content).toContain("--runner");
		expect(content).toContain("gemini-cli");
	});

	// Review 2026-08-28 (final round): the COMPOSED pin — installAllHooks's
	// returned events must be the adapter's nativeEventNames, not a drifted
	// legacy registry list (which previously disagreed for Gemini and Cursor).
	// Reverting hooks.ts to the legacy list makes these fail.
	it("P: installAllHooks reports the adapter's nine-event Gemini list", () => {
		const results = installAllHooks(tmp, ["gemini"]);
		expect(results[0]?.installed).toBe(true);
		expect(results[0]?.events).toEqual([...nonNull(getAdapter("gemini-cli")).nativeEventNames]);
		expect(results[0]?.events).toHaveLength(9);
	});

	it("P: installAllHooks reports the ADAPTER's event list for Cursor (the 15-vs-18 drift)", () => {
		const results = installAllHooks(tmp, ["cursor"]);
		expect(results[0]?.installed).toBe(true);
		expect(results[0]?.events).toEqual([...nonNull(getAdapter("cursor")).nativeEventNames]);
		expect(results[0]?.events).toHaveLength(18);
	});

	it("removes Gemini CLI hooks, including events the legacy list omitted", () => {
		installAllHooks(tmp, ["gemini"]);
		const results = uninstallAllHooks(tmp, ["gemini"]);
		expect(results[0]?.events.length).toBeGreaterThan(0);

		// The cleaner iterates every event present, so adapter-only events
		// (e.g. AfterModel) are removed too — no Interlinked hook survives.
		const content = readFileSync(join(tmp, ".gemini", "settings.json"), "utf-8");
		expect(content).not.toContain("interlinked-activity");
		expect(content).not.toContain("hook-entry.js");
		expect(content).not.toContain("--runner");
	});

	it.each(MANAGED_CLIENT_CASES)(
		"installs and uninstalls the $client managed provider bridge",
		({ client, runner, relativePath }) => {
			const installed = installAllHooks(tmp, [client]);
			expect(installed[0]?.installed).toBe(true);
			expect(installed[0]?.events).toEqual([...nonNull(getAdapter(runner)).nativeEventNames]);

			const bridgePath = join(tmp, ...relativePath);
			expect(readFileSync(bridgePath, "utf-8")).toMatch(/^\/\/ interlinked-provider-bridge:v1\n/);

			const removed = uninstallAllHooks(tmp, [client]);
			expect(removed[0]?.events).toEqual([...nonNull(getAdapter(runner)).nativeEventNames]);
			expect(existsSync(bridgePath)).toBe(false);
		},
	);

	it("preserves a user-modified managed provider bridge during uninstall", () => {
		installAllHooks(tmp, ["opencode"]);
		const bridgePath = join(tmp, ".opencode", "plugins", "interlinked.ts");
		writeFileSync(bridgePath, `${readFileSync(bridgePath, "utf-8")}\n// user customization\n`);

		const removed = uninstallAllHooks(tmp, ["opencode"]);

		expect(removed).toEqual([
			{
				client: "opencode",
				installed: false,
				events: [],
				error: `managed bridge was modified; preserved ${bridgePath} and its installer manifest row`,
			},
		]);
		expect(readFileSync(bridgePath, "utf-8")).toContain("// user customization");
	});
});

describe("installAllHooks — unknown client", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "hooks-install-unknown-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("reports an error result for a client not in the registry, without touching the filesystem", () => {
		// SAFETY: intentionally bypass ClientName to verify the runtime registry rejects a foreign client without installing hooks.
		const results = installAllHooks(tmp, ["not-a-real-client" as ClientName]);
		expect(results).toEqual([
			{
				client: "not-a-real-client",
				installed: false,
				events: [],
				error: "Unknown client: not-a-real-client",
			},
		]);
	});
});

describe("installAllHooks — Claude ancestor already has hooks", () => {
	let tmp: string;
	let parent: string;
	let child: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "hooks-install-ancestor-"));
		parent = join(tmp, "parent");
		child = join(parent, "child");
		mkdirSync(join(parent, ".git"), { recursive: true });
		mkdirSync(child, { recursive: true });
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("skips installing into a nested checkout when a parent already has Claude hooks", () => {
		const parentInstall = installAllHooks(parent, ["claude"]);
		expect(parentInstall[0]?.installed).toBe(true);

		const childInstall = installAllHooks(child, ["claude"]);
		expect(childInstall[0]?.installed).toBe(false);
		expect(childInstall[0]?.events).toEqual([]);
		expect(childInstall[0]?.error).toContain(`${parent}/.claude/settings.json`);
		expect(childInstall[0]?.error).toContain("interlinked enable");
	});
});

describe("installAllHooks — per-client install failure surfaces installHooks' skip reason", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "hooks-install-malformed-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("reports the underlying installHooks reason when the target settings file is malformed JSON", () => {
		mkdirSync(join(tmp, ".gemini"), { recursive: true });
		writeFileSync(join(tmp, ".gemini", "settings.json"), "{ not valid json");

		const results = installAllHooks(tmp, ["gemini"]);
		expect(results[0]?.installed).toBe(false);
		expect(results[0]?.events).toEqual([]);
		expect(results[0]?.error).toMatch(/malformed JSON/);
	});
});

describe("uninstallAllHooks — unknown client and uninstall failure", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "hooks-uninstall-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("reports an error result for a client not in the registry", () => {
		// SAFETY: intentionally bypass ClientName to verify uninstall reports a foreign client without changing its files.
		const results = uninstallAllHooks(tmp, ["not-a-real-client" as ClientName]);
		expect(results).toEqual([
			{
				client: "not-a-real-client",
				installed: false,
				events: [],
				error: "Unknown client: not-a-real-client",
			},
		]);
	});

	it("reports no events removed when there is nothing to uninstall (uninstall returns false)", () => {
		const results = uninstallAllHooks(tmp, ["gemini"]);
		expect(results).toEqual([{ client: "gemini", installed: false, events: [] }]);
	});

	it("catches an uninstall-time exception and reports it as an error result", () => {
		installAllHooks(tmp, ["gemini"]);
		const settingsPath = join(tmp, ".gemini", "settings.json");
		expect(existsSync(settingsPath)).toBe(true);
		// Read-only file: the shared cleaner reads it fine (content differs from
		// the post-clean content, so it proceeds to write) but the write throws
		// EACCES, which is uncaught inside the per-client uninstall function and
		// must be caught by uninstallAllHooks' own try/catch.
		chmodSync(settingsPath, 0o444);
		try {
			const results = uninstallAllHooks(tmp, ["gemini"]);
			expect(results[0]?.installed).toBe(false);
			expect(results[0]?.events).toEqual([]);
			expect(typeof results[0]?.error).toBe("string");
			expect(results[0]?.error?.length).toBeGreaterThan(0);
		} finally {
			chmodSync(settingsPath, 0o644);
		}
	});
});
