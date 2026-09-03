// Mask-state helpers for the shared destructive-command guard, split out of
// destructive-command-guard.ts to stay under the per-file line cap. See that
// module's header for the full rationale — the short version: these
// functions are embedded verbatim (via `Function.prototype.toString()`) into
// the zero-import generated `.mjs` hook, so every function here MUST stay a
// free-standing, self-contained `function` declaration with no module-scope
// constants and no reference to anything outside its own parameters.

interface MaskState {
	quote: string | null;
	escaped: boolean;
	comment: boolean;
}

/** One character inside a `#...` shell comment: masked until end-of-line. */
export function dcgMaskCommentStep(ch: string, state: MaskState): string {
	if (ch === "\n") {
		state.comment = false;
		return ch;
	}
	return " ";
}

/** One character inside a quoted span (`'`, `"`, or backtick): always masked. */
export function dcgMaskQuoteStep(ch: string, state: MaskState): string {
	if (state.escaped) {
		state.escaped = false;
		return " ";
	}
	if (ch === "\\") {
		state.escaped = true;
		return " ";
	}
	if (ch === state.quote) state.quote = null;
	return " ";
}

/** One character outside any quote/comment: detects the start of either. */
export function dcgMaskUnquotedStep(ch: string, i: number, value: string, state: MaskState): string {
	const backtick = String.fromCharCode(96);
	if (ch === "#" && (i === 0 || /\s/.test(value[i - 1] || ""))) {
		state.comment = true;
		return " ";
	}
	if (ch === "'" || ch === '"' || ch === backtick) {
		state.quote = ch;
		return " ";
	}
	return ch;
}

// Blank out quoted/escaped/commented spans so a destructive verb that only
// appears as quoted DATA (e.g. 'echo "reboot"') is not mistaken for an
// executable verb. Dispatches per-character to the three step helpers above
// so no single function carries the whole state machine's complexity.
export function dcgMaskInlineQuotedShell(value: string): string {
	const out: string[] = [];
	const state: MaskState = { quote: null, escaped: false, comment: false };
	for (let i = 0; i < value.length; i++) {
		const ch = value[i] ?? "";
		if (state.comment) {
			out.push(dcgMaskCommentStep(ch, state));
			continue;
		}
		if (state.quote) {
			out.push(dcgMaskQuoteStep(ch, state));
			continue;
		}
		out.push(dcgMaskUnquotedStep(ch, i, value, state));
	}
	return out.join("");
}

// Shutdown/reboot detection. Anchored to a command-start position and
// tolerant of wrapper chains ('sudo', 'env VAR=v', 'bash -c "..."').
export function dcgMatchesShutdown(cmdValue: string): boolean {
	const masked = dcgMaskInlineQuotedShell(cmdValue);
	const directRe =
		/(^|\|\||&&|[;|\n])\s*(?:(?:env(?:\s+[A-Za-z_]\w*=\S+)*|command|exec|nohup|sudo)\s+|(?:bash|sh)\s+-c\s*["']?\s*)*(shutdown|reboot|halt|poweroff|init\s+[06]|systemctl\s+(poweroff|reboot|halt))\b/i;
	const quotedShellRe =
		/(^|\|\||&&|[;|\n])\s*(?:(?:env(?:\s+[A-Za-z_]\w*=\S+)*|command|exec|nohup|sudo)\s+)*(?:bash|sh)\s+-c\s*["']\s*(?:(?:env(?:\s+[A-Za-z_]\w*=\S+)*|command|exec|nohup|sudo)\s+)*(shutdown|reboot|halt|poweroff|init\s+[06]|systemctl\s+(poweroff|reboot|halt))\b/i;
	return directRe.test(masked) || quotedShellRe.test(cmdValue);
}
