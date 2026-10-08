// ===========================================
// External-origin file registry (per session, in memory)
// ===========================================
// Records files that a PUBLIC, UNAUTHENTICATED fetch wrote in this session
// (`curl -o`, `curl -O`, `wget -O`, wget's default name, `yt-dlp -o`, and
// `>` / `>>` / `| tee` of a pipeline whose producer is such a fetch). The
// secret-output origin classifier reads it: a secret-shaped value printed
// from such a file is public content, not a leak.
//
// Fail-safe by construction:
//   - Each entry keeps a fingerprint (size, mtime, inode). ANY later change
//     to the file — Write/Edit, `cp`, an interpreter, another process — makes
//     the fingerprint stale and the file local again, with no parsing needed.
//   - Write/Edit tools and non-fetch redirects also remove entries explicitly.
//   - A recorded file must have been written within the last two minutes, so
//     a fetch that failed and left an older local file in place records nothing.
//   - A later stage in the same command that names the file with a non-filter
//     command (`cp`, `sed -i`, `python3`, …) drops the record.
//   - The registry persists with the session snapshot (external-origin-store.ts);
//     on reload an entry whose file changed or vanished is dropped.
// Dry runs (`event.dry_run`) change nothing.

import { realpathSync } from "node:fs";
import { nonNull } from "../../lib/non-null.js";
import { DEFAULT_EGRESS_FILTER_CONFIG, filterOutputEgress } from "../output-egress-filter.js";
import { basename, resolve } from "node:path";
import { extractAllEditedFilePaths } from "../server-tool-helpers.js";
import type { GuardRulesConfig, HarnessEvent, SessionTrajectory, TaintTrackingConfig } from "../types.js";
import { boundVariables, commandHead, expandArgv, type Pipeline, splitPipelines, type Stage } from "./bash-stage-parse.js";
import { fetchTargetsOf, publicFetchOf } from "./public-fetch-stage.js";
import { CONTROL_HEADS, FILTER_HEADS, filterInputs, type OperandContext, stageInputFiles } from "./stage-operands.js";
import { isBash, isFileWrite } from "./tool-classifiers.js";
import { readToolString } from "./tool-input-values.js";
import { resolveBashWriteTarget } from "../pre-checks-bash-write-detect.js";
import {
	EXTERNAL_ORIGIN_MAX_FILES,
	type ExternalOriginFile,
	externalOriginEntries,
	fingerprintMatches,
	setExternalOriginEntries,
	statRegularFile,
} from "../external-origin-store.js";

export { EXTERNAL_ORIGIN_MAX_FILES, type ExternalOriginFile };
const FRESH_WRITE_WINDOW_MS = 120_000;

const EXCERPT_MAX = 120;

/** A command or URL excerpt safe to store in diagnostics: secret values
 *  redacted, whitespace collapsed, at most 120 characters. */
export function redactedExcerpt(text: string): string {
	const redacted = filterOutputEgress(text, DEFAULT_EGRESS_FILTER_CONFIG).filtered.replace(/\s+/g, " ").trim();
	return redacted.length <= EXCERPT_MAX ? redacted : `${redacted.slice(0, EXCERPT_MAX - 1)}…`;
}

function canonicalPath(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return resolve(p);
	}
}

/** Record `path` (which must exist as a regular file) as fetched from `source`. */
export function recordExternalOriginFile(
	session: SessionTrajectory,
	path: string,
	source: string,
	now: number = Date.now(),
): boolean {
	const abs = canonicalPath(path);
	const st = statRegularFile(abs);
	if (!st) return false;
	const kept = externalOriginEntries(session).filter((e) => e.path !== abs);
	kept.push({ path: abs, source, size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, recorded_at: now });
	setExternalOriginEntries(session, kept);
	return true;
}

function forgetExternalOriginFile(session: SessionTrajectory, path: string): void {
	const abs = canonicalPath(path);
	const list = externalOriginEntries(session);
	if (list.some((e) => e.path === abs)) setExternalOriginEntries(session, list.filter((e) => e.path !== abs));
}

/** The registry entry for `path`, only while the file is unchanged since it was recorded. */
export function externalOriginOf(session: SessionTrajectory, path: string): ExternalOriginFile | undefined {
	const abs = canonicalPath(path);
	const entry = externalOriginEntries(session).find((e) => e.path === abs);
	return entry && fingerprintMatches(entry) ? entry : undefined;
}

// ---------- write planning for one Bash command ----------

interface PlannedWrite {
	path: string;
	source: string;
}

interface PipelineWrites {
	fetched: PlannedWrite[];
	other: string[];
}

type IsExternal = (abs: string) => boolean;

interface WritePlan {
	record: PlannedWrite[];
	forget: string[];
}

function resolveTarget(ctx: OperandContext, stage: Stage, target: string): string | null {
	const abs = resolveBashWriteTarget(ctx.command.slice(0, stage.end), target, ctx.cwd);
	return abs === null ? null : canonicalPath(abs);
}

/** Every file a stage writes: redirects, tee arguments, fetch outputs. */
function stageWrites(stage: Stage, argvs: readonly string[][]): string[] {
	const out = [...stage.outputs];
	for (const argv of argvs) {
		if (commandHead(argv[0]) === "tee") out.push(...argv.slice(1).filter((t) => !t.startsWith("-")));
		out.push(...(fetchTargetsOf(argv)?.targets ?? []));
	}
	return out;
}

function allExternal(files: readonly string[] | null, isExternal: IsExternal): boolean {
	return files !== null && files.every(isExternal);
}

/** The public URL of a pipeline's producer stage, when every expansion of it
 *  is a public fetch that reads no local file. */
function producerUrl(ctx: OperandContext, stage: Stage, argvs: readonly string[][], isExternal: IsExternal): string | null {
	let url: string | null = null;
	for (const argv of argvs) {
		const fetch = publicFetchOf(stage.text, argv);
		if (!fetch || !allExternal(stageInputFiles(ctx, stage, argv, new Set(fetch.consumed)), isExternal)) return null;
		url ??= fetch.url;
	}
	return url;
}

function laterStagesClean(ctx: OperandContext, p: Pipeline, expanded: ReadonlyArray<string[][] | null>, isExternal: IsExternal): boolean {
	return p.stages.slice(1).every((stage, i) => {
		const argvs = expanded[i + 1];
		return !!argvs && argvs.every((argv) => allExternal(filterInputs(ctx, stage, argv), isExternal));
	});
}

function pipelineWrites(
	ctx: OperandContext,
	p: Pipeline,
	vars: ReadonlyMap<string, string[]>,
	isExternal: IsExternal,
): PipelineWrites {
	const expanded = p.stages.map((s) => (s.dynamic ? null : expandArgv(s.argv, vars)));
	const writes = p.stages.map((s, i) => stageWrites(s, expanded[i] ?? []));
	const first = expanded[0];
	const url = first ? producerUrl(ctx, nonNull(p.stages[0]), first, isExternal) : null;
	const clean = url !== null && laterStagesClean(ctx, p, expanded, isExternal);
	const result: PipelineWrites = { fetched: [], other: [] };
	p.stages.forEach((stage, i) => {
		for (const target of writes[i] ?? []) {
			const abs = resolveTarget(ctx, stage, target);
			if (abs === null) continue;
			if (clean && url) result.fetched.push({ path: abs, source: redactedExcerpt(url) });
			else result.other.push(abs);
		}
	});
	return result;
}

/** A later stage that names a recorded file through a non-filter command may rewrite it. */
function mayRewrite(p: Pipeline, path: string): boolean {
	const name = basename(path);
	return p.stages.some((s) => {
		if (!s.text.includes(name)) return false;
		const head = commandHead(s.argv[0]);
		return s.dynamic || head === "tee" || !(FILTER_HEADS.has(head) || CONTROL_HEADS.has(head));
	});
}

/** Which files this command wrote from a public fetch, and which it wrote otherwise. */
function planBashWrites(command: string, cwd: string, isExternal: IsExternal): WritePlan {
	const ctx: OperandContext = { command, cwd };
	const pipelines = splitPipelines(command);
	const vars = boundVariables(pipelines);
	const record = new Map<string, { source: string; idx: number }>();
	const forget: string[] = [];
	pipelines.forEach((p, idx) => {
		for (const [path, rec] of [...record]) {
			if (rec.idx < idx && mayRewrite(p, path)) {
				record.delete(path);
				forget.push(path);
			}
		}
		const w = pipelineWrites(ctx, p, vars, isExternal);
		for (const path of w.other) {
			record.delete(path);
			forget.push(path);
		}
		for (const r of w.fetched) record.set(r.path, { source: r.source, idx });
	});
	return { record: [...record].map(([path, v]) => ({ path, source: v.source })), forget };
}

function isFresh(path: string, now: number): boolean {
	const st = statRegularFile(path);
	return st !== null && Number.isFinite(st.mtimeMs) && now - st.mtimeMs <= FRESH_WRITE_WINDOW_MS;
}

function taintTrackingOf(rules: GuardRulesConfig): TaintTrackingConfig | undefined {
	return rules.taint_tracking;
}

/** PostToolUse: keep the registry in step with this tool call's writes. */
export function updateExternalOriginRegistry(
	event: HarnessEvent,
	rules: GuardRulesConfig,
	session: SessionTrajectory | undefined,
	now: number = Date.now(),
): void {
	if (!session || !taintTrackingOf(rules)?.enabled || event.dry_run === true) return;
	const cwd = event.cwd || process.cwd();
	const tool = event.tool_name || "";
	if (isFileWrite(tool)) {
		for (const p of extractAllEditedFilePaths(event)) forgetExternalOriginFile(session, resolve(cwd, p));
		return;
	}
	const command = isBash(tool) ? readToolString(event.tool_input?.command) : "";
	if (!command) return;
	const isExternal: IsExternal = (abs) => externalOriginOf(session, abs) !== undefined;
	const plan = planBashWrites(command, cwd, isExternal);
	for (const path of plan.forget) forgetExternalOriginFile(session, path);
	for (const r of plan.record) if (isFresh(r.path, now)) recordExternalOriginFile(session, r.path, r.source, now);
}
