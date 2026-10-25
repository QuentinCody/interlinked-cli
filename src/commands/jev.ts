// Internal evaluation actions, invoked only by scripts/internal/jev.mjs.
// Not registered in the public CLI or invoked by the harness.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { createJevClient, type JevClient } from "../harness/jev/client.js";
import { buildJevClaimWarning } from "../harness/jev/claim-review.js";
import { formatDocClaimFindings, type ImporterResolver, scoreDocClaims } from "../harness/jev/doc-claim-liveness.js";
import { formatTitleBodyFindings, scoreTestTitles } from "../harness/jev/test-title-body.js";
import { ProjectGraph } from "../harness/project-graph.js";
import { scrubFinalMessage } from "../harness/server/agent-event-capture.js";
import { entryPoints } from "./deadcode.js";
import type { ReceiptShadowOptions, ReceiptShadowRow } from "../harness/jev/receipt-shadow.js";

const EXIT_OK = 0;
const EXIT_UNAVAILABLE = 2;
const TEST_PATH_RE = /(^|\/)(__tests__\/|[^/]*\.(test|spec)\.[cm]?[jt]sx?$)/;

export interface JevCommandOptions {
	/** Injected in tests; resolved from config + key otherwise. `null` = Jev disabled. */
	client?: JevClient | null;
	cwd?: string;
	json?: boolean;
    receiptShadow?: string;
	/** The receipt shadow's OWN client, injected in tests; resolved like `client` otherwise. `null` = shadow unmeasured. */
	shadowClient?: JevClient | null;
}

function resolveClient(opts: JevCommandOptions): JevClient | null {
	if (opts.client !== undefined) return opts.client;
	return createJevClient({ enabled: true });
}

function explainDisabled(): number {
	process.stderr.write(
		"Internal Jev evaluation requires TYPESAFE_API_KEY in the environment or .interlinked/config.local.json.\n",
	);
	return EXIT_UNAVAILABLE;
}

function relPath(cwd: string, file: string): string {
	return isAbsolute(file) ? relative(cwd, file) || file : file;
}

/** Score every it()/test() block in the given test files; print flagged ones. */
export async function jevTestTitlesAction(files: string[], opts: JevCommandOptions = {}): Promise<number> {
	const cwd = opts.cwd ?? process.cwd();
	const client = resolveClient(opts);
	if (!client) return explainDisabled();
	const lines: string[] = [];
	let blocksSeen = 0;
	for (const file of files) {
		const abs = isAbsolute(file) ? file : join(cwd, file);
		if (!existsSync(abs)) continue;
		const content = readFileSync(abs, "utf-8");
		blocksSeen += (content.match(/\b(?:it|test)\s*\(/g) ?? []).length;
		lines.push(...formatTitleBodyFindings(relPath(cwd, file), await scoreTestTitles(client, relPath(cwd, file), content)));
	}
	emit(lines, `jev test-titles: ${lines.length} finding(s) across ${blocksSeen} block(s); spend $${client.spend().usd.toFixed(4)}`, opts);
	return EXIT_OK;
}

/** Import-graph half of the doc-claim check: does the path exist and who imports it (test files excluded)?
 *  An entry point (bin/main/exports, `src/index.ts`, the daemon entry) counts as imported by the runtime. */
export function resolveImportersIn(cwd: string): ImporterResolver {
	let graph: ProjectGraph | null = null;
	const entries = entryPoints(cwd, []);
	entries.add("src/harness/server.ts");
	entries.add("src/hook-entry.ts");
	return (rel) => {
		const abs = join(cwd, rel);
		if (!existsSync(abs)) return { exists: false, nonTestImporters: 0 };
		if (entries.has(rel)) return { exists: true, nonTestImporters: 1 };
		if (!graph) {
			graph = new ProjectGraph(cwd);
			graph.initialize();
		}
		const nonTestImporters = graph.getImporters(abs).filter((e) => !TEST_PATH_RE.test(e.fromFile)).length;
		return { exists: true, nonTestImporters };
	};
}

/** Score every path-naming paragraph in the given markdown files; print live claims the import graph does not back. */
export async function jevDocClaimsAction(files: string[], opts: JevCommandOptions = {}): Promise<number> {
	const cwd = opts.cwd ?? process.cwd();
	const client = resolveClient(opts);
	if (!client) return explainDisabled();
	const resolve = resolveImportersIn(cwd);
	const lines: string[] = [];
	for (const file of files) {
		const abs = isAbsolute(file) ? file : join(cwd, file);
		if (!existsSync(abs)) continue;
		lines.push(...formatDocClaimFindings(relPath(cwd, file), await scoreDocClaims(client, readFileSync(abs, "utf-8"), resolve)));
	}
	emit(lines, `jev doc-claims: ${lines.length} finding(s) across ${files.length} file(s); spend $${client.spend().usd.toFixed(4)}`, opts);
	return EXIT_OK;
}

function emit(lines: string[], summary: string, opts: JevCommandOptions): void {
	if (opts.json) {
		process.stdout.write(`${JSON.stringify({ findings: lines, summary })}\n`);
		return;
	}
	for (const l of lines) process.stdout.write(`${l}\n`);
	process.stdout.write(`${summary}\n`);
}

/** A shadow row carries a sentence of the agent's final message. A sentence no link names is kept only as a
 *  stable digest (the unlinked count survives, the text does not); a linked claim passes the same secrets +
 *  PII scrub and length cap the sibling final-message capture applies. Observation only: the verdict fields
 *  are copied unchanged, so nothing here reaches the judgment path. */
function redactShadowRow(row: ReceiptShadowRow): ReceiptShadowRow {
    if (row.reason === "missing_link") return { ...row, claim: `sha256:${createHash("sha256").update(row.claim).digest("hex").slice(0, 16)}` };
    return { ...row, claim: scrubFinalMessage(row.claim) };
}

/** Explicit internal evaluation of a saved final message and Claude transcript. */
export async function jevClaimsAction(finalFile: string, transcript: string, opts: JevCommandOptions = {}): Promise<number> {
	const client = resolveClient(opts);
	if (!client) return explainDisabled();
    let shadow: ReceiptShadowOptions | undefined;
    let shadowClient: JevClient | null = null;
    if (opts.receiptShadow) {
        // A separate client, so a shadow failure or its spend never reaches the judgment ledger the exit reads.
        shadowClient = opts.shadowClient !== undefined ? opts.shadowClient : createJevClient({ enabled: true });
        let links: unknown[] = [];
        try { const parsed: unknown = JSON.parse(readFileSync(opts.receiptShadow, "utf8")); if (Array.isArray(parsed)) links = parsed; }
        catch (err) { void err; /* fail-open: an unreadable links file leaves every claim missing_link. */ }
        shadow = { enabled: true, links, write: row => {
            const dir = join(opts.cwd ?? process.cwd(), ".interlinked");
            mkdirSync(dir, { recursive: true });
            appendFileSync(join(dir, "claim-receipt-shadow.jsonl"), JSON.stringify(redactShadowRow(row)) + "\n", { mode: 0o600 });
        }, ...(shadowClient ? { client: shadowClient } : {}) };
    }
	const warning = await buildJevClaimWarning(client, {
		last_assistant_message: readFileSync(finalFile, "utf-8"),
		transcript_path: transcript,
	}, shadow);
	const lines = warning ? [warning] : [];
	emit(lines, `jev claims: ${lines.length} warning(s); spend $${client.spend().usd.toFixed(4)}${shadow ? shadowSpendNote(shadowClient) : ""}`, opts);
	return client.spend().failures > 0 ? EXIT_UNAVAILABLE : EXIT_OK; // the judgment ledger only; the shadow's never decides
}

function shadowSpendNote(shadowClient: JevClient | null): string {
	const s = shadowClient?.spend() ?? { usd: 0, calls: 0, failures: 0 };
	return `; shadow spend $${s.usd.toFixed(4)} (${s.calls} call(s), ${s.failures} failure(s))`;
}
