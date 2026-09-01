// ===========================================
// Dependency Audit Command Resolution
// ===========================================
// Maps manifest/lock-file names to the CLI command that audits their
// ecosystem for known vulnerabilities.
//
// Resolution order:
//   1. osv-scanner (if on PATH and not explicitly disabled) — one tool, OSV DB
//      covers every ecosystem below with one JSON shape.
//   2. ecosystem-specific fallback (npm audit / pip-audit / cargo audit /
//      govulncheck) — preserves zero-install behavior for users without
//      osv-scanner.

import { spawnSync } from "node:child_process";
import { runProcessAsync } from "../check-engine/spawn-async.js";

export type AuditParser = "osv-scanner" | "npm-audit" | "pip-audit" | "cargo-audit" | "govulncheck";

export interface ResolvedAuditCommand {
	cmd: string[];
	parser: AuditParser;
}

export interface ResolveOptions {
	/** Defaults to true. Set false to skip osv-scanner even when installed. */
	useOsvScanner?: boolean | undefined;
	/** When osv-scanner is picked, pass --offline (requires pre-downloaded DB). */
	offline?: boolean | undefined;
}

let osvScannerAvailable: boolean | null = null;
/** Memoized check — spawns `osv-scanner --version` once per process. */
export function hasOsvScanner(): boolean {
	if (osvScannerAvailable !== null) return osvScannerAvailable;
	try {
		const r = spawnSync("osv-scanner", ["--version"], {
			stdio: ["ignore", "ignore", "ignore"],
			timeout: 2000,
		});
		osvScannerAvailable = r.status === 0;
	} catch {
		osvScannerAvailable = false;
	}
	return osvScannerAvailable;
}

/** Event-loop-safe availability probe for daemon/PostToolUse callers. Shares
 * the same memoized answer as the legacy synchronous CLI resolver. */
async function hasOsvScannerAsync(): Promise<boolean> {
	if (osvScannerAvailable !== null) return osvScannerAvailable;
	const result = await runProcessAsync("osv-scanner", ["--version"], { timeout: 2_000 });
	osvScannerAvailable =
		!result.timedOut && !result.killed && result.code !== null && result.code === 0;
	return osvScannerAvailable;
}

/** Test hook — reset the memoized availability flag. */
export function _resetOsvScannerCache(): void {
	osvScannerAvailable = null;
}

const LOCKFILES = new Set([
	"package.json",
	"package-lock.json",
	"yarn.lock",
	"pnpm-lock.yaml",
	"requirements.txt",
	"pyproject.toml",
	"Pipfile.lock",
	"Cargo.toml",
	"Cargo.lock",
	"go.mod",
	"go.sum",
]);

/**
 * Map a package/lock-file name to the CLI command that audits its ecosystem.
 * Returns null for unknown filenames so callers can skip the audit step.
 */
export function resolveDependencyAuditCommand(
	fileName: string,
	opts: ResolveOptions = {},
): ResolvedAuditCommand | null {
	if (!LOCKFILES.has(fileName)) return null;
	return resolveKnownAuditCommand(fileName, opts, opts.useOsvScanner !== false && hasOsvScanner());
}

/** Async resolver for daemon paths. The optional osv-scanner version probe
 * never blocks the socket event loop. Callers must hold heavyweight-process
 * admission while awaiting it. */
export async function resolveDependencyAuditCommandAsync(
	fileName: string,
	opts: ResolveOptions = {},
): Promise<ResolvedAuditCommand | null> {
	if (!LOCKFILES.has(fileName)) return null;
	const useOsv = opts.useOsvScanner !== false && (await hasOsvScannerAsync());
	return resolveKnownAuditCommand(fileName, opts, useOsv);
}

function resolveKnownAuditCommand(
	fileName: string,
	opts: ResolveOptions,
	useOsv: boolean,
): ResolvedAuditCommand | null {
	if (useOsv) {
		const cmd = ["osv-scanner", "scan", "source", "--format=json", `--lockfile=${fileName}`];
		if (opts.offline) cmd.push("--offline");
		return { cmd, parser: "osv-scanner" };
	}

	if (
		fileName === "package.json" ||
		fileName === "package-lock.json" ||
		fileName === "yarn.lock" ||
		fileName === "pnpm-lock.yaml"
	) {
		return { cmd: ["npm", "audit", "--json", "--audit-level=moderate"], parser: "npm-audit" };
	}
	if (
		fileName === "requirements.txt" ||
		fileName === "pyproject.toml" ||
		fileName === "Pipfile.lock"
	) {
		return { cmd: ["pip-audit", "--format", "json", "--desc"], parser: "pip-audit" };
	}
	if (fileName === "Cargo.toml" || fileName === "Cargo.lock") {
		return { cmd: ["cargo", "audit", "--json"], parser: "cargo-audit" };
	}
	if (fileName === "go.sum" || fileName === "go.mod") {
		return { cmd: ["govulncheck", "-json", "./..."], parser: "govulncheck" };
	}
	return null;
}
