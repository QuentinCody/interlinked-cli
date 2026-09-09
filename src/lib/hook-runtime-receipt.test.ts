import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	hashHookDefinition,
	HOOK_RUNTIME_RECEIPT_FILE,
	readHookRuntimeReceipt,
	recordHookRuntime,
} from "./hook-runtime-receipt.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("hook runtime receipt", () => {
	it.each([
		null,
		{ schema_version: "2", providers: {} },
		{ schema_version: "1", providers: [] },
		{ schema_version: "1", providers: { codex: null } },
		{ schema_version: "1", providers: { codex: { observed_at: 1, native_event: "Stop" } } },
		{ schema_version: "1", providers: { codex: { observed_at: "2026-09-08", native_event: 1 } } },
		{ schema_version: "1", providers: { codex: { observed_at: "2026-09-08", native_event: "Stop", definition_sha256: 42 } } },
	])("does not certify malformed provider evidence: %j", value => {
		const root = mkdtempSync(join(tmpdir(), "interlinked-hook-receipt-invalid-"));
		roots.push(root);
		const path = join(root, HOOK_RUNTIME_RECEIPT_FILE);
		writeFileSync(path, JSON.stringify(value));
		expect(readHookRuntimeReceipt(path)).toBeNull();
		recordHookRuntime({ dataDir: root, provider: "codex", nativeEvent: "PreToolUse" });
		expect(readHookRuntimeReceipt(path)?.providers.codex?.native_event).toBe("PreToolUse");
	});

	it("cleans up a staged receipt when publication cannot replace its destination", () => {
		const root = mkdtempSync(join(tmpdir(), "interlinked-hook-receipt-publish-"));
		roots.push(root);
		const path = join(root, HOOK_RUNTIME_RECEIPT_FILE);
		mkdirSync(path);
		recordHookRuntime({ dataDir: root, provider: "codex", nativeEvent: "Stop" });
		expect(readHookRuntimeReceipt(path)).toBeNull();
		expect(() => readFileSync(`${path}.${process.pid}.tmp`)).toThrow();
	});

	it("records provider execution and the installed definition hash without payload data", () => {
		const root = mkdtempSync(join(tmpdir(), "interlinked-hook-receipt-"));
		roots.push(root);
		const dataDir = join(root, ".interlinked");
		const definitionPath = join(root, "hooks.json");
		writeFileSync(definitionPath, '{"hooks":{}}\n');

		recordHookRuntime({
			dataDir,
			provider: "codex",
			nativeEvent: "SessionStart",
			definitionPath,
			now: () => new Date("2026-08-30T12:00:00.000Z"),
		});

		const path = join(dataDir, HOOK_RUNTIME_RECEIPT_FILE);
		const receipt = readHookRuntimeReceipt(path);
		expect(receipt?.providers.codex).toEqual({
			observed_at: "2026-08-30T12:00:00.000Z",
			native_event: "SessionStart",
			definition_sha256: hashHookDefinition(definitionPath),
		});
		expect(readFileSync(path, "utf-8")).not.toContain("session_id");
		expect(readFileSync(path, "utf-8")).not.toContain("tool_input");
	});

	it("preserves observations from other providers", () => {
		const root = mkdtempSync(join(tmpdir(), "interlinked-hook-receipt-"));
		roots.push(root);
		const dataDir = join(root, ".interlinked");
		mkdirSync(dataDir);
		recordHookRuntime({ dataDir, provider: "codex", nativeEvent: "Stop" });
		recordHookRuntime({ dataDir, provider: "claude-code", nativeEvent: "SessionEnd" });
		const receipt = readHookRuntimeReceipt(join(dataDir, HOOK_RUNTIME_RECEIPT_FILE));
		expect(Object.keys(receipt?.providers ?? {}).sort()).toEqual(["claude-code", "codex"]);
	});

	it("ignores unsafe provider keys", () => {
		const root = mkdtempSync(join(tmpdir(), "interlinked-hook-receipt-"));
		roots.push(root);
		const dataDir = join(root, ".interlinked");
		mkdirSync(dataDir);
		recordHookRuntime({ dataDir, provider: "../escape", nativeEvent: "Stop" });
		expect(readHookRuntimeReceipt(join(dataDir, HOOK_RUNTIME_RECEIPT_FILE))).toBeNull();
	});

	it("returns undefined when the definition path cannot be read as a file", () => {
		const root = mkdtempSync(join(tmpdir(), "interlinked-hook-receipt-"));
		roots.push(root);
		// A directory at the definition path makes readFileSync throw (EISDIR)
		// even though existsSync reports it present.
		const definitionPath = join(root, "hooks-as-dir");
		mkdirSync(definitionPath);

		expect(hashHookDefinition(definitionPath)).toBeUndefined();
	});

	it("swallows a write failure without crashing when the temp path is blocked", () => {
		const root = mkdtempSync(join(tmpdir(), "interlinked-hook-receipt-"));
		roots.push(root);
		const dataDir = join(root, ".interlinked");
		mkdirSync(dataDir);
		const path = join(dataDir, HOOK_RUNTIME_RECEIPT_FILE);
		// Occupy the atomic-write temp path with a directory: writeFileSync
		// throws (EISDIR) and the subsequent cleanup unlinkSync also throws
		// (EPERM on a directory), exercising the nested best-effort catch.
		mkdirSync(`${path}.${process.pid}.tmp`);

		expect(() =>
			recordHookRuntime({ dataDir, provider: "codex", nativeEvent: "Stop" }),
		).not.toThrow();
		expect(readHookRuntimeReceipt(path)).toBeNull();
	});
});
