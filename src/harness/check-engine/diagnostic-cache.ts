import { statSync } from "node:fs";
import type { CheckResult } from "./types.js";

interface DiagnosticCacheEntry {
	mtimeMs: number;
	results: CheckResult[];
}

type DiagnosticCacheLookup =
	| { status: "hit"; results: CheckResult[] }
	| { status: "miss" }
	| { status: "unavailable" };

const diagnosticCache = new Map<string, DiagnosticCacheEntry>();

export function readDiagnosticCache(filePath: string): DiagnosticCacheLookup {
	try {
		const mtimeMs = statSync(filePath).mtimeMs;
		const cached = diagnosticCache.get(filePath);
		return cached?.mtimeMs === mtimeMs
			? { status: "hit", results: cached.results }
			: { status: "miss" };
	} catch {
		return { status: "unavailable" };
	}
}

export function writeDiagnosticCache(filePath: string, results: CheckResult[]): void {
	try {
		diagnosticCache.set(filePath, { mtimeMs: statSync(filePath).mtimeMs, results });
	} catch {
		/* intentional: a missing or unreadable file is not cached */
	}
}

/** Drop file diagnostics retained across PostToolUse requests. */
export function clearCheckEngineDiagnosticCache(): void {
	diagnosticCache.clear();
}
