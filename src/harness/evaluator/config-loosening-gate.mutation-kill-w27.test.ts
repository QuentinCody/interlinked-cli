// Mutation-kill pass (wave 27) for config-loosening-gate.ts.
//
// Every spawnSync (git) and fs (existsSync/readFileSync) call is mocked —
// no real process spawns, no real disk I/O. Pure string/regex logic is
// exercised directly through the exported functions.

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessEvent } from "../types.js";
import {
	detectConfigLoosening,
	evaluateConfigLooseningForEvent,
	readDiskContent,
	readHeadVersion,
} from "./config-loosening-gate.js";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
vi.mock("node:fs", () => ({ existsSync: vi.fn(), readFileSync: vi.fn() }));

const mockSpawn = vi.mocked(spawnSync);
const mockExists = vi.mocked(existsSync);
const mockReadFile = vi.mocked(readFileSync);

function spawnResult(status: number, stdout: string): SpawnSyncReturns<string> {
	return { status, stdout, stderr: "", pid: 0, output: [], signal: null };
}

function makeWriteEvent(toolInput: Record<string, unknown>, cwd?: string): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "s1",
		agent_source: "claude",
		tool_name: "Write",
		tool_input: toolInput,
		timestamp: "2026-06-07T00:00:00Z",
		...(cwd ? { cwd } : {}),
	};
}

beforeEach(() => {
	vi.resetAllMocks();
	vi.stubEnv("INTERLINKED_DISABLE_BASELINE_GUARD", "");
	mockExists.mockReturnValue(false);
});

afterEach(() => {
	vi.clearAllMocks();
	vi.unstubAllEnvs();
});

describe("config input boundaries", () => {
	it.each([undefined, "/fixture/config-project"])("resolves relative disk reads against the selected cwd (%s)", (cwd) => {
		mockExists.mockReturnValue(true);
		mockReadFile.mockReturnValue("known config bytes");
		expect(readDiskContent("tsconfig.json", cwd)).toBe("known config bytes");
		expect(mockReadFile).toHaveBeenCalledWith(resolve(cwd ?? process.cwd(), "tsconfig.json"), "utf-8");
	});

	it("ignores an event without a tool input", () => {
		const { tool_input: _input, ...event } = makeWriteEvent({});
		expect(evaluateConfigLooseningForEvent(event)).toBeNull();
		expect(mockSpawn).not.toHaveBeenCalled();
	});

	it("honors the daemon bypass for an undecidable strictness write", () => {
		vi.stubEnv("INTERLINKED_DISABLE_BASELINE_GUARD", "1");
		expect(evaluateConfigLooseningForEvent(makeWriteEvent({ file_path: "tsconfig.json" }))).toBeNull();
		expect(mockSpawn).not.toHaveBeenCalled();
	});

	it("fails closed on an unapplicable config patch even without a tool name", () => {
		mockExists.mockReturnValue(true);
		mockReadFile.mockReturnValue('{"compilerOptions":{"strict":true}}');
		const { tool_name: _name, ...event } = makeWriteEvent({
			_raw_patch: "*** Begin Patch\n*** Update File: /repo/tsconfig.json\n@@\n-not the current content\n+{}\n*** End Patch",
		});
		const decision = evaluateConfigLooseningForEvent(event);
		expect(decision).toMatchObject({ decision: "block", rule_id: "config_loosening_gate" });
		expect(decision?.reason).toContain("this tool");
		expect(mockSpawn).not.toHaveBeenCalled();
	});
});

describe("detectConfigLoosening — isConfigFile gate ordering", () => {
	// test-contract: boundary — a filename that fails the strict CONFIG_BASENAME_RE
	// must not be re-admitted by the looser internal tsconfig-path regex.
	it("returns empty for a near-miss tsconfig-like filename isConfigFile rejects", () => {
		expect(
			detectConfigLoosening(
				"tsconfigXYZ.json",
				`{ "compilerOptions": { "strict": true } }`,
				`{ "compilerOptions": { "strict": false } }`,
			),
		).toEqual([]);
	});

	// test-contract: boundary — biome.json must never be routed through the
	// package.json-shaped detector even if it happens to carry an engines field.
	it("does not apply package.json-shaped detection to biome.json", () => {
		const before = `{ "engines": { "node": ">=22.0.0" } }`;
		const after = `{ "engines": { "node": ">=18.0.0" } }`;
		expect(detectConfigLoosening("biome.json", before, after)).toEqual([]);
	});

	// test-contract: boundary — a path merely containing "package.json" as a
	// non-terminal segment must not be treated as the package.json file itself.
	it("does not divert a nested eslintrc path through package.json detection", () => {
		const before = `{ "engines": { "node": ">=22.0.0" } }`;
		const after = `{ "engines": { "node": ">=18.0.0" } }`;
		expect(detectConfigLoosening("package.json/.eslintrc.json", before, after)).toEqual([]);
	});

	// test-contract: boundary — a bare .eslintrc path containing an earlier
	// "tsconfig...json" segment must not be routed through tsconfig detection.
	it("does not divert a bare .eslintrc path through tsconfig detection", () => {
		const before = `{ "compilerOptions": { "strict": true } }`;
		const after = `{ "compilerOptions": { "strict": false } }`;
		expect(detectConfigLoosening("tsconfig.json/.eslintrc", before, after)).toEqual([]);
	});
});

describe("readHeadVersion — rev-parse guard", () => {
	// test-contract: boundary — a failed rev-parse must stop immediately, not
	// fall through to a second git invocation using a garbage repo root.
	it("stops after a failed rev-parse instead of computing a phantom repo root", () => {
		mockSpawn.mockReturnValueOnce(spawnResult(1, ""));
		const result = readHeadVersion("tsconfig.json");
		expect(result).toBe("");
		expect(mockSpawn).toHaveBeenCalledTimes(1);
	});

	// test-contract: boundary — status 0 with empty stdout must still short-circuit
	// (OR semantics, not AND) rather than proceeding with an empty repo root.
	it("stops when rev-parse succeeds but reports no stdout", () => {
		mockSpawn.mockReturnValueOnce(spawnResult(0, ""));
		const result = readHeadVersion("tsconfig.json");
		expect(result).toBe("");
		expect(mockSpawn).toHaveBeenCalledTimes(1);
	});

	// test-contract: boundary — a non-zero status with truthy stdout must still
	// short-circuit on the status check alone.
	it("stops when rev-parse fails despite non-empty stdout", () => {
		mockSpawn.mockReturnValueOnce(spawnResult(1, "some/root"));
		const result = readHeadVersion("tsconfig.json");
		expect(result).toBe("");
		expect(mockSpawn).toHaveBeenCalledTimes(1);
	});
});

describe("readHeadVersion — relative-path escape guard", () => {
	// test-contract: public-api — readHeadVersion's contract is that it passes
	// a forward-slash-normalized `HEAD:<rel>` target to `git show`; since the
	// mocked git process ignores its own input, the constructed arg vector
	// (recorded state on the spy) is the only place this contract is visible.
	it("normalizes backslashes in the relative path passed to git show", () => {
		const cwd = process.cwd();
		mockSpawn
			.mockReturnValueOnce(spawnResult(0, `${cwd}\n`))
			.mockReturnValueOnce(spawnResult(0, "irrelevant"));
		const result = readHeadVersion("some\\path\\tsconfig.json");
		expect(result).toBe("irrelevant");
		expect(mockSpawn.mock.calls[1]).toEqual([
			"git",
			["-C", cwd, "show", "HEAD:some/path/tsconfig.json"],
			expect.objectContaining({ encoding: "utf-8" }),
		]);
	});

	// test-contract: boundary — when the resolved file equals the repo root the
	// relative path is empty; the function must stop rather than issue a second
	// git call with an empty `HEAD:` target.
	it("stops when the resolved path equals the repo root", () => {
		const cwd = process.cwd();
		mockSpawn.mockReturnValueOnce(spawnResult(0, `${cwd}\n`));
		const result = readHeadVersion(cwd);
		expect(result).toBe("");
		expect(mockSpawn).toHaveBeenCalledTimes(1);
	});

	// test-contract: boundary — a resolved path that escapes the reported repo
	// root (rel starts with "..", does not end with "..") must stop; this
	// distinguishes the startsWith check from an endsWith/AND mutation.
	it("stops when the resolved path escapes the reported repo root", () => {
		mockSpawn.mockReturnValueOnce(spawnResult(0, "/tmp/repoRootFake"));
		const result = readHeadVersion("/tmp/other/tsconfig.json");
		expect(result).toBe("");
		expect(mockSpawn).toHaveBeenCalledTimes(1);
	});
});

describe("readHeadVersion — git show guard", () => {
	// test-contract: boundary — a non-zero git-show status must suppress any
	// stdout it happened to emit rather than surfacing it as the HEAD content.
	it("does not surface stdout when git show exits non-zero", () => {
		const cwd = process.cwd();
		mockSpawn
			.mockReturnValueOnce(spawnResult(0, `${cwd}\n`))
			.mockReturnValueOnce(spawnResult(1, "leaked content"));
		expect(readHeadVersion("tsconfig.json")).toBe("");
	});
});

describe("readDiskContent — existsSync guard", () => {
	// test-contract: boundary — a missing file must not be read at all, even if
	// a stale readFileSync mock would happily return content for it.
	it("does not read the file when existsSync reports it missing", () => {
		mockExists.mockReturnValue(false);
		mockReadFile.mockReturnValue("stale content");
		expect(readDiskContent("/nonexistent/tsconfig.json", undefined)).toBeNull();
		expect(mockReadFile).not.toHaveBeenCalled();
	});
});

describe("evaluateConfigLooseningForEvent — outer applicability gate", () => {
	// test-contract: boundary — a non-config file_path must short-circuit before
	// any git process is spawned, even when Write content is present.
	it("short-circuits before any git call when filePath is not a config file", () => {
		const decision = evaluateConfigLooseningForEvent(
			makeWriteEvent({ file_path: "src/lib/foo.ts", content: "hello" }),
		);
		expect(decision).toBeNull();
		expect(mockSpawn).not.toHaveBeenCalled();
	});

	// test-contract: public-api — a bare .eslintrc (no extension) must still be
	// recognized as a config file worth checking (the extension group is
	// optional), and its relative path must resolve against the event's cwd
	// before Git chooses the repository rather than the harness process's cwd.
	it.each([undefined, "/fixture/config-project"])("treats a bare .eslintrc as a config file with cwd %s", cwd => {
		mockSpawn.mockReturnValueOnce(spawnResult(1, ""));
		evaluateConfigLooseningForEvent(makeWriteEvent({ file_path: ".eslintrc", content: "x" }, cwd));
		expect(mockSpawn.mock.calls[0]).toEqual([
			"git",
			["-C", cwd ?? process.cwd(), "rev-parse", "--show-toplevel"],
			expect.objectContaining({ encoding: "utf-8" }),
		]);
	});

	// test-contract: boundary — trailing junk after a recognized config
	// basename (e.g. a backup file) must not be treated as that config file.
	it("does not treat package.json.bak as a config file", () => {
		const decision = evaluateConfigLooseningForEvent(
			makeWriteEvent({ file_path: "package.json.bak", content: "x" }),
		);
		expect(decision).toBeNull();
		expect(mockSpawn).not.toHaveBeenCalled();
	});

	// test-contract: boundary — a malformed edit of a strictness water-line
	// fails closed even if coercing old_string would find a real disk substring.
	it("blocks a non-string old_string without coercing it or comparing a fabricated result to HEAD", () => {
		mockExists.mockReturnValue(true);
		mockReadFile.mockReturnValue('{ "compilerOptions": { "strict": true }, "marker": 42 }');
		const decision = evaluateConfigLooseningForEvent(
			makeWriteEvent({ file_path: "tsconfig.json", old_string: 42, new_string: "43" }),
		);
		expect(decision).toMatchObject({ decision: "block", rule_id: "config_loosening_gate", category: "config" });
		expect(decision?.reason).toContain("no edit entry has string old_string and new_string");
		expect(mockSpawn).not.toHaveBeenCalled();
	});

	// test-contract: boundary — when no content and no reconstructable edit
	// produced a proposed body, refuse the unjudgeable write before a HEAD lookup.
	it("blocks a config write with no proposed body before computing a git HEAD diff", () => {
		const decision = evaluateConfigLooseningForEvent(makeWriteEvent({ file_path: "tsconfig.json" }));
		expect(decision).toMatchObject({ decision: "block", rule_id: "config_loosening_gate", category: "config" });
		expect(decision?.reason).toContain("neither full `content` nor a str-replace edit");
		expect(decision?.reason).toContain("Write of the full file content");
		expect(mockSpawn).not.toHaveBeenCalled();
	});
});
