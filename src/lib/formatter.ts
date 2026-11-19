// ===========================================
// Output Formatting — Colors, Tables, Timestamps
// ===========================================
// Inline ANSI with NO_COLOR/CI detection. No external dependencies.

import { nonNull } from "./non-null.js";

const supportsColor = !process.env.NO_COLOR && !process.env.CI && process.stdout.isTTY !== false;

// ===========================================
// ANSI Colors
// ===========================================

function ansi(code: number, text: string): string {
	if (!supportsColor) return text;
	return `\x1b[${code}m${text}\x1b[0m`;
}

export const c = {
	bold: (s: string) => ansi(1, s),
	dim: (s: string) => ansi(2, s),
	italic: (s: string) => ansi(3, s),
	red: (s: string) => ansi(31, s),
	green: (s: string) => ansi(32, s),
	yellow: (s: string) => ansi(33, s),
	blue: (s: string) => ansi(34, s),
	magenta: (s: string) => ansi(35, s),
	cyan: (s: string) => ansi(36, s),
	gray: (s: string) => ansi(90, s),
	white: (s: string) => ansi(37, s),
	bgRed: (s: string) => (supportsColor ? `\x1b[41m\x1b[37m${s}\x1b[0m` : s),
	bgGreen: (s: string) => (supportsColor ? `\x1b[42m\x1b[30m${s}\x1b[0m` : s),
	bgYellow: (s: string) => (supportsColor ? `\x1b[43m\x1b[30m${s}\x1b[0m` : s),
	bgBlue: (s: string) => (supportsColor ? `\x1b[44m\x1b[37m${s}\x1b[0m` : s),
};

// ===========================================
// Table Formatting
// ===========================================

export function table(
	headers: string[],
	rows: string[][],
	options?: { maxWidth?: number; padding?: number },
): string {
	if (rows.length === 0) {
		return c.dim("  (none)");
	}

	const padding = options?.padding ?? 2;
	const allRows = [headers, ...rows];

	// Calculate column widths
	const widths = headers.map((h, i) => {
		const maxCell = Math.max(h.length, ...allRows.map((r) => stripAnsi(r[i] || "").length));
		return Math.min(maxCell, options?.maxWidth || 60);
	});

	const lines: string[] = [];

	// Header
	const headerLine = headers.map((h, i) => h.padEnd(nonNull(widths[i]))).join(" ".repeat(padding));
	lines.push(c.bold(headerLine));
	lines.push(c.dim(widths.map((w) => "─".repeat(w)).join(" ".repeat(padding))));

	// Rows
	for (const row of rows) {
		const line = row
			.map((cell, i) => {
				const stripped = stripAnsi(cell);
				const pad = Math.max(0, (widths[i] ?? 0) - stripped.length);
				return cell + " ".repeat(pad);
			})
			.join(" ".repeat(padding));
		lines.push(line);
	}

	return lines.join("\n");
}

// ===========================================
// Status Badges
// ===========================================

export function badge(status: string): string {
	switch (status.toLowerCase()) {
		case "online":
		case "active":
		case "completed":
		case "done":
			return c.green(`[${status}]`);
		case "offline":
		case "inactive":
		case "deactivated":
			return c.dim(`[${status}]`);
		case "pending":
		case "waiting":
			return c.yellow(`[${status}]`);
		case "in_progress":
		case "working":
			return c.blue(`[${status}]`);
		case "blocked":
		case "error":
		case "failed":
			return c.red(`[${status}]`);
		case "urgent":
			return c.bgRed(` ${status} `);
		default:
			return c.dim(`[${status}]`);
	}
}

// ===========================================
// Timestamps
// ===========================================

export function relativeTime(dateStr: string | null | undefined): string {
	if (!dateStr) return c.dim("never");

	const date = new Date(dateStr);
	const now = new Date();
	const diffMs = now.getTime() - date.getTime();

	if (diffMs < 0) return "just now";

	const seconds = Math.floor(diffMs / 1000);
	if (seconds < 60) return `${seconds}s ago`;

	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;

	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;

	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}d ago`;

	return date.toLocaleDateString();
}

export function shortTimestamp(dateStr: string | null | undefined): string {
	if (!dateStr) return "";
	const date = new Date(dateStr);
	return date.toLocaleTimeString("en-US", {
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});
}

// ===========================================
// Text Helpers
// ===========================================

// ANSI escape sequence regex — built from char code so the source contains
// no literal control characters (satisfies noControlCharactersInRegex).
const ESC = String.fromCharCode(0x1b);
const ANSI_PATTERN = `${ESC}\\[[0-9;]*m`;

export function truncate(text: string, maxLen: number): string {
	if (maxLen <= 0) return "";
	if (stripAnsi(text).length <= maxLen) return text;

	const targetVisibleChars = Math.max(0, maxLen - 1);
	const ansiRegex = new RegExp(ANSI_PATTERN, "g");
	let result = "";
	let visibleChars = 0;
	let index = 0;

	while (index < text.length && visibleChars < targetVisibleChars) {
		ansiRegex.lastIndex = index;
		const match = ansiRegex.exec(text);
		if (match && match.index === index) {
			result += match[0];
			index += match[0].length;
			continue;
		}

		result += text[index];
		index += 1;
		visibleChars += 1;
	}

	// Ensure styling is terminated if we truncated in the middle of colored output.
	const needsReset = new RegExp(ANSI_PATTERN).test(result);
	return `${result}…${needsReset ? "\x1b[0m" : ""}`;
}

export function indent(text: string, spaces = 2): string {
	const prefix = " ".repeat(spaces);
	return text
		.split("\n")
		.map((line) => prefix + line)
		.join("\n");
}

export function stripAnsi(str: string): string {
	return str.replace(new RegExp(ANSI_PATTERN, "g"), "");
}

export function divider(char = "─", width = 50): string {
	return c.dim(char.repeat(width));
}

export function header(title: string): string {
	return `\n${c.bold(title)}\n${c.dim("─".repeat(stripAnsi(title).length))}`;
}

export function formatElapsedSeconds(ms: number): string {
	return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)} s`;
}

/**
 * Print a key-value pair for status display.
 */
export function kvLine(key: string, value: string, keyWidth = 14): string {
	return `  ${c.dim(key.padEnd(keyWidth))} ${value}`;
}

// ===========================================
// Token Formatting
// ===========================================

interface TokenCounts {
	input?: number;
	output?: number;
	cache_read?: number;
	cache_creation?: number;
}

/**
 * Format token usage into a human-readable string.
 */
export function formatTokens(tokens: TokenCounts): string {
	const parts: string[] = [];
	const fmtNum = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

	if (tokens.input) parts.push(`${fmtNum(tokens.input)} in`);
	if (tokens.output) parts.push(`${fmtNum(tokens.output)} out`);
	if (tokens.cache_read) parts.push(`${fmtNum(tokens.cache_read)} cache`);

	return parts.length > 0 ? parts.join(" / ") : "0 tokens";
}

/**
 * Estimate cost based on token usage.
 * Rough estimates based on typical Claude pricing.
 */
export function estimateCost(tokens: TokenCounts, model?: string): string {
	// Default pricing: Sonnet-level ($3/$15 per 1M tokens)
	const inputRate = model?.includes("opus") ? 15 / 1_000_000 : 3 / 1_000_000;
	const outputRate = model?.includes("opus") ? 75 / 1_000_000 : 15 / 1_000_000;
	const cacheRate = inputRate * 0.1; // cache reads are ~10% of input cost

	const cost =
		(tokens.input || 0) * inputRate +
		(tokens.output || 0) * outputRate +
		(tokens.cache_read || 0) * cacheRate;

	if (cost < 0.01) return `~$${cost.toFixed(4)}`;
	if (cost < 1) return `~$${cost.toFixed(2)}`;
	return `~$${cost.toFixed(2)}`;
}
