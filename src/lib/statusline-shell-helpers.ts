// ===========================================
// Statusline shell helpers — the POSIX-sh preamble of the generated script
// ===========================================
// Extracted from `hook-installers-statusline.ts` when that file reached the
// 500-line cap. These are the small, self-contained shell functions the
// generated statusline calls; they have no dependency on any of the rendering
// decisions above or below them, which is what makes the seam a clean one.
//
// The strings are BASH SOURCE emitted into the generated script, not code that
// runs in this process. Backslashes are therefore doubled where the generated
// script needs a literal escape byte.

/**
 * `read_snap KEY [DEFAULT]` — pull one `key=value` line out of the snapshot.
 *
 * Returns DEFAULT when the key is absent, which is how every consumer degrades
 * gracefully against a daemon too old to write a newer key: the caller passes
 * `""` and omits its whole segment rather than rendering a confident zero.
 */
const READ_SNAP_FN = `# read_snap KEY [DEFAULT] — extract one key=value line from the snapshot.
read_snap() {
    local val
    val=$(grep -E "^$1=" "$SNAP" 2>/dev/null | head -1 | cut -d= -f2-)
    if [ -z "$val" ]; then
        printf '%s' "$2"
    else
        printf '%s' "$val"
    fi
}`;

/**
 * `osc8 URL TEXT` — wrap TEXT in an OSC 8 hyperlink using the BEL terminator.
 *
 * Emits real ESC + BEL bytes so callers can concatenate the result with colour
 * constants and print it with `printf '%s'`. Terminals without OSC 8 support
 * strip the escapes and render TEXT cleanly, so this is safe everywhere.
 */
const OSC8_FN = `# osc8 URL TEXT — wrap TEXT in an OSC 8 hyperlink using BEL terminator.
# Outputs real ESC + BEL bytes so callers can concatenate with color
# constants and emit via printf '%s'. Terminals that don't support OSC 8
# strip the escape sequences and render TEXT cleanly.
osc8() {
    printf '\\033]8;;%s\\007%s\\033]8;;\\007' "$1" "$2"
}`;

/**
 * `fmt_count N` — abbreviate thousands so a lifetime counter cannot widen the
 * row without bound. 999 stays 999; 1200 becomes `1k`.
 */
const FMT_COUNT_FN = `# fmt_count N — abbreviate thousands so a lifetime counter can't widen the row.
fmt_count() {
    if [ "$1" -ge 1000 ]; then printf '%sk' "$(($1 / 1000))"; else printf '%s' "$1"; fi
}`;

/** Every shell helper, in the order the generated script defines them. */
export const STATUSLINE_SHELL_HELPERS = [READ_SNAP_FN, OSC8_FN, FMT_COUNT_FN].join("\n\n");
