// interlinked-tdd: exempt
// Supply-chain / runtime safety detectors.
// Extracted from supply-chain.ts (sibling) to keep that file under the line cap.
// These are pure, self-contained detectors depending only on shared helpers.

import { basename } from "node:path";
import { getExtension, type InlineMatch, isCliFile, isTestFile, JS_TS_EXTS } from "./shared.js";

/**
 * Detect infinite retry loops without backoff or exit condition.
 * Agents frequently write: while(true) { try { await fetch() } catch { continue } }
 */
export function checkInfiniteRetryLoop(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	if (isTestFile(filePath)) return [];

	const matches: InlineMatch[] = [];
	const lines = content.split("\n");

	for (const [i, line] of lines.entries()) {
		if (matches.length >= 5) break;
		const trimmed = line.trim();

		// Pattern: while(true) { try { ...fetch/request... } catch { continue } }
		if (/while\s*\(\s*(true|1)\s*\)/.test(trimmed)) {
			// Look ahead for catch+continue without delay/backoff/break/return
			const block = lines.slice(i, Math.min(i + 20, lines.length)).join("\n");
			if (
				/catch\s*\([^)]*\)\s*\{/.test(block) &&
				/\bcontinue\b/.test(block) &&
				!/\b(setTimeout|delay|sleep|backoff|break|return|throw)\b/.test(block) &&
				!/\bretries?\b/i.test(block)
			) {
				matches.push({
					line: i + 1,
					text: line.trim().slice(0, 150),
				});
			}
		}
	}
	return matches;
}

/**
 * Check a single line for a hardcoded localhost URL, skipping comments and
 * lines that look like a guarded fallback (env-driven default, dev-only).
 * Returns the InlineMatch for this line, or null if the line doesn't qualify.
 */
function matchLocalhostInLine(line: string, lineIndex: number): InlineMatch | null {
	// Skip comments
	if (/^\s*(\/\/|\/?\*|\*)/.test(line)) return null;
	// Match hardcoded localhost URLs with ports (not just localhost in a comment)
	if (!/https?:\/\/(localhost|127\.0\.0\.1):\d+/.test(line)) return null;
	// Don't flag if it's inside a condition or default/fallback pattern
	if (/\?\?|process\.env|fallback|default|development|DEV/i.test(line)) return null;
	return {
		line: lineIndex + 1,
		text: line.trim().slice(0, 150),
	};
}

/**
 * Detect hardcoded localhost URLs in production source (not test/config files).
 * Agents leave debug URLs like http://localhost:8787 in production code.
 */
export function checkHardcodedLocalhost(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	if (isTestFile(filePath)) return [];
	if (/\.(config|fixture|mock|stub)\.\w+$/.test(filePath)) return [];
	if (filePath.includes("__tests__") || filePath.includes("__mocks__")) return [];
	// Allow CLI and config entry points that legitimately reference localhost
	if (isCliFile(filePath)) return [];

	const matches: InlineMatch[] = [];
	const lines = content.split("\n");

	for (const [i, line] of lines.entries()) {
		if (matches.length >= 5) break;
		const match = matchLocalhostInLine(line, i);
		if (match) matches.push(match);
	}
	return matches;
}

/**
 * Detect process.exit() in library/module code (not CLI entry points).
 * process.exit() in a library kills the entire process, preventing callers
 * from handling errors. Only appropriate in CLI entry points.
 */
export function checkProcessExitInLibrary(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	if (isTestFile(filePath)) return [];
	if (isCliFile(filePath)) return [];

	const matches: InlineMatch[] = [];
	const lines = content.split("\n");

	for (const [i, line] of lines.entries()) {
		if (matches.length >= 3) break;
		if (/^\s*(\/\/|\/?\*|\*)/.test(line)) continue;
		if (/\bprocess\.exit\s*\(/.test(line)) {
			matches.push({
				line: i + 1,
				text: line.trim().slice(0, 150),
			});
		}
	}
	return matches;
}

/**
 * Detect imports from dist/ or build/ directories — fragile, breaks on rebuild.
 */
export function checkImportFromDist(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	if (isTestFile(filePath)) return [];

	const matches: InlineMatch[] = [];
	const lines = content.split("\n");

	for (const [i, line] of lines.entries()) {
		if (matches.length >= 5) break;
		const trimmed = line.trim();
		// Match: import/require from paths containing dist/ or build/ in relative path
		if (/(?:from\s+|require\s*\(\s*)['"]\.\.?\/[^'"]*?(dist|build)\//.test(trimmed)) {
			matches.push({
				line: i + 1,
				text: line.trim().slice(0, 150),
			});
		}
	}
	return matches;
}

/**
 * Detect placeholder/dummy values left in config or env files.
 * e.g., YOUR_API_KEY_HERE, TODO_REPLACE, changeme, xxx
 */
export function checkPlaceholderValues(content: string, filePath: string): InlineMatch[] {
	// Only check config-like files
	const name = basename(filePath);
	const isEnvFile =
		name === ".env" ||
		(name.startsWith(".env") &&
			!name.includes("example") &&
			!name.includes("sample") &&
			!name.includes("template"));
	if (!isEnvFile && !/\.(ya?ml|json|toml|ini|cfg|conf)$/.test(name) && !name.includes("config")) {
		return [];
	}
	// Skip example/sample/template files
	if (/\.(example|sample|template)\b/.test(name)) return [];

	const matches: InlineMatch[] = [];
	const lines = content.split("\n");

	for (const [i, line] of lines.entries()) {
		if (matches.length >= 5) break;
		if (
			/\b(YOUR_\w*_HERE|REPLACE_?ME|TODO_?REPLACE|CHANGEME|INSERT_?\w*_?HERE|XXX_|PLACEHOLDER|PUT_?YOUR)\b/i.test(
				line,
			)
		) {
			matches.push({
				line: i + 1,
				text: line.trim().slice(0, 150),
			});
		}
	}
	return matches;
}

/**
 * Detect error messages that leak implementation details to clients.
 * e.g., catch(e) { res.json({ error: e.message }) } — exposes stack traces
 */
export function checkErrorMessageLeakage(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	if (isTestFile(filePath)) return [];

	const matches: InlineMatch[] = [];
	const lines = content.split("\n");

	for (const [i, line] of lines.entries()) {
		if (matches.length >= 5) break;
		if (/^\s*(\/\/|\/?\*|\*)/.test(line)) continue;
		// Pattern: res.json/res.send/Response with raw error
		if (
			/\bres\.(json|send|status)\b.*\b(err?|error|exception|e)\.(message|stack|toString)\b/.test(
				line,
			) ||
			/\bnew\s+Response\b.*\b(err?|error|exception|e)\.(message|stack|toString)\b/.test(line)
		) {
			matches.push({
				line: i + 1,
				text: line.trim().slice(0, 150),
			});
		}
	}
	return matches;
}
