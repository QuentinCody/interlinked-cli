/** Buffer child output: a failed/terminated child must never leave an allow
 * response in stdout. The 12s watchdog precedes Cowork's 15s native timeout.
 * If the provider kills this wrapper too, enforcement remains unavailable. */
export const COWORK_LAUNCHER = `#!/bin/sh
event="$1"
deny() {
    if [ "$event" = "PreToolUse" ]; then
        printf '%s\\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Interlinked Cowork NOT CHECKED: hook runtime unavailable or exceeded its deadline."}}'
    else
        printf '%s\\n' '[interlinked:cowork] NOT CHECKED: hook runtime unavailable or exceeded its deadline.' >&2
    fi
}
command -v node >/dev/null 2>&1 || { deny; exit 0; }
root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)" || { deny; exit 0; }
output="$(mktemp)" || { deny; exit 0; }
trap 'rm -f -- "$output"' EXIT
exec 3<&0
node "$root/scripts/cowork-hook.js" --event "$event" <&3 >"$output" 2>/dev/null &
child=$!
( sleep 12; kill -TERM "$child" 2>/dev/null ) </dev/null >/dev/null 2>&1 &
watchdog=$!
wait "$child"
status=$?
kill "$watchdog" 2>/dev/null
wait "$watchdog" 2>/dev/null
if [ "$status" -eq 0 ]; then cat -- "$output"; else deny; fi
`;
