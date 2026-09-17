// `interlinked jev test-titles <files…>` / `interlinked jev doc-claims <files…>`
//
// On-demand surfaces for the two Jev (TypeSafe System One) checks that judge
// a SEMANTIC question the deterministic registry cannot: does a test body
// test its title, and does a doc claim a module is live that nothing imports.
// Both are advisory and opt-in (`jev.enabled` + `TYPESAFE_API_KEY` in
// config.local.json); neither runs on the hook path or inside `verify`
// (per feedback_harness_deterministic_only). Findings carry `[heuristic]`.
// Measurements live in the module headers under src/harness/jev/.

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { createJevClient, type JevClient } from "../harness/jev/client.js";
import { formatDocClaimFindings, type ImporterResolver, scoreDocClaims } from "../harness/jev/doc-claim-liveness.js";
import { formatTitleBodyFindings, scoreTestTitles } from "../harness/jev/test-title-body.js";
import { ProjectGraph } from "../harness/project-graph.js";
import { loadRules } from "../harness/rules-loader.js";
import { entryPoints } from "./deadcode.js";

const EXIT_OK = 0;
const EXIT_UNAVAILABLE = 2;
const TEST_PATH_RE = /(^|\/)(__tests__\/|[^/]*\.(test|spec)\.[cm]?[jt]sx?$)/;

export interface JevCommandOptions {
	/** Injected in tests; resolved from config + key otherwise. `null` = Jev disabled. */
	client?: JevClient | null;
	cwd?: string;
	json?: boolean;
}

function resolveClient(opts: JevCommandOptions, cwd: string): JevClient | null {
	if (opts.client !== undefined) return opts.client;
	return createJevClient(loadRules(cwd).jev);
}

function explainDisabled(): number {
	process.stderr.write(
		"Jev is not enabled. Set `jev.enabled: true` in .interlinked/guard-rules.local.json and put TYPESAFE_API_KEY in .interlinked/config.local.json (or the environment).\n",
	);
	return EXIT_UNAVAILABLE;
}

function relPath(cwd: string, file: string): string {
	return isAbsolute(file) ? relative(cwd, file) || file : file;
}

/** Score every it()/test() block in the given test files; print flagged ones. */
export async function jevTestTitlesAction(files: string[], opts: JevCommandOptions = {}): Promise<number> {
	const cwd = opts.cwd ?? process.cwd();
	const client = resolveClient(opts, cwd);
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
	const client = resolveClient(opts, cwd);
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
