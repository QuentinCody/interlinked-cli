// Grok 2026-08-28 issue 8: doctor must not print a green feature-flag row for
// a config.toml that Codex rejects wholesale. Real filesystem, no mocks.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordHookRuntime } from "../lib/hook-runtime-receipt.js";
import {
	codexFeatureFlagResult,
	codexRuntimeReceiptResult,
} from "./doctor-checks-codex.js";

let dir = "";
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "doctor-codex-"));
	mkdirSync(join(dir, ".codex"), { recursive: true });
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function writeToml(text: string): void {
	writeFileSync(join(dir, ".codex", "config.toml"), text);
}

const configDir = (): string => join(dir, ".codex");

describe("codexFeatureFlagResult — positive (must flag)", () => {
	it("P1: DUPLICATE [features] tables ⇒ fail naming invalid TOML, never a pass", () => {
		// Last-wins assignment scanning would read this as enabled; Codex
		// rejects the whole file, so hooks never fire.
		writeToml("[features]\nhooks = true\n\n[features]\nother = 1\n");
		const r = codexFeatureFlagResult(configDir());
		expect(r?.status).toBe("fail");
		expect(r?.message).toContain("DUPLICATE [features]");
	});

	it("P1b: DUPLICATE hooks keys inside ONE [features] table ⇒ fail, never last-wins enabled", () => {
		writeToml("[features]\nhooks = true\nhooks = true\n");
		const r = codexFeatureFlagResult(configDir());
		expect(r?.status).toBe("fail");
		expect(r?.message).toContain("more than once");
	});

	it("P2: hooks = false ⇒ warn (installed but never fires)", () => {
		writeToml("[features]\nhooks = false\n");
		expect(codexFeatureFlagResult(configDir())?.status).toBe("warn");
	});

	it("P3: missing config.toml ⇒ warn steering to enable", () => {
		rmSync(join(dir, ".codex", "config.toml"), { force: true });
		const r = codexFeatureFlagResult(configDir());
		expect(r?.status).toBe("warn");
		expect(r?.message).toContain("config.toml not found");
	});

	it("P4: config.toml unreadable (e.g. a directory) ⇒ warn without crashing", () => {
		// existsSync passes (the path is present) but readFileSync throws
		// EISDIR — the catch branch must still report a usable row instead
		// of letting the exception escape doctor's check loop.
		rmSync(join(dir, ".codex", "config.toml"), { force: true });
		mkdirSync(join(dir, ".codex", "config.toml"));
		const r = codexFeatureFlagResult(configDir());
		expect(r?.status).toBe("warn");
		expect(r?.message).toBe("Could not read config.toml");
	});
});

describe("codexFeatureFlagResult — negative (must pass)", () => {
	it("N1: a single [features] table with hooks = true passes", () => {
		writeToml("[features]\nhooks = true\n");
		const r = codexFeatureFlagResult(configDir());
		expect(r?.status).toBe("pass");
	});

	it("N2: other tables alongside ONE [features] table do not read as duplicates", () => {
		writeToml("[other]\nx = 1\n\n[features]\nhooks = true\n");
		expect(codexFeatureFlagResult(configDir())?.status).toBe("pass");
	});
});

describe("codexRuntimeReceiptResult", () => {
	it("warns until the current definition has executed", () => {
		writeFileSync(join(dir, ".codex", "hooks.json"), '{"hooks":{}}\n');
		expect(codexRuntimeReceiptResult(dir)).toMatchObject({
			status: "warn",
			message: expect.stringContaining("/hooks"),
		});
	});

	it("passes after the current hooks.json hash executes", () => {
		const hooksPath = join(dir, ".codex", "hooks.json");
		const dataDir = join(dir, ".interlinked");
		mkdirSync(dataDir);
		writeFileSync(hooksPath, '{"hooks":{"SessionStart":[]}}\n');
		recordHookRuntime({
			dataDir,
			provider: "codex",
			nativeEvent: "SessionStart",
			definitionPath: hooksPath,
			now: () => new Date("2026-08-30T12:00:00.000Z"),
		});
		expect(codexRuntimeReceiptResult(dir)).toEqual({
			name: "OpenAI Codex CLI hook execution",
			status: "pass",
			message: "Current definition executed (SessionStart, 2026-08-30T12:00:00.000Z)",
		});
	});

	it("warns again when hooks.json changes after execution", () => {
		const hooksPath = join(dir, ".codex", "hooks.json");
		const dataDir = join(dir, ".interlinked");
		mkdirSync(dataDir);
		writeFileSync(hooksPath, '{"hooks":{}}\n');
		recordHookRuntime({
			dataDir,
			provider: "codex",
			nativeEvent: "Stop",
			definitionPath: hooksPath,
		});
		writeFileSync(hooksPath, '{"hooks":{"Stop":[]}}\n');
		expect(codexRuntimeReceiptResult(dir).status).toBe("warn");
	});
});
