// ===========================================
// `interlinked packets budget|release|restore` — instruction text leaves the context (stage 5)
// ===========================================
// `budget` reports, per source file, which spans a Pass 1 rule, a live packet or a
// release already holds (design §9). `release <file>` moves every live (warn/cosign)
// unreleased span of that file into `release.text`, leaves a one-line pointer and
// recomputes `sources[file]` — one transaction: both files are written to temp
// files first, then renamed; if the second rename fails the first is rolled back.
// `restore <file>` is the exact inverse and works on a stale packet set too (a
// demoted or stale packet must always be restorable). Nothing here calls Jev.

import { safeReadFile as readOrNull } from "../harness/evaluator/safe-read-file.js";
import { isUtf8 } from "node:buffer";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { acquirePacketLock, lockRefusal, sweepStaleTemps, writePairAtomic } from "./packets-release-io.js";
import { packetBudget, type Pass1Rule, renderBudget } from "../harness/packets/budget.js";
import { loadPacketFile } from "../harness/packets/evaluator.js";
import { startFallbackEntries } from "../harness/packets/fallback-start.js";
import { loadRules } from "../harness/rules-loader.js";
import { releaseEdit, restoreEdit } from "../harness/packets/release.js";
import { parsePacketFile } from "../harness/packets/schema.js";
import { escapesRoot, isGlobalSource, resolveSourcePath } from "../harness/packets/source-path.js";
import { PACKET_FILE_BASENAME, type PacketFile } from "../harness/packets/types.js";

export interface PacketsBudgetOpts {
	json?: boolean;
	cwd?: string;
	/** Runner whose liveness decides whether a release saves anything (default claude-code). */
	runner?: string;
}
export interface PacketsReleaseOpts {
	/** Source file, repo-relative, as the packet's `source.file` names it. */
	file: string;
	only?: string[];
	dry?: boolean;
	json?: boolean;
	cwd?: string;
}
export interface PacketsRestoreOpts {
	file: string;
	json?: boolean;
	cwd?: string;
}

function packetPath(cwd: string): string {
	return join(cwd, ".interlinked", PACKET_FILE_BASENAME);
}

function readBytesOrNull(path: string): Buffer | null {
	try {
		return readFileSync(path);
	} catch {
		return null;
	}
}

const sourcePath = resolveSourcePath;

/** Pass 1 provenance from `.interlinked/distilled-rules.json`: enabled rules whose `source` names a file and a quote. */
export function readPass1Rules(cwd: string): Pass1Rule[] {
	const text = readOrNull(join(cwd, ".interlinked", "distilled-rules.json"));
	if (text === null) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return [];
	}
	const rules = typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { rules?: unknown }).rules) ? ((parsed as { rules: unknown[] }).rules) : [];
	const out: Pass1Rule[] = [];
	for (const entry of rules) {
		if (typeof entry !== "object" || entry === null) continue;
		const r = entry as { id?: unknown; enabled?: unknown; source?: unknown };
		if (r.enabled === false || typeof r.id !== "string" || typeof r.source !== "object" || r.source === null) continue;
		const s = r.source as { file?: unknown; quote?: unknown };
		if (typeof s.file !== "string" || typeof s.quote !== "string") continue;
		out.push({ id: r.id, file: s.file, quote: s.quote });
	}
	return out;
}

/** Exit codes: 0 reported, 1 packet file missing or invalid. */
export function packetsBudgetCommand(opts: PacketsBudgetOpts): number {
	const cwd = opts.cwd ?? process.cwd();
	const text = readOrNull(packetPath(cwd));
	if (text === null) {
		console.error(`packets budget: no packet file at ${packetPath(cwd)}`);
		return 1;
	}
	const parsed = parsePacketFile(text);
	if (!parsed.ok) {
		console.error(`packets budget: ${parsed.error}`);
		return 1;
	}
	// A release only saves context while its packet is live: ask the same fallback oracle the SessionStart uses
	// (default runner) which released packets would have their words handed back right now.
	const notLive = new Set(startFallbackEntries(cwd, loadRules(cwd), opts.runner ?? "claude-code").map((e) => e.id));
	const rows = packetBudget(parsed.value, readPass1Rules(cwd), (file) => readOrNull(sourcePath(cwd, file)), { notLive });
	console.log(opts.json ? JSON.stringify(rows, null, 2) : renderBudget(rows));
	return 0;
}

/** Which file lands first is decided by one rule: the write that ADDS a copy of the words goes first, the write
 *  that REMOVES a copy goes second, so a process killed between the renames always leaves the words in at least
 *  one of the two files, with the set stale so the fallback delivers them (R37, and the restore case of the
 *  seventh review). Release adds them to `release.text` (packet file first); restore adds them back to the
 *  instruction file (source first). Either interrupted state is recognised by `restoreEdit` and converges. */
function commitEdit(cwd: string, sourceFile: string, file: PacketFile, source: string, adds: "packet" | "source"): void {
	const packetWrite = { path: packetPath(cwd), text: `${JSON.stringify(file, null, 2)}\n` };
	const sourceWrite = { path: sourcePath(cwd, sourceFile), text: source };
	if (adds === "packet") writePairAtomic(packetWrite, sourceWrite);
	else writePairAtomic(sourceWrite, packetWrite);
}

/** Every release/restore starts by sweeping the dead temps a killed run left beside the two files it writes,
 *  whatever this run then decides (audit A: an early exit used to leave them in the repo root). A global (`~/`)
 *  source is never touched from a repo — not even swept (break R2). */
function sweepTargets(cwd: string, sourceFile: string): void {
	sweepStaleTemps(packetPath(cwd));
	sweepStaleTemps(`${packetPath(cwd)}.lock`); // a linkLock killed before its unlink leaves `<lock>.<pid>.<hex>.locktmp`
	if (!isGlobalSource(sourceFile)) sweepStaleTemps(sourcePath(cwd, sourceFile));
}

/** Run one release/restore under the project's packet lock, with a clean error instead of a stack trace when a
 *  file cannot be written (break R2: a read-only directory used to throw out of the command). */
function underLock(cwd: string, verb: "release" | "restore", run: () => number): number {
	const lock = acquirePacketLock(packetPath(cwd));
	if (!lock.ok) {
		console.error(`packets ${verb}: ${lockRefusal(lock)}`);
		return 1;
	}
	try {
		return run();
	} catch (err) {
		const e = err as NodeJS.ErrnoException;
		console.error(`packets ${verb}: could not write ${e.path ?? "a file"} (${e.code ?? e.message}); nothing was changed beyond what a retry or \`interlinked packets restore\` converges`);
		return 1;
	} finally {
		lock.release();
	}
}

/** When a stale set already holds a release of `file`, the usual cause is an interrupted release or restore (or a
 *  hand edit of the released file): the recovery is `restore`, not `compile`. Empty otherwise. */
function interruptedHint(cwd: string, file: string): string {
	const parsed = parsePacketFile(readOrNull(packetPath(cwd)) ?? "");
	if (!parsed.ok || !parsed.value.packets.some((p) => p.source.file === file && p.release !== null)) return "";
	return `; ${file} has released text, so a release or restore of it was interrupted or the file was edited: run \`interlinked packets restore ${file}\` first`;
}

/** Exit codes: 0 released (or dry), 1 packet set missing/invalid/stale or source unreadable, 2 nothing to release. */
export function packetsReleaseCommand(opts: PacketsReleaseOpts): number {
	const cwd = opts.cwd ?? process.cwd();
	if (!isGlobalSource(opts.file) && escapesRoot(cwd, opts.file)) {
		console.error(`packets release: ${opts.file} resolves outside the repo through a symlink; a release and its fallback live in one repo, so it is never released`);
		return 1;
	}
	if (opts.dry) return releaseRun(cwd, opts);
	return underLock(cwd, "release", () => {
		sweepTargets(cwd, opts.file);
		return releaseRun(cwd, opts);
	});
}

function releaseRun(cwd: string, opts: PacketsReleaseOpts): number {
	if (!existsSync(packetPath(cwd))) {
		console.error(`packets release: no packet file at ${packetPath(cwd)}`);
		return 1;
	}
	// Decoding replaces invalid bytes, so a release would rewrite them and restore could never give them back.
	const raw = readBytesOrNull(sourcePath(cwd, opts.file));
	if (raw !== null && !isUtf8(raw)) {
		console.error(`packets release: ${opts.file} is not valid UTF-8; nothing was released`);
		return 1;
	}
	// The hash check matters here: a release must never leave a rule with neither guidance nor enforcement,
	// and a stale set is not enforcing anything.
	const loaded = loadPacketFile(cwd, packetPath(cwd));
	if (!loaded.ok) {
		console.error(`packets release: ${loaded.error}${interruptedHint(cwd, opts.file)}`);
		return 1;
	}
	if (raw === null) {
		console.error(`packets release: cannot read ${opts.file}`);
		return 1;
	}
	const source = raw.toString("utf8");
	const edit = releaseEdit(loaded.file, opts.file, source, new Date().toISOString(), opts.only);
	if (!edit.ok) {
		console.error(`packets release: ${edit.error}`);
		return 2;
	}
	const charsRemoved = source.length - edit.source.length;
	if (!opts.dry) commitEdit(cwd, opts.file, edit.file, edit.source, "packet");
	if (opts.json) console.log(JSON.stringify({ file: opts.file, released: edit.released, chars_removed: charsRemoved }));
	else console.log(`${opts.dry ? "would release" : "released"} ${edit.released.join(", ")} from ${opts.file}: ${charsRemoved} chars (≈ ${Math.round(charsRemoved / 4)} tokens) leave the context; the text is kept verbatim in the packet file and delivered whenever a packet is not live`);
	return 0;
}

/** Exit codes: 0 restored, 1 packet file missing/invalid or source unreadable, 2 nothing released in that file. */
export function packetsRestoreCommand(opts: PacketsRestoreOpts): number {
	const cwd = opts.cwd ?? process.cwd();
	// A global (`~/`) instruction file is loaded by every project; a repo command never writes it (break R2).
	if (isGlobalSource(opts.file)) {
		console.error(`packets restore: ${opts.file} is a global instruction file; it is never released or restored from a repo`);
		return 2;
	}
	if (escapesRoot(cwd, opts.file)) {
		console.error(`packets restore: ${opts.file} resolves outside the repo through a symlink; a repo command never writes it`);
		return 2;
	}
	return underLock(cwd, "restore", () => {
		sweepTargets(cwd, opts.file);
		return restoreRun(cwd, opts);
	});
}

function restoreRun(cwd: string, opts: PacketsRestoreOpts): number {
	const text = readOrNull(packetPath(cwd));
	if (text === null) {
		console.error(`packets restore: no packet file at ${packetPath(cwd)}`);
		return 1;
	}
	const parsed = parsePacketFile(text);
	if (!parsed.ok) {
		console.error(`packets restore: ${parsed.error}`);
		return 1;
	}
	const raw = readBytesOrNull(sourcePath(cwd, opts.file));
	if (raw === null) {
		console.error(`packets restore: cannot read ${opts.file}`);
		return 1;
	}
	// Same reason as release: decoding replaces invalid bytes, so writing the decoded text back would lose them.
	if (!isUtf8(raw)) {
		console.error(`packets restore: ${opts.file} is not valid UTF-8; nothing was restored`);
		return 1;
	}
	const edit = restoreEdit(parsed.value, opts.file, raw.toString("utf8"));
	if (!edit.ok) {
		console.error(`packets restore: ${edit.error}`);
		return 2;
	}
	commitEdit(cwd, opts.file, edit.file, edit.source, "source");
	if (opts.json) console.log(JSON.stringify({ file: opts.file, restored: edit.restored }));
	else console.log(`restored ${edit.restored.join(", ")} into ${opts.file}; the file holds the original text again`);
	return 0;
}
