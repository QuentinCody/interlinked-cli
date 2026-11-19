// File transactions for `packets release|restore` (break R2): an exclusive lock around the read-modify-write,
// writes through a symlink to its target, the file mode kept, every temp removed on failure, and a sweep that
// never trips over a directory named like a temp.
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, chmodSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquirePacketLock, lockRefusal, sweepStaleTemps, takeOverStaleLock, takeoverGuardPath, writeAtomic, writePairAtomic } from "./packets-release-io.js";

let tmp: string;
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "packets-release-io-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));
const temps = () => readdirSync(tmp).filter((n) => n.endsWith(".tmp"));

describe("acquirePacketLock — one release/restore at a time per project (break R2, P1)", () => {
	it("P1: a second acquire while the first is held is refused and names the holder; after release it succeeds", () => {
		const target = join(tmp, "instruction-packets.json");
		const first = acquirePacketLock(target);
		expect(first.ok).toBe(true);
		const second = acquirePacketLock(target);
		expect(second).toEqual({ ok: false, holder: process.pid, path: `${target}.lock` });
		if (first.ok) first.release();
		const third = acquirePacketLock(target);
		expect(third.ok).toBe(true);
		if (third.ok) third.release();
		expect(readdirSync(tmp)).toEqual([]);
	});
	it("P2: a lock left by a dead process is taken over", () => {
		const target = join(tmp, "instruction-packets.json");
		writeFileSync(`${target}.lock`, "999999999");
		const lock = acquirePacketLock(target);
		expect(lock.ok).toBe(true);
		if (lock.ok) lock.release();
	});
	it("P7 (break R4 #14, P1): a slow taker whose read of the dead holder is stale removes NOTHING once another run holds the lock", () => {
		const target = join(tmp, "instruction-packets.json");
		writeFileSync(`${target}.lock`, String(process.pid)); // a live run took the lock over meanwhile
		expect(takeOverStaleLock(`${target}.lock`, "999999999")).toBe("retry");
		expect(readFileSync(`${target}.lock`, "utf8")).toBe(String(process.pid));
		expect(readdirSync(tmp)).toEqual(["instruction-packets.json.lock"]);
	});
	it("P8: a guard another taker holds makes this run refuse and name the guard (never two takers)", () => {
		const target = join(tmp, "instruction-packets.json");
		writeFileSync(`${target}.lock`, "999999999");
		const first = takeOverStaleLock(`${target}.lock`, "999999999", () => {
			// While the first taker holds the guard, a second one cannot take over the same dead lock.
			expect(takeOverStaleLock(`${target}.lock`, "999999999")).toBe("busy");
		});
		expect(first).toBe("retry");
		const lock = acquirePacketLock(target);
		expect(lock.ok).toBe(true);
		if (lock.ok) lock.release();
		expect(readdirSync(tmp)).toEqual([]);
	});
	it("P9: a guard left by a killed taker is reported with its path; nothing is removed", () => {
		const target = join(tmp, "instruction-packets.json");
		writeFileSync(`${target}.lock`, "999999999");
		const stuck = takeoverGuardPath(`${target}.lock`, "999999999");
		writeFileSync(stuck, "999999998");
		const lock = acquirePacketLock(target);
		expect(lock).toEqual({ ok: false, holder: null, path: stuck });
		expect(readFileSync(`${target}.lock`, "utf8")).toBe("999999999");
	});
	it("N5: an EMPTY guard (created, pid not yet written) is a live taker, not a killed one — until it is old", () => {
		const target = join(tmp, "instruction-packets.json");
		const guard = takeoverGuardPath(`${target}.lock`, "999999999");
		writeFileSync(guard, "");
		expect(takeOverStaleLock(`${target}.lock`, "999999999")).toBe("busy");
		utimesSync(guard, new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z"));
		expect(takeOverStaleLock(`${target}.lock`, "999999999")).toBe("stuck");
	});
	it("R6-W1 P2: a lock is never visible without its pid, and a YOUNG empty lock (a racer mid-create) is busy, never taken over", () => {
		const target = join(tmp, "instruction-packets.json");
		const lock = acquirePacketLock(target);
		expect(lock.ok).toBe(true);
		expect(readFileSync(`${target}.lock`, "utf8")).toBe(String(process.pid));
		expect(readdirSync(tmp).sort()).toEqual(["instruction-packets.json.lock"]);
		if (lock.ok) lock.release();
		writeFileSync(`${target}.lock`, "");
		const racer = acquirePacketLock(target);
		expect(racer.ok).toBe(false);
		expect(readFileSync(`${target}.lock`, "utf8")).toBe("");
		utimesSync(`${target}.lock`, new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z"));
		expect(acquirePacketLock(target).ok).toBe(true);
	});
	it("R6-W1 P3: a busy refusal names the takeover guard that blocks it", () => {
		const target = join(tmp, "instruction-packets.json");
		writeFileSync(`${target}.lock`, "999999999");
		const guard = takeoverGuardPath(`${target}.lock`, "999999999");
		writeFileSync(guard, String(process.pid));
		expect(acquirePacketLock(target)).toEqual({ ok: false, holder: null, path: `${target}.lock`, guard });
	});
	it("P-refusal: each refusal names the file to wait on or delete, for every packet-file writer", () => {
		expect(lockRefusal({ holder: 42, path: "x.lock" })).toBe("another packet-file write (release, restore, compile or calibrate --apply) is running in this project (pid 42, lock x.lock); run it again when that one ends");
		expect(lockRefusal({ holder: null, path: "x.lock", guard: "x.lock.takeover-ab" })).toContain("takeover guard x.lock.takeover-ab");
		expect(lockRefusal({ holder: null, path: "x.lock" })).toBe("another run is taking over a stale lock (x.lock); run it again; if no packet command is running, delete it");
		expect(lockRefusal({ holder: null, path: "x.lock.takeover-ab" })).toBe("a killed run left the takeover guard x.lock.takeover-ab; if no packet command is running, delete it and run again");
	});
	it("N1: releasing never removes a lock another process took over meanwhile", () => {
		const target = join(tmp, "instruction-packets.json");
		const lock = acquirePacketLock(target);
		writeFileSync(`${target}.lock`, "12345");
		if (lock.ok) lock.release();
		expect(readFileSync(`${target}.lock`, "utf8")).toBe("12345");
	});
});

describe("writeAtomic / writePairAtomic", () => {
	it("P3 (break R2, P2): a symlinked instruction file is written THROUGH the link — the link survives, the target changes", () => {
		writeFileSync(join(tmp, "AGENTS.md"), "old");
		symlinkSync("AGENTS.md", join(tmp, "CLAUDE.md"));
		writeAtomic(join(tmp, "CLAUDE.md"), "new");
		expect(lstatSync(join(tmp, "CLAUDE.md")).isSymbolicLink()).toBe(true);
		expect(readFileSync(join(tmp, "AGENTS.md"), "utf8")).toBe("new");
		expect(temps()).toEqual([]);
	});
	it("P4 (break R2, P2): the file mode is kept (0600 stays 0600)", () => {
		writeFileSync(join(tmp, "CLAUDE.md"), "old");
		chmodSync(join(tmp, "CLAUDE.md"), 0o600);
		writeAtomic(join(tmp, "CLAUDE.md"), "new");
		expect(statSync(join(tmp, "CLAUDE.md")).mode & 0o777).toBe(0o600);
	});
	it("P5 (break R2, P3): when the second write fails, the first file is rolled back and NO temp is left behind", () => {
		writeFileSync(join(tmp, "a.json"), "a-old");
		mkdirSync(join(tmp, "ro"));
		writeFileSync(join(tmp, "ro", "b.md"), "b-old");
		chmodSync(join(tmp, "ro"), 0o500);
		try {
			expect(() => writePairAtomic({ path: join(tmp, "a.json"), text: "a-new" }, { path: join(tmp, "ro", "b.md"), text: "b-new" })).toThrow();
		} finally {
			chmodSync(join(tmp, "ro"), 0o700);
		}
		expect(readFileSync(join(tmp, "a.json"), "utf8")).toBe("a-old");
		expect(readFileSync(join(tmp, "ro", "b.md"), "utf8")).toBe("b-old");
		expect(temps()).toEqual([]);
		expect(readdirSync(join(tmp, "ro")).filter((n) => n.endsWith(".tmp"))).toEqual([]);
	});
	it("N2: both files land when nothing fails", () => {
		writeFileSync(join(tmp, "a.json"), "a-old");
		writeFileSync(join(tmp, "b.md"), "b-old");
		writePairAtomic({ path: join(tmp, "a.json"), text: "a-new" }, { path: join(tmp, "b.md"), text: "b-new" });
		expect([readFileSync(join(tmp, "a.json"), "utf8"), readFileSync(join(tmp, "b.md"), "utf8")]).toEqual(["a-new", "b-new"]);
	});
});

describe("sweepStaleTemps", () => {
	it("P3: a killed linkLock's `<lock>.<pid>.<hex>.locktmp` is removed for a dead pid and kept for a live one", () => {
		const lock = join(tmp, "packets.lock");
		writeFileSync(`${lock}.999999999.a1b2c3d4e5f6.locktmp`, "999999999\n");
		writeFileSync(`${lock}.${process.pid}.0123456789ab.locktmp`, "x");
		expect(sweepStaleTemps(lock)).toEqual(["packets.lock.999999999.a1b2c3d4e5f6.locktmp"]);
		expect(readdirSync(tmp).sort()).toEqual([`packets.lock.${process.pid}.0123456789ab.locktmp`]);
	});
	it("N3: a temp named for a LIVE process (this one) is another run in flight and is left alone; a non-numeric suffix is not ours", () => {
		const target = join(tmp, "CLAUDE.md");
		writeFileSync(`${target}.${process.pid}.tmp`, "x");
		writeFileSync(`${target}.backup.tmp`, "x");
		expect(sweepStaleTemps(target)).toEqual([]);
	});
	it("P6: a dead pid's temp is removed; a missing directory sweeps nothing", () => {
		const target = join(tmp, "CLAUDE.md");
		writeFileSync(`${target}.999999999.tmp`, "x");
		expect(sweepStaleTemps(target)).toEqual(["CLAUDE.md.999999999.tmp"]);
		expect(sweepStaleTemps(join(tmp, "no-such-dir", "x.md"))).toEqual([]);
	});
	it("P10 (break R4 #19): a dead temp beside a symlinked file's TARGET is swept too", () => {
		mkdirSync(join(tmp, "real"));
		writeFileSync(join(tmp, "real", "rules.md"), "x");
		symlinkSync(join(tmp, "real", "rules.md"), join(tmp, "CLAUDE.md"));
		writeFileSync(join(tmp, "real", "rules.md.999999999.tmp"), "half");
		expect(sweepStaleTemps(join(tmp, "CLAUDE.md"))).toEqual(["rules.md.999999999.tmp"]);
	});
	it("P11 (break R4 #20): a symlink planted at this run's own temp name is replaced, never written through", () => {
		const outside = join(tmp, "outside.txt");
		writeFileSync(outside, "keep");
		writeFileSync(join(tmp, "CLAUDE.md"), "old");
		symlinkSync(outside, join(tmp, `CLAUDE.md.${process.pid}.tmp`));
		writeAtomic(join(tmp, "CLAUDE.md"), "new");
		expect(readFileSync(outside, "utf8")).toBe("keep");
		expect(readFileSync(join(tmp, "CLAUDE.md"), "utf8")).toBe("new");
		expect(lstatSync(join(tmp, "CLAUDE.md")).isSymbolicLink()).toBe(false);
	});
	it("N4 (break R2, P3): a DIRECTORY named like a dead temp is not ours and never makes the sweep throw", () => {
		const target = join(tmp, "CLAUDE.md");
		mkdirSync(`${target}.999999999.tmp`);
		expect(() => sweepStaleTemps(target)).not.toThrow();
		expect(lstatSync(`${target}.999999999.tmp`).isDirectory()).toBe(true);
	});
});
