// ===========================================
// Statusline daemon-down branch — grace, auto-revive, alarm
// ===========================================
// The generated statusline is an idle-time liveness display: the
// runner re-executes it every few seconds (refreshInterval) even when no
// tools run. Before 2026-07-28 the down-branch only ALARMED — a daemon killed
// during idle (jetsam on a swap-pinned 16GB box; ledger shows row-less
// SIGKILLs at RSS as low as 450MB) stayed dead for HOURS, statusline red,
// until the next tool call's self-heal fired. Process management now belongs
// exclusively to the hook recovery state machine, which is cross-process
// single-flight and runs on ordinary events. This branch reports that state;
// it never claims every edit is blocked, because deterministic inline gates
// continue while ordinary work proceeds in degraded mode.
//
// Absolute node/server paths are BAKED at generation time (`interlinked
// enable` / regeneration) because the render-time environment has no reliable
// PATH. Pure string builders — the whole fragment is unit-testable without
// writing the script to disk.

import { getHarnessServerPath } from "../commands/harness-process.js";
import { DEFAULT_DAEMON_HEAP_MB } from "../harness/memory-ceiling.js";

interface ReviveBakes {
	/** Absolute node binary of the generating process. */
	nodeBin: string;
	/** Absolute path to dist/harness/server.js, or "" when unresolvable. */
	serverJs: string;
	/** V8 old-space MB — the same regulator every spawn path applies. */
	heapMb: number;
}

/** Resolve the paths to bake. Never throws: an unresolvable install layout
 *  yields an empty server path and the bash spawn guard no-ops on it. */
export function resolveReviveBakes(): ReviveBakes {
	let serverJs = "";
	try {
		serverJs = getHarnessServerPath();
	} catch (err) {
		// Generation must not fail over a probe error; revival simply no-ops.
		void err;
	}
	return { nodeBin: process.execPath, serverJs, heapMb: DEFAULT_DAEMON_HEAP_MB };
}

/**
 * The full `ALIVE=0` branch of the generated script, from grace debounce
 * through revival to render, plus the marker cleanup on the healthy path.
 * Escaping contract: this fragment is interpolated into the same template
 * string as the rest of the script, so `\${...}` survives as a shell
 * expansion and `\\n` as a printf newline — identical conventions.
 */
/**
 * PID discovery for the statusline: first LIVE pid across every
 * `harness*.pid` wins (raw + framed/session). Reading only `harness.pid`
 * painted "restarting" forever whenever a stale raw file named a corpse next
 * to a healthy framed daemon (the 2026-08-16 perpetual-restart illusion).
 * Falls back to the first pid file at all (even dead) so the down branch can
 * still show a pid. Same escaping contract as {@link downBranchBash}.
 */
export function pidDiscoveryBash(): string {
	return `for PF in "$IL"/harness.pid "$IL"/harness-*.pid; do
            [ -f "$PF" ] || continue
            CAND=$(cat "$PF" 2>/dev/null)
            case "$CAND" in ''|*[!0-9]*) continue;; esac
            [ -z "$PID" ] && PID="$CAND"
            if ps -p "$CAND" > /dev/null 2>&1; then PID="$CAND"; break; fi
        done`;
}

export function downBranchBash(_b: ReviveBakes): string {
	return `# Debounce transient restart windows. A self-healing respawn (or a SessionStart
# relaunch) leaves harness.pid pointing at a dead process for ~1-3s; without a
# grace period the statusline paints the full outage alarm on that blip even
# while the hook recovery state machine is still within its boot window.
DOWN_MARK="$ID/.statusline-down-since"
DOWN_GRACE_SECS=6
# No auto-revive here (2026-08-16): the hook supervisor (startup mutex +
# exponential backoff) is the ONE process manager. See downBranchBash's
# display-only comment for the incident this replaces.
REVIVE_MARK="$ID/.statusline-revive-at"
REVIVE_ALARM_SECS=45
if [ "$ALIVE" = "0" ]; then
    NOW=$(date +%s)
    SINCE="$NOW"
    if [ -f "$DOWN_MARK" ]; then
        SINCE=$(cat "$DOWN_MARK" 2>/dev/null || echo "$NOW")
    else
        echo "$NOW" > "$DOWN_MARK" 2>/dev/null
    fi
    case "$SINCE" in *[!0-9]*) SINCE="$NOW";; esac
    if [ "$((NOW - SINCE))" -lt "$DOWN_GRACE_SECS" ]; then
        LINE1="\${YELLOW}\${BOLD}◆ interlinked\${RESET}\${SEP}\${YELLOW}↻ harness restarting…\${RESET}"
        LINE2="\${DIM}recovery window — inline safety gates remain active\${RESET}"
        printf '%s\\n%s' "$LINE1" "$LINE2"
        exit 0
    fi
    # DISPLAY-ONLY past grace (2026-08-16): this statusline no longer spawns a
    # daemon. It used to be a second, unmutexed supervisor — every render on
    # every open session raced a raw \`node server.js\` against the hook
    # supervisor's mutexed self-heal, each loser overwrote harness.pid on its
    # way out, and the stale pid made the NEXT render spawn again: a perpetual
    # "restarting" illusion next to a healthy daemon. One daemon, ONE
    # supervisor — the hook's (startup mutex + exponential backoff). The
    # statusline's job is to tell the truth, not to manage processes.
    if [ "$((NOW - SINCE))" -lt "$REVIVE_ALARM_SECS" ]; then
        LINE1="\${YELLOW}\${BOLD}◆ interlinked\${RESET}\${SEP}\${YELLOW}↻ harness down — hook recovery active\${RESET}"
        LINE2="\${DIM}degraded mode: inline deterministic gates only; full evaluator unavailable\${RESET}"
        printf '%s\\n%s' "$LINE1" "$LINE2"
        exit 0
    fi
    BRAND="\${RED}\${BOLD}◆ interlinked\${RESET}"
    LINE1="\${BRAND}\${SEP}\${YELLOW}▼ harness offline — recovery not verified\${RESET}\${SEP}\${RED}full evaluator unavailable\${RESET}"
    LINE2="\${CYAN}↻ interlinked harness status\${RESET}\${SEP}\${DIM}inline safety gates remain active\${RESET}"
    printf '%s\\n%s' "$LINE1" "$LINE2"
    exit 0
fi
rm -f "$DOWN_MARK" "$REVIVE_MARK" 2>/dev/null`;
}
