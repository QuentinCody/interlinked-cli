// interlinked-tdd: exempt
// Diff-aware behavioral checks (Batch 3) — re-introduction detector.
//
// Section 6 of behavioral-diff-checks.ts, extracted to keep the entry
// module under the per-file line cap. Behavior is byte-identical.

import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { extractAddedLines, getStagedDiff } from "./behavioral-checks.js";
import type { CheckResultEntry, SessionTrajectory } from "./types.js";

// ==========================================================================
// 6. Re-introduces removed code
// ==========================================================================
// For added lines matching loud-pattern markers (`console.log`, `// TODO`,
// `as any`, `// FIXME`, `debugger`, `xit`, `.skip`, `@ts-ignore`), run a
// targeted `git log -S<phrase>` to detect whether a recent commit removed
// the same line. A hit means the agent re-introduced something a prior
// commit deliberately deleted.
//
// Scoped narrowly because `git log -S` is O(history-size). Only fires on
// known-loud markers — full re-introduction detection at scale would need
// the trigram index, deferred to a later batch.

const LOUD_REINTRO_RE =
	/(?:console\s*\.\s*(?:log|info|debug|warn)\s*\(|\/\/\s*(?:TODO|FIXME|XXX|HACK)\b|\bas\s+any\b|\bdebugger\b|\bxit\s*\(|\bxdescribe\s*\(|\.\s*skip\s*\(|\/\/\s*@ts-(?:ignore|expect-error)\b)/;

const REINTRO_LOG_TIMEOUT_MS = 3000;
const REINTRO_LOOKBACK_COMMITS = 50;

function gitLogContainsRemoval(repoCwd: string, phrase: string): string | null {
	if (phrase.length < 8) return null;
	try {
		// `git log -S<phrase>` (the "pickaxe" search) returns commits whose
		// diff changes the count of <phrase>. We want commits that
		// REDUCED the count (removed the line), so iterate the matches and
		// keep the first whose diff contains a `-` line matching the phrase.
		const r = spawnSync(
			"git",
			[
				"-C",
				repoCwd,
				"log",
				`-${REINTRO_LOOKBACK_COMMITS}`,
				`-S${phrase}`,
				"--pretty=format:%H %s",
				"--no-color",
			],
			{ encoding: "utf-8", timeout: REINTRO_LOG_TIMEOUT_MS },
		);
		if (r.status !== 0 || !r.stdout) return null;
		const candidateCommits = r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
		for (const commitLine of candidateCommits) {
			const sha = commitLine.split(" ", 1)[0];
			if (!sha) continue;
			// Confirm THIS commit's diff actually removed the phrase (rather
			// than added it). Without this filter, the original-introduction
			// commit also matches `-S` and we'd false-positive.
			const show = spawnSync(
				"git",
				["-C", repoCwd, "show", "--no-color", "--unified=0", sha],
				{ encoding: "utf-8", timeout: REINTRO_LOG_TIMEOUT_MS },
			);
			if (show.status !== 0 || !show.stdout) continue;
			for (const line of show.stdout.split("\n")) {
				if (line.startsWith("-") && !line.startsWith("---") && line.includes(phrase)) {
					return commitLine;
				}
			}
		}
		return null;
	} catch {
		return null;
	}
}

function findRepoCwd(file: string): string | null {
	let dir = existsSync(file) && statSync(file).isFile() ? dirname(file) : file;
	dir = resolve(dir);
	for (let i = 0; i < 10; i++) {
		if (existsSync(resolve(dir, ".git"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

/** Public API — flags lines re-introduced after a prior commit removed them. */
export function checkReintroducesRemovedCode(session: SessionTrajectory): CheckResultEntry[] {
	const results: CheckResultEntry[] = [];
	const MAX_PER_FILE = 2;
	const MAX_TOTAL = 5;

	for (const file of session.files_written) {
		if (results.length >= MAX_TOTAL) break;
		collectFileReintroductions(file, results, MAX_PER_FILE, MAX_TOTAL);
	}
	return results;
}

/**
 * Scans one written file's staged diff and appends each re-introduction it
 * finds to `results`, stopping at the per-file and total caps.
 */
function collectFileReintroductions(
	file: string,
	results: CheckResultEntry[],
	maxPerFile: number,
	maxTotal: number,
): void {
	const diff = getStagedDiff(file);
	if (!diff) return;
	const repoCwd = findRepoCwd(file);
	if (!repoCwd) return;
	const seenPhrases = new Set<string>();
	let perFile = 0;
	for (const rawLine of extractAddedLines(diff).split("\n")) {
		if (perFile >= maxPerFile) break;
		if (results.length >= maxTotal) break;
		const finding = judgeAddedLine(rawLine, repoCwd, seenPhrases, file);
		if (!finding) continue;
		perFile++;
		results.push(finding);
	}
}

/**
 * Decides whether one added diff line re-introduces removed code. Records the
 * phrase in `seenPhrases` so a repeated marker costs only one pickaxe search.
 */
function judgeAddedLine(
	rawLine: string,
	repoCwd: string,
	seenPhrases: Set<string>,
	file: string,
): CheckResultEntry | null {
	const line = rawLine.trim();
	if (line.length < 8) return null;
	// Search by the loud-marker substring, not the full line — agents
	// often re-introduce a `console.log("X")` inside a different
	// surrounding statement, and pickaxe needs an exact substring match.
	const loud = LOUD_REINTRO_RE.exec(line);
	if (!loud) return null;
	const phrase = extractDistinctivePhrase(line, loud[0]);
	if (!phrase || seenPhrases.has(phrase)) return null;
	seenPhrases.add(phrase);
	const removalCommit = gitLogContainsRemoval(repoCwd, phrase);
	if (!removalCommit) return null;
	return {
		source: "structural",
		name: "reintroduces_removed_code",
		severity: "warning",
		message: `Re-introduces \`${phrase.slice(0, 80)}\` — a prior commit removed this (last removal: ${removalCommit.slice(0, 70)}). Verify the cleanup wasn't intentional before re-adding.`,
		file,
		determinism: "fully_deterministic",
	};
}

/**
 * Pickaxe (`git log -S`) needs an exact substring. We start from the
 * regex-matched marker (e.g. `console.log(`) and grow forward through the
 * line until we capture a balanced closing paren or a meaningful token —
 * giving pickaxe enough context to avoid noise on every occurrence of the
 * bare marker, while still being a real substring of any prior commit
 * that contained the same call.
 */
function extractDistinctivePhrase(line: string, marker: string): string | null {
	const idx = line.indexOf(marker);
	if (idx < 0) return null;
	// Walk forward, tracking paren depth, until depth hits 0 after opening.
	let depth = 0;
	let opened = false;
	for (let i = idx; i < line.length; i++) {
		const ch = line[i];
		if (ch === "(") {
			depth++;
			opened = true;
		} else if (ch === ")") {
			depth--;
			if (opened && depth === 0) {
				return line.slice(idx, i + 1);
			}
		}
	}
	// Marker has no balanced parens — fall back to the marker plus 30 chars.
	return line.slice(idx, Math.min(line.length, idx + 30));
}
