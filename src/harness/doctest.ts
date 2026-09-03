// ===========================================
// Doc-example runner (DW P4 — doc-example runner)
// ===========================================
// Extracts fenced code blocks that OPT IN via a `doctest` info-string tag
// (```bash doctest / ```sh doctest) and runs each, asserting exit 0 — so a
// command example in the docs that has rotted (renamed flag, removed command)
// fails loudly instead of silently misleading readers. SAFE BY CONSTRUCTION:
// only explicitly-tagged blocks run; ordinary illustrative fences are ignored,
// so a doc full of `rm -rf` examples is never executed. Extraction is pure and
// execution is injected, so the whole thing is unit-testable without a shell.

interface DoctestBlock {
	/** The fence language (bash / sh / …). */
	lang: string;
	/** The block body (the commands to run). */
	code: string;
	/** 1-indexed line of the opening fence, for reporting. */
	line: number;
}

/** The info-string marker a fence must carry to be run. */
const DOCTEST_TAG = "doctest";

type OpenDoctestBlock = { lang: string; line: number; body: string[] };

/**
 * Handle one line while a doctest block is already open: close it (pushing
 * the finished block onto `blocks`) if this line is a closing fence — bare
 * (``` `~~~ ` with no info string) or one carrying its own info string —
 * otherwise append the line to the open block's body. Returns the block's
 * new open state: the same block (still open) or `null` (just closed).
 */
function advanceOpenDoctestBlock(
	open: OpenDoctestBlock,
	fence: RegExpMatchArray | null,
	raw: string,
	blocks: DoctestBlock[],
): OpenDoctestBlock | null {
	if (fence && (fence[1] ?? "").trim() === "") {
		blocks.push({ lang: open.lang, code: open.body.join("\n"), line: open.line });
		return null;
	}
	if (/^\s*(?:```|~~~)/.test(raw)) {
		// A fence with an info string closes nothing — treat as body end guard.
		blocks.push({ lang: open.lang, code: open.body.join("\n"), line: open.line });
		return null;
	}
	open.body.push(raw);
	return open;
}

/**
 * Extract every fenced block whose info string includes the `doctest` tag.
 * Handles ``` and ~~~ fences; nested/indented fences are not supported (kept
 * deliberately simple — doctest blocks are authored top-level).
 */
export function extractDoctestBlocks(markdown: string): DoctestBlock[] {
	const lines = markdown.split("\n");
	const blocks: DoctestBlock[] = [];
	let open: OpenDoctestBlock | null = null;
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i] ?? "";
		const fence = raw.match(/^\s*(?:```|~~~)\s*(.*)$/);
		if (open) {
			open = advanceOpenDoctestBlock(open, fence, raw, blocks);
			continue;
		}
		if (fence) {
			const info = (fence[1] ?? "").trim().split(/\s+/);
			if (info.includes(DOCTEST_TAG)) {
				open = { lang: info[0] ?? "", line: i + 1, body: [] };
			}
		}
	}
	return blocks;
}

interface DoctestResult {
	block: DoctestBlock;
	exitCode: number;
	ok: boolean;
	output?: string;
}

interface DoctestRunSummary {
	total: number;
failed: number;
	results: DoctestResult[];
}

/** Execute a doctest command, returning its exit code (and optional output). */
export type DoctestExec = (code: string) => { exitCode: number; output?: string };

/**
 * Run each extracted block through the injected executor and collect the
 * outcomes. A block is `ok` iff it exits 0. Pure over the injected exec.
 */
export function runDocExamples(blocks: readonly DoctestBlock[], exec: DoctestExec): DoctestRunSummary {
	const results: DoctestResult[] = [];
	let failed = 0;
	for (const block of blocks) {
		const { exitCode, output } = exec(block.code);
		const ok = exitCode === 0;
		if (!ok) failed++;
		results.push({ block, exitCode, ok, ...(output !== undefined ? { output } : {}) });
	}
	return { total: blocks.length, failed, results };
}
