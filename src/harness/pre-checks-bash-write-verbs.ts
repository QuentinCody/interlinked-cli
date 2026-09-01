// ===========================================
// Bash write detection — wrapper unwrap + in-place editors + diff appliers
// ===========================================
// Sibling of `pre-checks-bash-write-detect.ts` (split for the line cap).
// Closes the 2026-08-25 gap audit items 1–3: `patch`/`git apply` land content
// in tracked files named inside the diff; `perl -pi`/`gawk -i inplace`/`ex`/
// `ed` are in-place editors the sed-only scan missed; and `xargs`/`find
// -exec`/`timeout` wrappers hid the mutating verb from every verb scanner.

import { nonNull } from "../lib/non-null.js";
import {
	CODE_FILE_EXT_RE,
	splitCommandSegments,
	splitShellWordsLoose,
	stripOuterQuotes,
} from "./pre-checks-bash-write-shared.js";

interface VerbWriteHit {
	target: string;
	mechanism: string;
}

/** Launcher verbs that wrap another command; the wrapped command is the one
 *  the verb scanners must see. `env` also skips its VAR=… assignments,
 *  `timeout` its duration, and flag tokens are skipped for all of them. */
const WRAPPER_VERBS = new Set([
	"sudo",
	"env",
	"nohup",
	"nice",
	"time",
	"timeout",
	"stdbuf",
	"caffeinate",
	"xargs",
]);

/** Strip leading wrapper verbs from one segment; null when nothing changed. */
function unwrapOneSegment(segment: string): string | null {
	const words = splitShellWordsLoose(segment).map(stripOuterQuotes);
	let i = 0;
	while (i < words.length) {
		const verb = nonNull(words[i]).split("/").pop() ?? nonNull(words[i]);
		if (!WRAPPER_VERBS.has(verb)) break;
		i++;
		// env VAR=x …  |  timeout [-k dur] 60 …  |  xargs -0 -n1 -I{} …
		while (i < words.length) {
			const w = nonNull(words[i]);
			const isEnvAssign = verb === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w);
			const isDuration = verb === "timeout" && /^[0-9]+[smhd]?$/.test(w);
			if (isEnvAssign || isDuration || w.startsWith("-")) i++;
			else break;
		}
	}
	if (i === 0 || i >= words.length) return null;
	return words.slice(i).join(" ");
}

/** `find … -exec CMD … ;` / `+` — the exec'd command is the real verb. */
function extractFindExecCommands(cmd: string): string[] {
	const out: string[] = [];
	const re = /-exec(?:dir)?\s+([^;+]+?)\s*(?:\\?;|\+)/g;
	for (const m of cmd.matchAll(re)) out.push(nonNull(m[1]));
	return out;
}

/** Append unwrapped/exec'd inner commands as extra segments (gap 3). */
export function withUnwrappedCommands(normalized: string): string {
	const extra: string[] = [];
	for (const segment of splitCommandSegments(normalized)) {
		const unwrapped = unwrapOneSegment(segment);
		if (unwrapped) extra.push(unwrapped);
	}
	extra.push(...extractFindExecCommands(normalized));
	return extra.length === 0 ? normalized : `${normalized} ; ${extra.join(" ; ")}`;
}

/** perl -pi / -i, awk/gawk -i inplace, ex/ed batch edits (gap 2). The target
 *  is the last code-extension positional, same convention as sed -i. */
export function detectInPlaceEditorVerbs(cmd: string): VerbWriteHit | null {
	for (const segment of splitCommandSegments(cmd)) {
		const args = splitShellWordsLoose(segment).map(stripOuterQuotes);
		if (args.length < 2) continue;
		const verb = nonNull(args[0]).split("/").pop() ?? nonNull(args[0]);
		const rest = args.slice(1);
		const isPerlInPlace =
			verb === "perl" && rest.some((a) => /^-[A-Za-z]*i/.test(a) && !a.startsWith("--"));
		const isAwkInPlace =
			(verb === "awk" || verb === "gawk") &&
			rest.some((a, k) => a === "-i" && rest[k + 1] === "inplace");
		const isBatchEditor = verb === "ex" || verb === "ed";
		if (!isPerlInPlace && !isAwkInPlace && !isBatchEditor) continue;
		for (let i = rest.length - 1; i >= 0; i--) {
			const arg = nonNull(rest[i]);
			if (arg.startsWith("-")) continue;
			if (CODE_FILE_EXT_RE.test(arg)) {
				return { target: arg, mechanism: `${verb} (in-place edit)` };
			}
		}
	}
	return null;
}

/** Read-only patch/apply forms that must never fire the gate. */
const PATCH_READONLY_FLAG_RE = /--(?:check|stat|numstat|summary|dry-run)\b/;

/** `patch` / `git apply` (gap 1): content lands in tracked files named inside
 *  the diff — no resolvable per-file target, so the verb is the signal. */
export function detectPatchApplyVerb(cmd: string): VerbWriteHit | null {
	for (const segment of splitCommandSegments(cmd)) {
		if (PATCH_READONLY_FLAG_RE.test(segment)) continue;
		const args = splitShellWordsLoose(segment).map(stripOuterQuotes);
		const verb = args.length > 0 ? (nonNull(args[0]).split("/").pop() ?? "") : "";
		if (verb === "patch") {
			return { target: "(files named inside the diff)", mechanism: "patch (diff applier)" };
		}
		if (verb === "git" && args[1] === "apply") {
			return { target: "(files named inside the diff)", mechanism: "git apply (diff applier)" };
		}
	}
	return null;
}

/** sed -i (in-place edit) — moved here from the detect module so every
 *  in-place editor lives behind one scan (and sees unwrapped segments). */
export function detectSedInPlaceEdit(cmd: string): VerbWriteHit | null {
	for (const segment of splitCommandSegments(cmd)) {
		const args = splitShellWordsLoose(segment);
		const sedIdx = args.findIndex((arg) => /(?:^|\/)sed$/.test(stripOuterQuotes(arg)));
		if (sedIdx < 0) continue;
		const sedArgs = args.slice(sedIdx + 1).map(stripOuterQuotes);
		if (!sedArgs.some(isSedInPlaceOption)) continue;
		for (let i = sedArgs.length - 1; i >= 0; i--) {
			const arg = nonNull(sedArgs[i]);
			if (arg.startsWith("-")) continue;
			if (CODE_FILE_EXT_RE.test(arg)) {
				return { target: arg, mechanism: "sed -i (in-place)" };
			}
		}
	}
	return null;
}

function isSedInPlaceOption(arg: string): boolean {
	return arg === "-i" || /^-[A-Za-z]*i(?:$|[^A-Za-z].*)/.test(arg);
}

/** In-place editors and diff appliers behind one call, so the orchestrator in
 *  `detectBashCodeFileWrite` spends two branches, not eight. */
export function scanInPlaceAndPatchVerbs(
	scannable: string,
	inRoot: (t: string) => boolean,
	projectRoot?: string,
): VerbWriteHit | null {
	const sedHit = detectSedInPlaceEdit(scannable);
	if (sedHit && inRoot(sedHit.target)) return sedHit;
	const inPlace = detectInPlaceEditorVerbs(scannable);
	if (inPlace && inRoot(inPlace.target)) return inPlace;
	if (projectRoot) {
		const patchHit = detectPatchApplyVerb(scannable);
		if (patchHit) return patchHit;
	}
	return null;
}
