// ===========================================
// Check Engine — Tool Discovery
// ===========================================
// Detects which external tools are available and reports coverage.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { nonNull } from "../../lib/non-null.js";
import { errorMessage } from "../../lib/error-message.js";
import { buildToolSpecs } from "./tool-catalog.js";
import { hasErrorCode } from "./tool-errors.js";
import type { CheckOptions, ToolAvailability, ToolId } from "./types.js";

export interface ToolBinarySpec {
	versionCmd: string[];
	versionRegex: RegExp;
}

interface ToolSpec extends ToolBinarySpec {
	id: ToolId;
	/** Config files that indicate the tool is relevant for this project. */
	configFiles?: string[];
	/** If true, tool requires a config file to be useful. */
	requiresConfig?: boolean;
	/** Fallback binary to try if the primary is unavailable (e.g. tsc when tsgo is missing). */
	fallback?: ToolBinarySpec;
}

// Discovery specs are derived from the single tool catalog (tool-catalog.ts).
const TOOL_SPECS: ToolSpec[] = buildToolSpecs();

/** Walk up to 5 levels to find any of the given config files. */
function findConfig(startDir: string, configFiles: string[]): boolean {
	let dir = startDir;
	for (let i = 0; i < 5; i++) {
		for (const name of configFiles) {
			if (existsSync(resolve(dir, name))) return true;
		}
		const parent = dirname(dir);
		if (parent === dir) return false;
		dir = parent;
	}
	return false;
}

/** Try running a version command and extract the version string. */
type BinaryProbe = Pick<ToolAvailability, "available" | "version" | "probeError">;

function failedProbe(error: unknown): BinaryProbe {
	return hasErrorCode(error, "ENOENT") ? { available: false } : { available: false, probeError: errorMessage(error) };
}

export function tryBinary(bin: ToolBinarySpec, timeoutMs = 5_000): BinaryProbe {
	try {
		const result = spawnSync(nonNull(bin.versionCmd[0]), bin.versionCmd.slice(1), {
			timeout: timeoutMs,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});

		if (result.error) return failedProbe(result.error);
		if (result.signal || result.status !== 0) return { available: false, probeError: `Version command ${bin.versionCmd[0]} ${result.signal ? `was killed by ${result.signal}` : `exited ${result.status ?? "without status"}`}` };
		// Both streams are piped and decoded as UTF-8; spawn errors returned above.
		const output = result.stdout + result.stderr;
		const match = output.match(bin.versionRegex);
		return { available: true, version: match?.[1] };
	} catch (error) {
		return failedProbe(error);
	}
}

/** Check if a tool binary is available, trying fallback if primary fails. */
function checkBinary(spec: ToolSpec, timeoutMs: number): BinaryProbe {
	const primary = tryBinary(spec, timeoutMs);
	if (primary.available) return primary;
	if (!spec.fallback) return primary;
	const fallback = tryBinary(spec.fallback, timeoutMs);
	return fallback.available || fallback.probeError ? fallback : primary;
}

/** Check a single tool spec against the project root. */
function checkTool(spec: ToolSpec, projectRoot: string, timeoutMs: number): ToolAvailability {
	// Check config files first (fast, no subprocess)
	if (spec.requiresConfig && spec.configFiles && !findConfig(projectRoot, spec.configFiles)) {
		return {
			id: spec.id,
			available: false,
			reason: `no config file found (${spec.configFiles.join(", ")})`,
		};
	}

	const binary = checkBinary(spec, timeoutMs);
	if (!binary.available) {
		if (binary.probeError) return { id: spec.id, ...binary, reason: `availability probe failed: ${binary.probeError}` };
		return { id: spec.id, available: false, reason: "not installed" };
	}

	return { id: spec.id, available: true, version: binary.version };
}

/**
 * Discover which tools are available for the given project root.
 * Checks binary availability and config file presence.
 */
export function discoverTools(projectRoot: string, timeoutMs = 5_000, selection?: Pick<CheckOptions, "tools" | "skipTools">): ToolAvailability[] {
	return TOOL_SPECS.map(spec => selection?.skipTools?.includes(spec.id) || (selection?.tools && !selection.tools.includes(spec.id))
		? { id: spec.id, available: false, reason: "not selected; availability not probed" }
		: checkTool(spec, projectRoot, timeoutMs));
}

/**
 * Discover a single registered tool by ID. Unknown names return undefined.
 * Use this instead of discoverTools() when you only need to check a few tools
 * (e.g., getDiagnostics for a single file) to avoid spawning subprocesses for all 20+ tools.
 */
export function discoverSingleTool(id: string, projectRoot: string, timeoutMs = 5_000): ToolAvailability | undefined {
	const spec = TOOL_SPECS.find((s) => s.id === id);
	if (!spec) return undefined;
	return checkTool(spec, projectRoot, timeoutMs);
}

/** Format tool availability as a human-readable report. */
export function formatToolReport(tools: ToolAvailability[]): string {
	const lines = ["tool coverage:"];
	for (const t of tools) {
		const version = t.version ? `v${t.version}` : "--";
		const status = t.available ? "\u2713" : "\u2717";
		const reason = t.available ? "" : ` (${t.reason})`;
		lines.push(`  ${t.id.padEnd(14)} ${version.padEnd(10)} ${status}${reason}`);
	}
	return lines.join("\n");
}
