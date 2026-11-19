import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runQualityChecks } from "../quality-checks.js";
import { getCommanderOptionEvidence } from "../checks/commander-option-evidence.js";
import type { HarnessEvent } from "../types.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("uses scoped importer queries for actual handler-only PostToolUse warnings", async () => {
	const root = mkdtempSync(join(resolve("scratch"), "commander-hook-")); roots.push(root);
	const handler = join(root, "handler.ts"), registrar = join(root, "registrar.ts");
	writeFileSync(handler, 'export function run(opts) { return opts["dry-run"]; }');
	writeFileSync(registrar, 'import { Command } from "commander"; import {run} from "./handler.js"; new Command().option("--dry-run").action(run);');
	const event: HarnessEvent = { hook_event: "PostToolUse", tool_name: "Edit", tool_input: { file_path: handler }, session_id: "commander-evidence-control", cwd: root, agent_source: "claude", timestamp: "2026-11-12T00:00:00Z" };
	const results = await runQualityChecks(event, {}, root, { commanderEvidence: { root, importers: () => ({ files: [registrar], complete: false, reason: "hook candidate graph" }) } });
	expect(results).toContainEqual(expect.objectContaining({ name: "commander_option_attribute", detail: expect.stringContaining("dryRun") }));
	expect(results).toContainEqual(expect.objectContaining({ name: "commander_option_attribute", measurementState: "unavailable", message: expect.stringContaining("NOT MEASURED"), detail: expect.stringContaining("partial") }));
	expect(getCommanderOptionEvidence()).toBeUndefined();
});

it("retains JSDoc receiver notices as nonblocking advisory missingness", async () => {
	const root = mkdtempSync(join(resolve("scratch"), "commander-hook-model-")); roots.push(root);
	const file = join(root, "registrar.js");
	writeFileSync(file, '/** @param {import("commander").Command} program */ export function register(program) { program.option("--dry-run").action(opts => opts["dry-run"]); }');
	const event: HarnessEvent = { hook_event: "PostToolUse", tool_name: "Edit", tool_input: { file_path: file }, session_id: "commander-model-control", agent_source: "claude", timestamp: "2026-11-12T00:00:00Z" };
	const results = await runQualityChecks(event, {}, root, { commanderEvidence: { root, importers: () => ({ files: [], complete: false }) } });
	expect(results).toContainEqual(expect.objectContaining({ name: "commander_option_attribute", severity: "warning", measurementState: "unavailable", findingCount: 0, detail: expect.stringContaining("receiver") }));
	expect(results.filter(row => row.measurementState === "unavailable").every(row => row.name === "commander_option_attribute")).toBe(true);
});
