// ===========================================
// Tool Runner — Biome
// ===========================================

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { parseBiomeOutput } from "../output-parsers.js";
import { runProcessAsync } from "../spawn-async.js";
import type { CheckResult, ToolRunnerInput } from "../types.js";
import { inspectBiomeOverlayConfig } from "./biome-overlay-config.js";

/** Walk up to 5 levels to find biome.json or biome.jsonc. */
function findBiomeConfig(startDir: string): boolean {
	let dir = startDir;
	for (let i = 0; i < 5; i++) {
		if (existsSync(resolve(dir, "biome.json")) || existsSync(resolve(dir, "biome.jsonc")))
			return true;
		const parent = dirname(dir);
		if (parent === dir) return false;
		dir = parent;
	}
	return false;
}

/** A non-zero biome exit whose output yielded NO parsed diagnostics is a tool
 *  failure (or a diagnostic-format drift), not a clean pass — silence here
 *  read as green (finding 2026-06, round 6; same class as the rustfmt
 *  parse-error suppression). */
function biomeFailureResult(status: number | null): CheckResult {
	return {
		tool: "biome",
		severity: "warning",
		file: ".",
		line: 1,
		message: `biome exited ${status ?? "without status"} but no diagnostics were parsed — lint/format NOT validated for this change`,
	};
}

/** `.claude/` tooling files (workflow scripts with top-level await/return that
 *  biome's parser rejects — "file does not parse") are never shipped source, so
 *  file-mode biome skips them, mirroring tsc's isFileInTscScope exclusion. */
function isClaudeToolingFile(scope: ToolRunnerInput["scope"]): boolean {
	return (
		scope.mode === "file" &&
		!!scope.targetFile &&
		/(^|\/)\.claude\//.test(scope.targetFile.replace(/\\/g, "/"))
	);
}

export function runBiome(input: ToolRunnerInput): CheckResult[] {
	const { scope, timeoutMs } = input;
	if (!findBiomeConfig(scope.projectRoot)) return [];
	if (isClaudeToolingFile(scope)) return [];

	try {
		// In file mode, check the single file; in project mode, check everything.
		const target = scope.mode === "file" && scope.targetFile ? scope.targetFile : ".";
		const result = spawnSync("npx", ["biome", "check", "--no-errors-on-unmatched", target], {
			cwd: scope.projectRoot,
			timeout: timeoutMs,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});

		if (result.status === 0) return [];
		const output = (result.stdout || "") + (result.stderr || "");
		const findings = parseBiomeOutput(output);
		return findings.length > 0 ? findings : [biomeFailureResult(result.status)];
	} catch {
		return [];
	}
}

/**
 * Async variant of `runBiome`. Phase A.1 — non-blocking subprocess spawn so
 * `runChecksAsync` can run biome concurrently with tsc/eslint/etc. without
 * any of them blocking the event loop. Behaviorally identical to `runBiome`
 * (same output parser, same exit-code handling).
 */
export async function runBiomeAsync(input: ToolRunnerInput): Promise<CheckResult[]> {
	const { scope, timeoutMs } = input;
	if (!findBiomeConfig(scope.projectRoot)) return [];
	const target = scope.mode === "file" && scope.targetFile ? scope.targetFile : ".";
	const result = await runProcessAsync(
		"npx",
		["biome", "check", "--no-errors-on-unmatched", target],
		{ cwd: scope.projectRoot, timeout: timeoutMs },
	);
	if (result.code === 0) return [];
	const findings = parseBiomeOutput(`${result.stdout}${result.stderr}`);
	return findings.length > 0 ? findings : [biomeFailureResult(result.code)];
}

/**
 * Run biome against in-memory content, as if the content were the file at
 * `filePath`. Used by the PreToolUse diff-overlay pre-block to detect
 * whether a proposed edit introduces new biome findings before it lands.
 *
 * Implementation note: biome's `--stdin-file-path` mode is format-oriented
 * and suppresses diagnostic output (only prints "contents aren't fixed").
 * To get full diagnostics, we write the overlay content to a sibling
 * temp file in the same directory, run `biome check` on it, then delete.
 * Same-directory placement preserves directory-scoped configuration. Configurations
 * whose filename semantics cannot be preserved yield an unavailable measurement.
 *
 * Temp file naming: `<base>.overlay-<pid>-<uuid>.<ext>`. No dotfile prefix,
 * so biome/gitignore default rules don't skip it.
 *
 * Cleanup is best-effort and only removes a temporary file this run created.
 */
export interface BiomeOverlayInput {
	projectRoot: string;
	timeoutMs: number;
	filePath: string;
	content: string;
}

export type BiomeOverlayOutcome =
	| { status: "ok"; findings: CheckResult[] }
	| { status: "skipped"; reason: string }
	| { status: "unavailable"; reason: string };

function canonicalDiagnosticPath(path: string): string {
	try { return realpathSync(path); } catch { return resolve(path); }
}

function remapOverlayFindings(findings: CheckResult[], input: { projectRoot: string; tmpPath: string; filePath: string }): CheckResult[] {
	const temporary = canonicalDiagnosticPath(input.tmpPath);
	const target = relative(input.projectRoot, input.filePath);
	return findings.map((finding) =>
		canonicalDiagnosticPath(resolve(input.projectRoot, finding.file)) === temporary
			? { ...finding, file: target }
			: finding,
	);
}

/** Diagnostic-only compatibility API. Gate callers must use the typed outcome. */
export function runBiomeOverlay(input: BiomeOverlayInput): CheckResult[] {
	const outcome = runBiomeOverlayTyped(input);
	return outcome.status === "ok" ? outcome.findings : [];
}

/** A failed or incomplete analyzer invocation never supplies a clean verdict. */
export function runBiomeOverlayTyped(input: BiomeOverlayInput): BiomeOverlayOutcome {
	const { projectRoot, timeoutMs, filePath, content } = input;
	const configuration = inspectBiomeOverlayConfig(filePath);
	if (configuration.status !== "ok") return configuration;

	const dir = dirname(filePath);
	// Declaration syntax is selected by the complete .d.ts/.d.mts/.d.cts suffix.
	const ext = /\.d\.[cm]?ts$/.test(filePath) ? filePath.slice(filePath.lastIndexOf(".d.")) : extname(filePath);
	const base = basename(filePath, ext);
	const tmpPath = join(dir, `${base}.overlay-${process.pid}-${randomUUID()}${ext}`);
	let created = false;

	try {
		const fd = openSync(tmpPath, "wx");
		created = true;
		try {
			writeFileSync(fd, content);
		} finally {
			closeSync(fd);
		}
		const result = spawnSync("npx", ["--no-install", "biome", "check", "--max-diagnostics=none", tmpPath], {
			cwd: projectRoot,
			timeout: timeoutMs,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
		if (result.error || result.signal || result.status === null) {
			return {
				status: "unavailable",
				reason: result.error?.message ?? `Biome terminated ${result.signal ?? "without an exit status"}`,
			};
		}
		const output = (result.stdout || "") + (result.stderr || "");
		const findings = parseBiomeOutput(output);
		if (result.status !== 0 && findings.length === 0) {
			return { status: "unavailable", reason: `Biome exited ${result.status} without readable diagnostics` };
		}
		// Rewrite tmp-file paths back to the target file path so downstream
		// diffing (by file + ruleId) sees the same path on both sides.
		return {
			status: "ok",
			findings: remapOverlayFindings(findings, { projectRoot, tmpPath, filePath }),
		};
	} catch (error) {
		// SAFETY: this block invokes native file/process APIs and our string parser;
		// no supplied callback runs, and their failures are Error instances.
		return { status: "unavailable", reason: (error as Error).message };
	} finally {
		try {
			if (created) unlinkSync(tmpPath);
		} catch {
			/* intentional: best-effort cleanup of overlay temp file */
		}
	}
}
