// Jev check B — does a test's BODY test what its TITLE claims?
//
// The deterministic `test_name_matcher_mismatch` detector was built and left
// UNREGISTERED at 0/8 precision: a title's claim is semantic, and matcher
// regexes cannot see it. This module asks Jev the semantic question per
// it()/test() block, on demand (`interlinked jev test-titles`), never in the
// registry — per feedback_harness_deterministic_only the check pipeline stays
// deterministic; this is an opt-in advisory surface behind `jev.enabled`.
//
// MEASURED (2026-09-16, scratch/2026-09-16-jev-checks/CAMPAIGN + b2-scores):
//   40 constructed title swaps vs 40 real blocks (blind-labeled 40/40 match):
//   AUROC 0.922; requiring BOTH verdict=mismatch AND matches<0.5 caught 25/40
//   swaps with 1–2/40 false alarms on real tests. Recall is ~63%; precision on
//   real positives is unmeasured (the hardened tree had none). Advisory only.

import { findCallSpan } from "../checks/test-hygiene-shared.js";
import type { JevClient } from "./client.js";
import type { JevQuestion } from "./types.js";

/** Operating point from the eval: flag only when the match probability is below this AND the verdict is `mismatch`. */
export const TITLE_BODY_MISMATCH_NOUL_MAX = 0.5;

export interface TestBlock {
	title: string;
	body: string;
	/** 1-based line of the it()/test() opener. */
	line: number;
}

export interface TitleBodyFinding {
	line: number;
	title: string;
	matches: number;
	verdict: string;
	confidence: number;
}

const TEST_INTRO_RE = /\b(?:it|test)(?:\.(?:only|skip|todo|concurrent))*\s*\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1\s*,/g;

export const TITLE_BODY_QUESTIONS: Record<string, JevQuestion> = {
	matches: {
		type: "noul",
		instructions: {
			question: "Do the assertions in `body` exercise the behaviour that `title` names?",
			focus: "A title broader than the body but not contradicted still matches. A title that promises an outcome (throws, returns null, is empty, is called) the body never checks does not.",
		},
		criteria: {
			true: { what: "The body's assertions check the outcome or behaviour the title describes" },
			false: { what: "The body checks something else, or checks nothing the title promises" },
		},
	},
	verdict: {
		type: "choice",
		instructions: "Which best describes the relationship between `title` and `body`?",
		criteria: {
			match: "The body tests what the title says",
			partial: "The body tests part of the title's claim or a closely related property",
			mismatch: "The body tests something different from what the title says",
		},
	},
};

const NEWLINE = 10;

function lineOf(content: string, index: number): number {
	let line = 1;
	for (let i = 0; i < index; i++) if (content.charCodeAt(i) === NEWLINE) line++;
	return line;
}

/** Every it()/test() block: title, the source after the title comma up to the closing paren, opener line. */
export function extractTestBlocks(content: string): TestBlock[] {
	const out: TestBlock[] = [];
	TEST_INTRO_RE.lastIndex = 0;
	let m = TEST_INTRO_RE.exec(content);
	while (m !== null) {
		const openParen = content.indexOf("(", m.index);
		const span = findCallSpan(content, openParen + 1);
		const title = m[2] ?? "";
		if (span && title.length > 0) {
			out.push({ title, body: content.slice(m.index + m[0].length, span.end).trim(), line: lineOf(content, m.index) });
		}
		m = TEST_INTRO_RE.exec(content);
	}
	return out;
}

async function scoreBlock(client: JevClient, file: string, block: TestBlock): Promise<TitleBodyFinding | null> {
	const res = await client.ask({ file, title: block.title, body: block.body }, TITLE_BODY_QUESTIONS);
	const m = res?.answers.matches;
	const v = res?.answers.verdict;
	if (!m || m.type !== "noul" || !v || v.type !== "choice") return null;
	if (v.choice !== "mismatch" || m.noul >= TITLE_BODY_MISMATCH_NOUL_MAX) return null;
	return { line: block.line, title: block.title, matches: m.noul, verdict: v.choice, confidence: v.confidence };
}

/** One Jev call per block (state differs per block, so calls cannot batch); only flagged blocks are returned. */
export async function scoreTestTitles(client: JevClient, file: string, content: string): Promise<TitleBodyFinding[]> {
	const findings: TitleBodyFinding[] = [];
	for (const block of extractTestBlocks(content)) {
		const f = await scoreBlock(client, file, block);
		if (f) findings.push(f);
	}
	return findings;
}

export function formatTitleBodyFindings(file: string, findings: readonly TitleBodyFinding[]): string[] {
	return findings.map(
		(f) =>
			`[interlinked:jev-test-title] [heuristic] ${file}:${f.line} "${f.title}" — body may not test the title (match p=${f.matches.toFixed(2)}, verdict ${f.verdict} @${f.confidence.toFixed(2)})`,
	);
}
