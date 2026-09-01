// Regression test for the framed-PID-clobber bug flagged in the Plan 08
// review.
//
// Background: in dual-mode startup, `writePidFile()` in server.ts used to
// write BOTH the legacy `harness.pid` and the framed
// `harness-<session>.pid`. The framed write happened BEFORE
// `startSessionDaemon()` ran its ownership check at session-daemon.ts:60-66,
// so the check saw `existingPid === process.pid` and silently passed —
// leading the daemon to remove and rebind a live socket that another
// daemon process actually owned.
//
// Fix: writePidFile now owns the LEGACY file only. The framed file's
// lifecycle is owned exclusively by `startSessionDaemon()` (write at
// session-daemon.ts:136 after the ownership claim, removal at :167-169).
// This test enforces that ownership boundary at the source level.
//
// NOTE: `writePidFile` / `removePidFile` were extracted from `server.ts` into
// the `createSocketLifecycle` factory in `server-socket-lifecycle.ts` during the
// per-file line-cap decomposition — this test reads them from their new home.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SOCKET_LIFECYCLE_TS = readFileSync(
	join(process.cwd(), "src", "harness", "server-socket-lifecycle.ts"),
	"utf-8",
);
const SESSION_DAEMON_TS = readFileSync(
	join(process.cwd(), "src", "harness", "session-daemon.ts"),
	"utf-8",
);

describe("framed-PID file ownership (Plan 08 review fix)", () => {
	it("writePidFile (server-socket-lifecycle.ts) does NOT write FRAMED_PATHS.pid", () => {
		// Find the writePidFile function body and confirm the framed write
		// is gone. Limit the scan to the function body so unrelated
		// occurrences elsewhere don't false-pass us. The closing-brace match is
		// indentation-tolerant (the fn is nested in the createSocketLifecycle closure).
		const startIdx = SOCKET_LIFECYCLE_TS.indexOf("function writePidFile(): void {");
		expect(startIdx).toBeGreaterThan(0);
		const rest = SOCKET_LIFECYCLE_TS.slice(startIdx);
		const endRel = rest.search(/\n\t*\}\n/);
		expect(endRel).toBeGreaterThan(0);

		const body = rest.slice(0, endRel);
		// The legacy write must still happen.
		expect(body).toContain("writeFileSync(PID_PATH, String(process.pid))");
		// The framed write must be gone.
		expect(body).not.toContain("FRAMED_PATHS.pid");
		expect(body).not.toContain("writeFileSync(FRAMED_PATHS");
	});

	it("server-socket-lifecycle.ts pid removal is ownership-checked and never touches FRAMED_PATHS.pid", () => {
		// The dedicated `removePidFile()` wrapper was dead (never called) and was
		// deleted in the 2026-09-01 unused-locals sweep; the invariant it pinned
		// lives on at the call-site level: every removal in this module goes
		// through the ownership-checked helper, and the framed pid file is never
		// removed here — it's owned by session-daemon.handle.stop().
		const removeCalls = SOCKET_LIFECYCLE_TS.match(/removePidFileIfOwned\([^)]*\)/g) ?? [];
		expect(removeCalls.length).toBeGreaterThan(0);
		for (const call of removeCalls) {
			expect(call).toContain("process.pid");
			expect(call).not.toContain("FRAMED_PATHS");
		}
		expect(SOCKET_LIFECYCLE_TS).not.toContain("unlinkSync(FRAMED_PATHS.pid");
	});

	it("session-daemon.ts is the sole writer of paths.pid (the framed file), via an atomic claim", () => {
		// The ownership check-then-write was extracted into the exported
		// `claimSessionPid` helper (fix for a same-tick TOCTOU: two starts
		// close enough together could both pass a plain "does a live pid
		// already own this" read before either had written, both proceed to
		// bind, one silently stomping the other's socket — confirmed
		// empirically, see session-daemon.test.ts). The write is now an
		// fenced companion lock plus an exclusive temp file and atomic rename.
		// A displaced claimant checks its lock token before and after rename and
		// cannot report a second win.
		expect(SESSION_DAEMON_TS).toContain("export function claimSessionPid(");
		expect(SESSION_DAEMON_TS).toContain('writeFileSync(lock.path, lock.raw, { flag: "wx" })');
		expect(SESSION_DAEMON_TS).toContain('writeFileSync(nextPath, String(pid), { flag: "wx" })');
		expect(SESSION_DAEMON_TS).toContain("if (!claimLockIsCurrent(lock)) return false");
		expect(SESSION_DAEMON_TS).toContain("renameSync(nextPath, pidPath)");

		// Sanity: the ownership check (process-alive guard) must come before
		// that write, otherwise we'd still have the same race.
		const checkIdx = SESSION_DAEMON_TS.indexOf("isProcessAlive(ownerPid)");
		const writeIdx = SESSION_DAEMON_TS.indexOf("return replacePidClaim(lock, pidPath, pid)");
		expect(checkIdx).toBeGreaterThan(0);
		expect(writeIdx).toBeGreaterThan(checkIdx);

		// `startSessionDaemon` must call the claim BEFORE it ever touches the
		// socket — that ordering (not the bind) is what makes two racing
		// starts resolve to exactly one winner.
		const ownershipCallIdx = SESSION_DAEMON_TS.indexOf(
			"await claimSessionOwnership({ paths, sessionId: session_id",
		);
		const fencedClaimIdx = SESSION_DAEMON_TS.indexOf(
			"const claim = claimSessionPid(args.paths.pid, process.pid",
		);
		// The bind moved into the extracted `bindSessionSocket` helper during the
		// c0828a4 decomposition; the ordering guarantee is now claim-call before
		// the helper's call site (the helper itself sits above both in the file,
		// which is why the probe anchors on the CALL, not the definition).
		const listenIdx = SESSION_DAEMON_TS.indexOf(
			"await bindSessionSocket({ socketPath: paths.socket",
		);
		expect(fencedClaimIdx).toBeGreaterThan(0);
		expect(ownershipCallIdx).toBeGreaterThan(fencedClaimIdx);
		expect(listenIdx).toBeGreaterThan(ownershipCallIdx);
	});

	it("session-daemon.handle.stop removes paths.pid", () => {
		// The fix only works if session-daemon also owns the *cleanup* —
		// otherwise a dead daemon's PID file lingers and the next start
		// trips the alive-pid guard.
		const stopIdx = SESSION_DAEMON_TS.indexOf("async stop(");
		expect(stopIdx).toBeGreaterThan(0);
		const stopSlice = SESSION_DAEMON_TS.slice(stopIdx, stopIdx + 800);
		expect(stopSlice).toContain("removeOwnedSessionArtifacts(paths, process.pid)");
		const cleanupIdx = SESSION_DAEMON_TS.indexOf(
			"export function removeOwnedSessionArtifacts",
		);
		expect(cleanupIdx).toBeGreaterThan(0);
		const cleanupSlice = SESSION_DAEMON_TS.slice(cleanupIdx, cleanupIdx + 400);
		expect(cleanupSlice).toContain("pidFileNames(paths.pid, pid)");
		expect(cleanupSlice).toContain("removePidFileIfOwned(paths.pid, pid)");
	});
});
