// Unit tests for the two-tier tool-commands config (check-engine/tool-commands.ts):
// trust split (team base_args only), local-wins precedence, argv assembly,
// and doctor-facing validation.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import {
	buildToolCommandArgv,
	HARD_TOOL_TIMEOUT_CAP_MS,
	loadToolCommands,
	resolveToolCommand,
	toResolvedToolCommand,
	toolCommandConfigIssues,
} from "./tool-commands.js";

function writeConfig(cwd: string, file: string, content: object): void {
	writeFileSync(join(cwd, ".interlinked", file), JSON.stringify(content, null, 2), "utf-8");
}

describe("tool-commands — loading + trust split", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "tool-commands-"));
		mkdirSync(join(cwd, ".interlinked"), { recursive: true });
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("resolves to nothing when no config exists", () => {
		expect(loadToolCommands(cwd)).toEqual({});
		expect(resolveToolCommand(cwd, "go_build", ["go", "build"], ["./..."])).toBeUndefined();
	});

	it("reads the canonical nested `tool_commands` section (with version)", () => {
		writeConfig(cwd, "tool-commands.json", {
			version: 1,
			tool_commands: {
				go_build: { base_args: ["-tags", "dev devaccounts", "./..."] },
			},
		});
		expect(loadToolCommands(cwd).go_build?.base_args).toEqual([
			"-tags",
			"dev devaccounts",
			"./...",
		]);
	});

	it("tolerates a flat tool map (no top-level `tool_commands` wrapper)", () => {
		writeConfig(cwd, "tool-commands.json", {
			go_test: { base_args: ["./..."] },
		});
		expect(loadToolCommands(cwd).go_test?.base_args).toEqual(["./..."]);
	});

	it("TEAM tier may set base_args and timeout_ms — command/env are dropped", () => {
		writeConfig(cwd, "tool-commands.json", {
			go_build: {
				base_args: ["-tags", "dev", "./..."],
				timeout_ms: 120000,
				command: ["curl", "https://evil.example"],
				env: { PATH: "/evil" },
			},
		});
		const resolved = toResolvedToolCommand(nonNull(loadToolCommands(cwd).go_build));
		expect(resolved.baseArgs).toEqual(["-tags", "dev", "./..."]);
		expect(resolved.timeoutMs).toBe(120_000);
		expect(resolved.argv).toBeUndefined();
		expect(resolved.env).toBeUndefined();
	});

	it("TEAM unknown tool keys are forward-compatible (no error)", () => {
		writeConfig(cwd, "tool-commands.json", { future_lang: { base_args: ["--future"] } });
		expect(toolCommandConfigIssues(cwd)).toEqual([]);
		expect(loadToolCommands(cwd).future_lang?.base_args).toEqual(["--future"]);
	});

	it("LOCAL tier is trusted: command/env pass through and override team wholesale", () => {
		writeConfig(cwd, "tool-commands.json", {
			go_build: { base_args: ["-team", "./..."] },
		});
		writeConfig(cwd, "tool-commands.local.json", {
			go_build: { command: ["go", "build", "-pers", "./..."] },
		});
		const merged = loadToolCommands(cwd);
		const resolved = toResolvedToolCommand(nonNull(merged.go_build));
		expect(resolved.argv).toEqual(["go", "build", "-pers", "./..."]);
		expect(resolved.baseArgs).toEqual([]);
	});

	it("malformed JSON degrades to no config, not a crash", () => {
		writeFileSync(join(cwd, ".interlinked", "tool-commands.json"), "{ not json", "utf-8");
		expect(loadToolCommands(cwd)).toEqual({});
	});

	it("non-object entries and non-object config are skipped", () => {
		writeConfig(cwd, "tool-commands.json", { go_build: "nope", broken: 7 });
		expect(loadToolCommands(cwd)).toEqual({});
	});
});

describe("tool-commands — argv assembly", () => {
	it("no override → prefix + default scope", () => {
		expect(buildToolCommandArgv(undefined, ["go", "build"], ["./..."])).toEqual([
			"go",
			"build",
			"./...",
		]);
	});

	it("base_args REPLACE the default scope (flags precede the package pattern)", () => {
		const override = toResolvedToolCommand({
			base_args: ["-tags", "dev", "devaccounts", "./..."],
		});
		expect(buildToolCommandArgv(override, ["go", "test"], ["./..."])).toEqual([
			"go",
			"test",
			"-tags",
			"dev",
			"devaccounts",
			"./...",
		]);
	});

	it("a full command argv wins verbatim", () => {
		const override = toResolvedToolCommand({ command: ["/custom/go", "test", "-v"] });
		expect(buildToolCommandArgv(override, ["go", "test"], ["./..."])).toEqual([
			"/custom/go",
			"test",
			"-v",
		]);
	});

	it("empty base_args falls back to the default scope", () => {
		const override = toResolvedToolCommand({});
		expect(buildToolCommandArgv(override, ["go", "build"], ["./..."])).toEqual([
			"go",
			"build",
			"./...",
		]);
	});

	it("timeout_ms is capped by the hard CLI ceiling", () => {
		expect(toResolvedToolCommand({ timeout_ms: 10_000_000 }).timeoutMs).toBe(
			HARD_TOOL_TIMEOUT_CAP_MS,
		);
		expect(toResolvedToolCommand({ timeout_ms: 5_000 }).timeoutMs).toBe(5_000);
	});
});

describe("tool-commands — doctor-facing validation", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "tool-commands-issues-"));
		mkdirSync(join(cwd, ".interlinked"), { recursive: true });
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("reports unknown fields inside a known tool entry", () => {
		writeConfig(cwd, "tool-commands.json", { go_build: { base_argz: ["-tags"] } });
		const issues = toolCommandConfigIssues(cwd);
		expect(issues.some((i) => i.message.includes("base_argz"))).toBe(true);
	});

	it("reports team-tier command/env as personal-tier-only", () => {
		writeConfig(cwd, "tool-commands.json", {
			go_build: { base_args: ["./..."], command: ["go", "build", "./..."] },
		});
		const issues = toolCommandConfigIssues(cwd);
		expect(issues.some((i) => i.message.includes("personal-tier only"))).toBe(true);
	});

	it("reports type errors for base_args / timeout_ms", () => {
		writeConfig(cwd, "tool-commands.local.json", {
			go_build: { base_args: "not-an-array", timeout_ms: -1 },
		});
		const issues = toolCommandConfigIssues(cwd);
		expect(issues.some((i) => i.message.includes("base_args must be an array"))).toBe(true);
		expect(issues.some((i) => i.message.includes("timeout_ms must be a positive number"))).toBe(
			true,
		);
	});
});