// ===========================================
// File transactions for `interlinked packets release|restore` (design §9; seventh review, break R2)
// ===========================================
// A release or restore rewrites two files that together hold one instruction's words: the instruction file and
// `.interlinked/instruction-packets.json`. This module owns how they are written:
//   - one run at a time per project (`acquirePacketLock`): two overlapping runs each read the packet file, then
//     the later write dropped the earlier run's release — words in neither file (R2, P1);
//   - writes go THROUGH a symlink to its target and keep the target's mode (R2, P2);
//   - every write is temp + rename; a failed pair rolls the first file back (also temp + rename) and removes
//     every temp it made (R2, P3); a killed run's temps are swept by the next run, never a directory (R2, P3).
// The caller (packets-release.ts) decides the ORDER of the pair; this module only makes each step atomic.

import { safeReadFile as readOrNull } from "../harness/evaluator/safe-read-file.js";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, linkSync, lstatSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export type Write = { path: string; text: string };

/** `<path>.<pid>.tmp` (writeAtomic) or `<lock>.<pid>.<hex>.locktmp` (a linkLock killed before its unlink). */
const TEMP_SUFFIX = /^\.(\d+)(?:\.tmp|\.[0-9a-f]+\.locktmp)$/;

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Remove `<path>.<pid>.tmp` FILES left by a run that was killed before its renames. A temp of a LIVE process is
 *  another run in flight and is left alone; a directory with such a name is not ours. A temp that vanished
 *  meanwhile is fine; any other unlink failure aborts the command before it writes anything. */
export function sweepStaleTemps(path: string): string[] {
	// Temps are written beside the TARGET of a symlinked file, so that is swept too (break R4 #19).
	const target = resolveTarget(path);
	return target === path ? sweepBeside(path) : [...sweepBeside(path), ...sweepBeside(target)];
}

function sweepBeside(path: string): string[] {
	const dir = dirname(path);
	const base = basename(path);
	const removed: string[] = [];
	if (!existsSync(dir)) return removed;
	for (const name of readdirSync(dir)) {
		if (!name.startsWith(base)) continue;
		const m = TEMP_SUFFIX.exec(name.slice(base.length));
		if (!m || processAlive(Number(m[1]))) continue;
		const full = join(dir, name);
		const kind = lstatSync(full, { throwIfNoEntry: false });
		if (!kind || !(kind.isFile() || kind.isSymbolicLink())) continue;
		rmSync(full, { force: true });
		removed.push(name);
	}
	return removed;
}

/** Refused: `holder` is the live run holding the lock, or null when no live holder is known — `path` is then the
 *  lock (another run is taking it over) or a takeover guard a killed run left (delete it by hand). */
export type PacketLock = { ok: true; release: () => void } | { ok: false; holder: number | null; path: string; guard?: string };

function livePid(text: string | null): number | null {
	const pid = Number(text?.trim());
	return Number.isInteger(pid) && pid > 0 && processAlive(pid) ? pid : null;
}

/** An empty guard is one a taker has created (O_EXCL) and not yet written its pid into; only an old one is stuck. */
function justCreated(guard: string, content: string): boolean {
	if (content.trim() !== "") return false;
	const st = statSync(guard, { throwIfNoEntry: false });
	return st !== undefined && Date.now() - st.mtimeMs < GUARD_STUCK_MS;
}
const GUARD_STUCK_MS = 5_000;

/** The guard a taker holds while it removes the dead lock it SAW (one guard per seen content). */
export function takeoverGuardPath(lockPath: string, seen: string): string {
	return `${lockPath}.takeover-${createHash("sha256").update(seen).digest("hex").slice(0, 16)}`;
}

/** Remove a dead holder's lock exclusively (break R4 #14, P1: a read-then-rm let a slow taker delete the lock a
 *  faster taker had just created, so two runs held it). Under an O_EXCL guard named for the content it saw, the
 *  taker removes the lock only if it STILL holds that content; only the guard holder can change it from there.
 *  `retry`: try the lock again. `busy`: a live taker holds the guard. `stuck`: a killed taker left the guard. */
export function takeOverStaleLock(lockPath: string, seen: string, during?: () => void): "retry" | "busy" | "stuck" {
	const guard = takeoverGuardPath(lockPath, seen);
	try {
		writeFileSync(guard, String(process.pid), { flag: "wx" });
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		const taker = readOrNull(guard);
		if (taker === null) return "retry";
		return livePid(taker) !== null || justCreated(guard, taker) ? "busy" : "stuck";
	}
	try {
		during?.();
		if (readOrNull(lockPath) === seen) rmSync(lockPath, { force: true });
		return "retry";
	} finally {
		rmSync(guard, { force: true });
	}
}

/** Publish the lock with its pid already inside (R6 P2: an O_EXCL create left it empty until the write, and a
 *  racer that read "" took over a LIVE holder). The pid goes to a private temp; `link` fails EEXIST atomically. */
function linkLock(path: string): boolean {
	const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.locktmp`;
	writeFileSync(tmp, String(process.pid), { flag: "wx" });
	try {
		linkSync(tmp, path);
		return true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		return false;
	} finally {
		rmSync(tmp, { force: true });
	}
}

/** Take `<target>.lock` exclusively (atomic link), holding this pid. A lock whose holder is dead is taken over through
 *  `takeOverStaleLock`; a live holder (this process included) refuses. Release removes the lock only while it still
 *  names this pid. */
export function acquirePacketLock(target: string): PacketLock {
	const path = `${target}.lock`;
	for (let attempt = 0; attempt < 3; attempt++) {
		if (linkLock(path)) return { ok: true, release: () => (readOrNull(path)?.trim() === String(process.pid) ? rmSync(path, { force: true }) : undefined) };
		const seen = readOrNull(path);
		if (seen === null) continue; // released meanwhile
		const holder = livePid(seen);
		if (holder !== null) return { ok: false, holder, path };
		// An empty lock is never ours (linkLock publishes it whole); a young one is a racer mid-create (R6 P2).
		if (justCreated(path, seen)) return { ok: false, holder: null, path };
		const taken = takeOverStaleLock(path, seen);
		if (taken === "busy") return { ok: false, holder: null, path, guard: takeoverGuardPath(path, seen) };
		if (taken === "stuck") return { ok: false, holder: null, path: takeoverGuardPath(path, seen) };
	}
	return { ok: false, holder: null, path };
}

/** Why the lock was refused, naming the file to delete when a killed run left one (break R4: "pid -1"). Every
 *  command that rewrites the packet file takes this lock: release, restore, compile, calibrate score --apply. */
export function lockRefusal(lock: { holder: number | null; path: string; guard?: string }): string {
	if (lock.holder !== null) return `another packet-file write (release, restore, compile or calibrate --apply) is running in this project (pid ${lock.holder}, lock ${lock.path}); run it again when that one ends`;
	if (lock.guard !== undefined) return `another run is taking over a stale lock (${lock.path}, takeover guard ${lock.guard}); run it again; if no packet command is running, delete the guard`;
	if (lock.path.endsWith(".lock")) return `another run is taking over a stale lock (${lock.path}); run it again; if no packet command is running, delete it`;
	return `a killed run left the takeover guard ${lock.path}; if no packet command is running, delete it and run again`;
}

/** The file a write to `path` must replace: the link's target when `path` is a symlink (the link survives). */
function resolveTarget(path: string): string {
	const st = lstatSync(path, { throwIfNoEntry: false });
	return st?.isSymbolicLink() ? realpathSync(path) : path;
}

function tempFor(target: string): string {
	return `${target}.${process.pid}.tmp`;
}

/** Write the temp for `target`, with the target's current permission bits when it exists. */
function writeTemp(tmp: string, text: string, target: string): void {
	// O_EXCL after removing our own leftover: a link planted at the temp name is unlinked, never written through
	// (break R4 #20); a link planted again in between makes the write fail, never land outside.
	rmSync(tmp, { force: true });
	writeFileSync(tmp, text, { flag: "wx" });
	if (existsSync(target)) chmodSync(tmp, statSync(target).mode & 0o7777);
}

/** Replace one file atomically (through a symlink, mode kept): temp beside the target, then rename over it. */
export function writeAtomic(path: string, text: string): void {
	const target = resolveTarget(path);
	const tmp = tempFor(target);
	try {
		writeTemp(tmp, text, target);
		renameSync(tmp, target);
	} catch (err) {
		rmSync(tmp, { force: true });
		throw err;
	}
}

/** Write two files as one transaction: both temps first, then `first` is renamed, then `second`. When the second
 *  rename throws, the first is rolled back atomically. Any failure removes every temp this call made. A KILL
 *  between the renames cannot roll back, so the caller orders the pair so the state after `first` alone is safe. */
export function writePairAtomic(first: Write, second: Write): void {
	const a = resolveTarget(first.path);
	const b = resolveTarget(second.path);
	const before = readOrNull(a);
	const tmpA = tempFor(a);
	const tmpB = tempFor(b);
	try {
		writeTemp(tmpA, first.text, a);
		writeTemp(tmpB, second.text, b);
		renameSync(tmpA, a);
		try {
			renameSync(tmpB, b);
		} catch (err) {
			if (before !== null) writeAtomic(a, before);
			throw err;
		}
	} finally {
		rmSync(tmpA, { force: true });
		rmSync(tmpB, { force: true });
	}
}
