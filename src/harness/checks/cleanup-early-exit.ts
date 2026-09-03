// Cleanup-skipped-on-early-exit check.
//
// Detects: a resource (timer / event listener / subscription) is acquired,
// a `throw` or `return` happens before the matching release on at least one
// path, and there's no `try/finally` between the acquisition and the
// release.
//
// JS analog of Firefox 2024653 / 2027298 (UAF via re-entry / early exit
// during teardown). The bug shape is "the cleanup line exists, but a path
// reaches `throw`/`return` before it can run." Distinct from
// `lifecycle_cleanup` (which fires when cleanup is missing entirely).

import { nonNull } from "../../lib/non-null.js";
import {
	getExtension,
	type InlineMatch,
	JS_TS_ALL_EXTS,
	stripCommentsAndStrings,
} from "./shared.js";

/** Lookahead window from acquisition to cleanup. Larger than typical
 * function bodies, smaller than file size. */
const LOOKAHEAD_CHARS = 5000;
const REPORT_LINE_TRUNC = 150;
const MAX_MATCHES_PER_FILE = 10;

interface NamedAcquisition {
	/** Regex that captures the bound name in group 1. */
	acqRe: RegExp;
	/** Build a regex that matches the cleanup call for the given name. */
	cleanupReFor: (name: string) => RegExp;
}

const NAMED_ACQUISITIONS: NamedAcquisition[] = [
	{
		acqRe: /\b(?:const|let|var)\s+(\w+)\s*(?::\s*\w+)?\s*=\s*setInterval\s*\(/g,
		cleanupReFor: (n) => new RegExp(`\\bclearInterval\\s*\\(\\s*${n}\\s*\\)`),
	},
	{
		acqRe: /\b(?:const|let|var)\s+(\w+)\s*(?::\s*\w+)?\s*=\s*setTimeout\s*\(/g,
		cleanupReFor: (n) => new RegExp(`\\bclearTimeout\\s*\\(\\s*${n}\\s*\\)`),
	},
	{
		acqRe: /\b(?:const|let|var)\s+(\w+)\s*(?::\s*\w+)?\s*=\s*[\w.]+\.subscribe\s*\(/g,
		cleanupReFor: (n) => new RegExp(`\\b${n}\\.unsubscribe\\s*\\(`),
	},
	// Effect-TS lessons port (docs/design/effect-ts-harness-additions.md §2.5):
	// file/socket/process handles. Same semantic as the original three — cleanup
	// call exists somewhere in the function, but an early throw/return bypasses
	// it. Bare-name variants cover destructured imports (`import { spawn } from
	// 'node:child_process'`); the `fs.openSync` form ALSO matches `openSync` via
	// the optional `(?:\w+\.)?` qualifier.
	{
		// fs.openSync (closed by separate fs.closeSync(fd) call, NOT a method on fd)
		acqRe: /\b(?:const|let|var)\s+(\w+)\s*(?::\s*\w+)?\s*=\s*(?:\w+\.)?openSync\s*\(/g,
		cleanupReFor: (n) => new RegExp(`\\b(?:\\w+\\.)?closeSync\\s*\\(\\s*${n}\\s*\\)`),
	},
	{
		// fs.createReadStream — close/destroy method on the stream
		acqRe: /\b(?:const|let|var)\s+(\w+)\s*(?::\s*\w+)?\s*=\s*(?:\w+\.)?createReadStream\s*\(/g,
		cleanupReFor: (n) => new RegExp(`\\b${n}\\.(?:close|destroy)\\s*\\(`),
	},
	{
		// fs.createWriteStream — close/destroy/end method on the stream
		acqRe: /\b(?:const|let|var)\s+(\w+)\s*(?::\s*\w+)?\s*=\s*(?:\w+\.)?createWriteStream\s*\(/g,
		cleanupReFor: (n) => new RegExp(`\\b${n}\\.(?:close|destroy|end)\\s*\\(`),
	},
	{
		// net.connect / net.createConnection — destroy/end method on the socket
		acqRe:
			/\b(?:const|let|var)\s+(\w+)\s*(?::\s*\w+)?\s*=\s*(?:\w+\.)?(?:connect|createConnection)\s*\(/g,
		cleanupReFor: (n) => new RegExp(`\\b${n}\\.(?:destroy|end)\\s*\\(`),
	},
	{
		// dgram.createSocket — close method on the socket
		acqRe: /\b(?:const|let|var)\s+(\w+)\s*(?::\s*\w+)?\s*=\s*(?:\w+\.)?createSocket\s*\(/g,
		cleanupReFor: (n) => new RegExp(`\\b${n}\\.close\\s*\\(`),
	},
	{
		// child_process.spawn / fork — kill method on the child
		acqRe: /\b(?:const|let|var)\s+(\w+)\s*(?::\s*\w+)?\s*=\s*(?:\w+\.)?(?:spawn|fork)\s*\(/g,
		cleanupReFor: (n) => new RegExp(`\\b${n}\\.kill\\s*\\(`),
	},
];

/**
 * Within the lookahead window after an acquisition, find the char offset
 * (relative to `window`) of an early `throw`/`return` that precedes the
 * cleanup call matched by `cleanupRe` — but only when no `try {` sits
 * between them (conservative: assume that guards a `finally`-based
 * cleanup). Returns null when there's no cleanup match in the window, no
 * early exit before it, or the try guard applies.
 */
function findEarlyExitOffset(window: string, cleanupRe: RegExp): number | null {
	const cleanupMatch = window.match(cleanupRe);
	if (!cleanupMatch || cleanupMatch.index === undefined) return null;

	const between = window.slice(0, cleanupMatch.index);
	if (/\btry\s*\{/.test(between)) return null;

	const exitMatch = between.match(/\b(?:throw|return)\b/);
	if (!exitMatch || exitMatch.index === undefined) return null;

	return exitMatch.index;
}

/**
 * Yield the offset (in `stripped`) of every early throw/return that bypasses
 * the cleanup of a name-bound acquisition (`const t = setInterval(...)` and
 * friends). Lazy: the caller stops pulling once it has enough matches.
 */
function* namedAcquisitionExits(stripped: string): Generator<number> {
	for (const { acqRe, cleanupReFor } of NAMED_ACQUISITIONS) {
		const re = new RegExp(acqRe.source, "g");
		let acqHit: RegExpExecArray | null;
		while ((acqHit = re.exec(stripped))) {
			const name = nonNull(acqHit[1]);
			const acqEnd = acqHit.index + acqHit[0].length;
			const windowEnd = Math.min(stripped.length, acqHit.index + LOOKAHEAD_CHARS);
			const window = stripped.slice(acqEnd, windowEnd);

			const exitIndex = findEarlyExitOffset(window, cleanupReFor(name));
			if (exitIndex === null) continue;
			yield acqEnd + exitIndex;
		}
	}
}

/**
 * Yield the offset (in `stripped`) of every early throw/return that bypasses
 * a matching `removeEventListener`. There is no const-binding here, so the
 * pairing is by receiver: strings have been stripped, so we can't match the
 * event name, and receiver-equality is a sufficient heuristic.
 */
function* eventListenerExits(stripped: string): Generator<number> {
	const addRe = /\b([\w$.]+)\.addEventListener\s*\(/g;
	let addHit: RegExpExecArray | null;
	while ((addHit = addRe.exec(stripped))) {
		const receiver = nonNull(addHit[1]).replace(/[.]/g, "\\.");
		const acqEnd = addHit.index + addHit[0].length;
		const windowEnd = Math.min(stripped.length, addHit.index + LOOKAHEAD_CHARS);
		const window = stripped.slice(acqEnd, windowEnd);

		const removeRe = new RegExp(`\\b${receiver}\\.removeEventListener\\s*\\(`);
		const exitIndex = findEarlyExitOffset(window, removeRe);
		if (exitIndex === null) continue;
		yield acqEnd + exitIndex;
	}
}

/**
 * Detect resource acquisitions whose paired cleanup is bypassed on a
 * throw/return path with no try/finally wrap.
 *
 * Up to 10 matches per file. Conservative: if we see a `try` keyword
 * between the acquisition and the cleanup, we assume the cleanup is in
 * a finally block and don't fire.
 */
export function checkCleanupSkippedOnEarlyExit(
	content: string,
	filePath: string,
): InlineMatch[] {
	const ext = getExtension(filePath);
	if (!JS_TS_ALL_EXTS.includes(ext)) return [];

	const stripped = stripCommentsAndStrings(content);
	const lines = content.split("\n");
	const matches: InlineMatch[] = [];
	const seen = new Set<number>();

	const recordExit = (exitOffset: number): boolean => {
		const lineNo = stripped.slice(0, exitOffset).split("\n").length;
		if (seen.has(lineNo)) return false;
		seen.add(lineNo);
		matches.push({
			line: lineNo,
			text: (lines[lineNo - 1] || "").trim().slice(0, REPORT_LINE_TRUNC),
		});
		return matches.length >= MAX_MATCHES_PER_FILE;
	};

	for (const exitOffset of namedAcquisitionExits(stripped)) {
		if (recordExit(exitOffset)) return matches;
	}

	for (const exitOffset of eventListenerExits(stripped)) {
		if (recordExit(exitOffset)) return matches;
	}

	return matches;
}
