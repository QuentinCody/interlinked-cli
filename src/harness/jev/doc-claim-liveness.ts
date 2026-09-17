// Jev check C — a doc or commit message CLAIMS a module is live; is anything
// importing it?
//
// The 2026-09-02 deletion wave found seven modules whose commit or design doc
// said the feature was live while nothing imported them. Half of that check is
// deterministic (the import graph); the other half — "does this paragraph
// assert the code runs today?" — is semantic. Jev supplies the semantic half;
// code does the graph half. On-demand (`interlinked jev doc-claims`), never in
// the registry; advisory behind `jev.enabled`.
//
// MEASURED (2026-09-16, scratch/2026-09-16-jev-checks/CAMPAIGN + c2-scores):
//   42 paragraphs (40 docs, 2 commits), blind labels 19 live / 23 not:
//   paragraph Noul AUROC 0.819; at p≥0.7 precision 16/20, recall 16/19;
//   Brier 0.177 vs 0.248 constant. Path-level attribution weaker (at 0.5:
//   20 tp / 10 fp / 16 fn), so the per-path gate is a secondary filter only.

import type { JevClient } from "./client.js";
import type { JevQuestion } from "./types.js";

/** Operating point from the eval: paragraph-level live probability. */
export const DOC_CLAIM_LIVE_NOUL_MIN = 0.7;
/** Secondary filter: the per-path Noul must at least lean yes. */
export const DOC_CLAIM_PATH_NOUL_MIN = 0.5;
const MIN_PARAGRAPH_CHARS = 40;
const SRC_PATH_RE = /\b(?:src|cloud\/src)\/[\w./-]+\.(?:ts|mts|mjs|js)\b/g;

export interface DocParagraph {
	/** 1-based line where the paragraph starts. */
	line: number;
	text: string;
	paths: string[];
}

export interface DocClaimFinding {
	line: number;
	path: string;
	pLive: number;
	pPath: number;
	exists: boolean;
	nonTestImporters: number;
}

/** Answers "does this repo-relative path exist, and how many non-test files import it?" */
export type ImporterResolver = (relPath: string) => { exists: boolean; nonTestImporters: number };

const LIVE_CRITERIA = {
	true: {
		what: "The text asserts the code is wired, running, enforced, shipped, or landed in the current tree (present tense, done)",
		examples: ["X now runs on every PostToolUse", "wired in server.ts", "shipped 2026-06", "the gate blocks when …"],
	},
	false: {
		what: "A design, plan, proposal, TODO, historical note, removal/deletion, test-only or example mention, or a sentence that names the path without asserting it runs",
		examples: ["designed but not built", "would live in …", "deleted 2026-08", "see the fixture in …"],
	},
};

/** Paragraphs (blank-line separated) that name at least one source path. */
export function extractPathParagraphs(content: string): DocParagraph[] {
	const out: DocParagraph[] = [];
	let line = 1;
	for (const block of content.split(/\n[ \t]*\n/)) {
		const text = block.trim();
		const paths = [...new Set(text.match(SRC_PATH_RE) ?? [])];
		if (text.length >= MIN_PARAGRAPH_CHARS && paths.length > 0 && !text.startsWith("```")) {
			out.push({ line: line + (block.length - block.trimStart().length ? block.slice(0, block.length - block.trimStart().length).split("\n").length - 1 : 0), text, paths });
		}
		line += block.split("\n").length + 1;
	}
	return out;
}

export function liveClaimQuestions(paths: readonly string[]): Record<string, JevQuestion> {
	const questions: Record<string, JevQuestion> = {
		live_any: {
			type: "noul",
			instructions: { question: "Does `text` claim that at least one of `paths` is live in the current codebase?", inspect: "text" },
			criteria: LIVE_CRITERIA,
		},
	};
	paths.forEach((p, i) => {
		questions[`p${i}`] = {
			type: "noul",
			instructions: { question: `Does \`text\` claim that \`${p}\` specifically is live (wired/running/enforced) in the current codebase?`, inspect: "text" },
			criteria: LIVE_CRITERIA,
		};
	});
	return questions;
}

async function scoreParagraph(client: JevClient, para: DocParagraph, resolve: ImporterResolver): Promise<DocClaimFinding[]> {
	const res = await client.ask({ text: para.text, paths: para.paths }, liveClaimQuestions(para.paths));
	const any = res?.answers.live_any;
	if (!any || any.type !== "noul" || any.noul < DOC_CLAIM_LIVE_NOUL_MIN) return [];
	const out: DocClaimFinding[] = [];
	para.paths.forEach((path, i) => {
		const a = res.answers[`p${i}`];
		if (!a || a.type !== "noul" || a.noul < DOC_CLAIM_PATH_NOUL_MIN) return;
		const { exists, nonTestImporters } = resolve(path);
		if (exists && nonTestImporters > 0) return;
		out.push({ line: para.line, path, pLive: any.noul, pPath: a.noul, exists, nonTestImporters });
	});
	return out;
}

/** One Jev call per path-naming paragraph; only claims the import graph fails to back are returned. */
export async function scoreDocClaims(client: JevClient, content: string, resolve: ImporterResolver): Promise<DocClaimFinding[]> {
	const findings: DocClaimFinding[] = [];
	for (const para of extractPathParagraphs(content)) findings.push(...(await scoreParagraph(client, para, resolve)));
	return findings;
}

export function formatDocClaimFindings(file: string, findings: readonly DocClaimFinding[]): string[] {
	return findings.map((f) => {
		const why = f.exists ? "no non-test importer" : "the file does not exist";
		return `[interlinked:jev-doc-claim] [heuristic] ${file}:${f.line} claims ${f.path} is live (p=${f.pLive.toFixed(2)}) but ${why}`;
	});
}
