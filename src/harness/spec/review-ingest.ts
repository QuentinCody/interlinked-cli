// Review-report ingestion (docs/design/spec-audit-runtime-checks.md §4,
// spike 4): parse an external reviewer's numbered findings — the Codex/Sol
// strict format and close cousins — into structured rows the findings
// corpus can record. Deterministic text parsing only; tolerant of prose
// around the numbered list; findings without any file anchor still parse
// (they reconcile by ack rather than by touch).

type ReviewSeverity = "critical" | "high" | "medium" | "low" | "unknown";

interface ParsedReviewFinding {
	/** 1-based index as written in the report. */
	index: number;
	severity: ReviewSeverity;
	/** Repo-relative file the finding is anchored to, when the report names one. */
	file?: string;
	line?: number;
	/** One-sentence defect statement (first line of the block, brackets stripped). */
	statement: string;
	/** Verbatim Evidence: line when present. */
	quote?: string;
	/** The full finding block, for provenance. */
	raw: string;
}

// Start of a numbered finding: "12. [severity: high] ..." or "3. text". Must
// begin at column 0 (round-2 #8): an INDENTED numbered line is a sub-list
// inside a finding body (e.g. "  1. first case"), not a new top-level finding.
const FINDING_START_RE = /^(\d{1,3})\.\s+(.*)$/;

const SEVERITY_RE = /\[(?:severity:\s*)?(critical|high|medium|low)\]/i;

/** First path-looking token with an optional :line — "src/a.ts:42",
 *  "[docs/plan.md:12-14]", "COMPREHENSIVE_PLAN.md:235". */
const FILE_LINE_RE =
	/([A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,10})(?::(\d{1,6})(?:-\d{1,6})?)?/g;

const EVIDENCE_RE = /^\s*Evidence:\s*(.*)$/i;

function parseSeverity(text: string): ReviewSeverity {
	const m = SEVERITY_RE.exec(text);
	return m ? ((m[1] ?? "unknown").toLowerCase() as ReviewSeverity) : "unknown";
}

/** A candidate token is a repo anchor only when it neither starts with "/"
 *  nor follows ":" or "/" — both signatures of URL hosts/paths and absolute
 *  paths ("https:" + "//raft.github.io/raft.pdf"). */
function isRepoAnchorCandidate(text: string, start: number, file: string): boolean {
	if (file.startsWith("/")) return false;
	const prev = start > 0 ? text[start - 1] : "";
	return prev !== ":" && prev !== "/";
}

function parseAnchor(text: string): { file?: string; line?: number } {
	FILE_LINE_RE.lastIndex = 0;
	for (const m of text.matchAll(FILE_LINE_RE)) {
		const file = m[1];
		if (!file || !isRepoAnchorCandidate(text, m.index ?? 0, file)) continue;
		const line = m[2] ? Number(m[2]) : undefined;
		return line !== undefined && Number.isFinite(line) ? { file, line } : { file };
	}
	return {};
}

/** Statement = first line minus the severity tag and the [file:line] anchor
 *  bracket. Anchor-shaped brackets (containing "/" or ":line") are REMOVED,
 *  not unwrapped (round-2 #7): unwrapping left the path in the statement, so
 *  the same defect at two sites produced different bug classes. Non-anchor
 *  brackets (e.g. inline `[x]`) are unwrapped as before. */
function cleanStatement(firstLine: string): string {
	return firstLine
		.replace(/\[(?:severity:\s*)?(?:critical|high|medium|low)\]\s*/gi, "")
		.replace(/\[([^\]]*)\]\s*/g, (_m, inner: string) =>
			/[/\\]|:\d/.test(inner) ? "" : `${inner} `,
		)
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Parse a numbered-findings review report. Returns findings in report
 * order. Blocks end at the next numbered item, a "TOTAL:" line, or EOF.
 */
export function parseReviewFindings(text: string): ParsedReviewFinding[] {
	const lines = text.split("\n");
	const out: ParsedReviewFinding[] = [];
	let current: { index: number; first: string; body: string[] } | null = null;
	const flush = (): void => {
		if (!current) return;
		const raw = [current.first, ...current.body].join("\n").trim();
		const evidence = current.body
			.map((l) => EVIDENCE_RE.exec(l)?.[1])
			.find((q) => q && q.length > 0);
		const anchorSource = `${current.first} ${current.body.join(" ")}`;
		out.push({
			index: current.index,
			severity: parseSeverity(current.first),
			...parseAnchor(anchorSource),
			statement: cleanStatement(current.first).slice(0, 300),
			...(evidence ? { quote: evidence.slice(0, 300) } : {}),
			raw: raw.slice(0, 2000),
		});
		current = null;
	};
	for (const line of lines) {
		if (/^\s*TOTAL:\s*\d+/i.test(line)) break;
		const start = FINDING_START_RE.exec(line);
		if (start) {
			flush();
			current = { index: Number(start[1]), first: start[2] ?? "", body: [] };
		} else if (current) {
			current.body.push(line);
		}
	}
	flush();
	return out;
}
