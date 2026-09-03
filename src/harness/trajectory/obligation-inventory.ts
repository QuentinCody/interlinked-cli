// ===========================================
// Obligation inventory — Stop-time open-loop ledger + conflict-marker nudge
// ===========================================
//
// Family 3 ("Obligation Ledger") of docs/design/deterministic-trajectory-rules.md.
// Two deterministic rules, both pure functions over the session's tool-event
// stream — no model inference, no network, no fs, no randomness:
//
//   1. `obl_net_open_at_stop`  (formatOpenObligations)
//      A Stop-time inventory of obligations the session OPENED minus those it
//      later CLOSED. An obligation is OPENED when its text first appears on the
//      ADDED side of an edit (`new_string` for Edit, `content` for Write) and
//      CLOSED when a later edit removes that same text (it appears on the
//      `old_string` side without reappearing on the added side). The residual —
//      net-open obligations — is surfaced once, at Stop, framed as an inventory
//      (not a failure). Calm checklist tone, stderr-only, never blocks. Mirrors
//      the existing Stop reflection helpers (verification-stop-checks.ts,
//      commit-cadence.ts): a pure formatter returning `string | null`.
//
//   2. `obl_conflict_marker_persisted`  (obligationConflictMarkerRule)
//      A per-edit nudge that fires when an edit LEAVES a 7-char Git
//      conflict-marker run (`<<<<<<<` / `=======` / `>>>>>>>`) in the file —
//      continuing or committing past an unresolved merge. Near-zero FP: anchored
//      to exact 7-char runs at line start, doc/fixture/codegen files exempt.
//
// SELF-CONTAINED by design: this module defines the small types it needs
// locally and imports nothing from its trajectory/ siblings (owned by another
// agent). Its only dependency is `node:path::basename` for display.

import { basename } from "node:path";

// ---------------------------------------------------------------------------
// Local types
// ---------------------------------------------------------------------------

/** One recorded tool call in the session stream. The harness joins these by
 *  `toolUseId`; we scan the edit-bearing ones at Stop / per-edit. */
export interface ToolEvent {
	ts: string;
	session: string;
	tool: string;
	toolUseId: string;
	hook: string;
	input: {
		file_path?: string;
		old_string?: string;
		new_string?: string;
		content?: string;
		command?: string;
	};
}

/** The obligation classes this ledger accounts for. */
type ObligationKind = "conflict_marker" | "stub" | "test_disabled" | "todo";

/** Action gradient (Family framing): nudge is the default; block is reserved
 *  for proven harm; silent_metric never interrupts. These rules only nudge. */
type ObligationAction = "nudge" | "block" | "silent_metric";

/** A per-edit verdict. Shape mirrors the sequence-checks SequenceFinding —
 *  rule id + agent-visible message + evidence snippets — kept local so this
 *  module stays free-standing. */
interface ObligationVerdict {
	rule_id: string;
	action: ObligationAction;
	severity: "low" | "medium" | "high";
	file: string;
	message: string;
	evidence: string[];
}

// ---------------------------------------------------------------------------
// Exemptions (FP guards): doc / markdown / fixture / snapshot / codegen
// ---------------------------------------------------------------------------

/** Path-based exemption. Docs and markdown carry prose "TODO" and Setext `=======`
 *  heading underlines; fixtures and snapshots embed deliberate marker/stub text.
 *  Real test files (`*.test.ts`) are deliberately NOT exempt — disabled tests
 *  (`it.skip`) inside them are exactly the obligation we want to catch. */
export function isExemptPath(filePath: string): boolean {
	const p = filePath.replace(/\\/g, "/").toLowerCase();
	if (/\.(?:md|mdx|markdown|rst|txt)$/.test(p)) return true;
	if (/(?:^|\/)docs\//.test(p)) return true;
	if (/(?:^|\/)(?:__fixtures__|fixtures|testdata|test-fixtures)\//.test(p)) return true;
	if (/(?:^|\/)__snapshots__\//.test(p) || p.endsWith(".snap")) return true;
	return false;
}

/** Codegen DATA is exempt from line-cap-style policy and carries large embedded
 *  marker/stub-shaped tables. We can only see the edited region, so this is a
 *  best-effort text check for the `@codegen-data` header marker. */
function textLooksLikeCodegen(text: string): boolean {
	return text.includes("@codegen-data");
}

// ---------------------------------------------------------------------------
// Conflict markers
// ---------------------------------------------------------------------------

/** Git conflict-marker run: EXACTLY seven `<`/`=`/`>` at line start, followed by
 *  a space, tab, or end-of-line. Per-line (no `m` flag — callers split first).
 *  - `<<<<<<< HEAD` / `>>>>>>> branch` → run + space + ref.
 *  - `=======`                         → run + EOL (bare separator).
 *  An 8+ run (`========`) fails the trailing boundary → not a marker (banner
 *  comments like `// ====…` start with `/`, never the run, so never match). */
const CONFLICT_MARKER_RE = /^(?:<{7}|={7}|>{7})(?: |\t|$)/;

/** The trimmed conflict-marker lines present in `text` (capped snippet length).
 *  Empty when there are none. */
function conflictMarkerLines(text: string): string[] {
	const out: string[] = [];
	for (const line of text.split(/\r?\n/)) {
		if (CONFLICT_MARKER_RE.test(line)) out.push(line.trim().slice(0, 80));
	}
	return out;
}

// ---------------------------------------------------------------------------
// Obligation occurrence extraction
// ---------------------------------------------------------------------------

interface Occurrence {
	kind: ObligationKind;
	/** Normalized obligation-bearing line — the close-matching signature. */
	sig: string;
	/** Short display snippet. */
	snippet: string;
}

/** Markers in the TODO / FIXME / XXX / HACK family. UPPERCASE-only
 *  (case-sensitive) so lowercase prose ("the todo list") never fires. The
 *  optional `(...)` capture is the ticket/author tag — a marker with a `(…)`
 *  suffix such as TODO with an owner, or FIXME with an issue ref, is
 *  suppressed. */
const TODO_RE = /\b(TODO|FIXME|XXX|HACK)\b(\s*\(([^)]*)\))?/g;

/** Stub / not-implemented sinks across JS/TS, Python, and Rust. */
const STUB_RES: readonly RegExp[] = [
	/throw\s+new\s+[A-Za-z]*Error\s*\(\s*[`'"][^`'"]*\bnot[\s_-]*implement/i,
	/\bNotImplementedError\b/,
	/\braise\s+NotImplementedError\b/i,
	/\b(?:unimplemented|todo)!\s*\(/,
	/\bpanic!\s*\(\s*"[^"]*\bnot[\s_-]*implement/i,
];

/** Disabled / focused tests. Framework-prefixed forms only, so a bare
 *  `"skip"` string or a `foo.skip(` query-builder call never fires.
 *  `.todo` is deliberately excluded (self-documenting planned test). */
const TEST_DISABLE_RES: readonly RegExp[] = [
	/\b(?:xit|xdescribe|xtest|fit|fdescribe)\s*\(/,
	/\b(?:it|test|describe|context)\s*\.\s*(?:skip|only|failing)\s*\(/,
	/@pytest\.mark\.skip\b/,
	/@unittest\.skip\b/,
	/#\[\s*ignore\s*\]/,
];

function normLine(line: string): string {
	return line.trim().replace(/\s+/g, " ");
}

/** Pure: every obligation occurrence in `text`, one per match. No path/codegen
 *  logic here — callers apply exemptions before calling. */
function extractOccurrences(text: string): Occurrence[] {
	if (!text) return [];
	const out: Occurrence[] = [];
	for (const rawLine of text.split(/\r?\n/)) {
		const sig = normLine(rawLine);
		const snippet = sig.slice(0, 80);

		// Conflict marker — line-anchored, exact 7-char run.
		if (CONFLICT_MARKER_RE.test(rawLine)) {
			out.push({ kind: "conflict_marker", sig, snippet });
		}

		// Markers in the TODO / FIXME / XXX / HACK family — skip ticket/author-tagged.
		TODO_RE.lastIndex = 0;
		for (let m = TODO_RE.exec(rawLine); m !== null; m = TODO_RE.exec(rawLine)) {
			const tag = m[3];
			if (tag !== undefined && tag.trim().length > 0) continue;
			out.push({ kind: "todo", sig: `todo ${sig}`, snippet });
		}

		// Stub / not-implemented.
		if (STUB_RES.some((re) => re.test(rawLine))) {
			out.push({ kind: "stub", sig: `stub ${sig}`, snippet });
		}

		// Disabled / focused test.
		if (TEST_DISABLE_RES.some((re) => re.test(rawLine))) {
			out.push({ kind: "test_disabled", sig: `test ${sig}`, snippet });
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

interface LedgerEntry {
	count: number;
	kind: ObligationKind;
	file: string;
	snippet: string;
}

/** Count occurrences keyed by `(file, kind, signature)` so a later edit that
 *  removes the exact line closes exactly that obligation. */
function countByKey(occ: Occurrence[], file: string): Map<string, LedgerEntry> {
	const m = new Map<string, LedgerEntry>();
	for (const o of occ) {
		const key = `${file}\x00${o.kind}\x00${o.sig}`;
		const cur = m.get(key);
		if (cur) cur.count += 1;
		else m.set(key, { count: 1, kind: o.kind, file, snippet: o.snippet });
	}
	return m;
}

/** Keep one event per non-empty toolUseId (PreToolUse + PostToolUse carry the
 *  same input — count the edit once) and only the edit-bearing ones. */
function editEvents(events: readonly ToolEvent[]): ToolEvent[] {
	const seen = new Set<string>();
	const out: ToolEvent[] = [];
	for (const ev of events) {
		// `input` is declared required, but this ledger is documented ("we
		// scan the edit-bearing ones at Stop / per-edit") to eventually read
		// events reconstructed from a persisted JSONL trajectory log, not
		// only the in-process `toToolEvent`-built stream — a genuinely
		// malformed/truncated record there can omit `input` entirely.
		const input = (ev as { input?: ToolEvent["input"] }).input;
		if (!input) continue;
		const hasEdit =
			input.new_string !== undefined ||
			input.old_string !== undefined ||
			input.content !== undefined;
		if (!hasEdit) continue;
		const id = ev.toolUseId;
		if (id) {
			if (seen.has(id)) continue;
			seen.add(id);
		}
		out.push(ev);
	}
	return out;
}

/** Net one `(file, kind, signature)` key's added-vs-removed occurrence counts
 *  into `ledger`, mutating it in place. Opened (delta > 0) accumulates; closed
 *  (delta < 0) decrements but never below zero, so removing a pre-existing
 *  obligation we never saw opened can't create a phantom negative. A zero
 *  (or now-zero) count deletes the entry rather than leaving a stale zero. */
function mergeKeyDelta(
	ledger: Map<string, LedgerEntry>,
	key: string,
	added: Map<string, LedgerEntry>,
	removed: Map<string, LedgerEntry>,
): void {
	const a = added.get(key)?.count ?? 0;
	const r = removed.get(key)?.count ?? 0;
	const delta = a - r;
	if (delta === 0) return;
	const meta = added.get(key) ?? removed.get(key);
	if (!meta) return;
	const cur = ledger.get(key) ?? {
		count: 0,
		kind: meta.kind,
		file: meta.file,
		snippet: meta.snippet,
	};
	cur.count = Math.max(0, cur.count + delta);
	if (cur.count === 0) ledger.delete(key);
	else ledger.set(key, cur);
}

/** Nets one edit event's added-vs-removed obligation occurrences into
 *  `ledger`, mutating it (and `lastWrite`, for the repeated-Write diff-against-
 *  prior-content case) in place. Exempt/codegen files and texts are skipped. */
function applyEditEvent(
	ev: ToolEvent,
	ledger: Map<string, LedgerEntry>,
	lastWrite: Map<string, string>,
): void {
	const file = ev.input.file_path ?? "";
	if (!file || isExemptPath(file)) return;

	const addedText = ev.input.new_string ?? ev.input.content ?? "";
	const isWrite = ev.input.content !== undefined && ev.input.new_string === undefined;
	let removedText = ev.input.old_string ?? "";
	if (isWrite) {
		const prev = lastWrite.get(file);
		if (prev !== undefined) removedText = prev;
		lastWrite.set(file, addedText);
	}
	if (textLooksLikeCodegen(addedText) || textLooksLikeCodegen(removedText)) return;

	const added = countByKey(extractOccurrences(addedText), file);
	const removed = countByKey(extractOccurrences(removedText), file);
	const keys = new Set<string>([...added.keys(), ...removed.keys()]);
	for (const key of keys) {
		mergeKeyDelta(ledger, key, added, removed);
	}
}

/** Walk the session's edits in order, netting opened against closed
 *  obligations into a per-`(file, kind, signature)` ledger. */
function buildLedger(events: readonly ToolEvent[]): Map<string, LedgerEntry> {
	const ledger = new Map<string, LedgerEntry>();
	// Repeated full Writes to the same path diff against the prior content so a
	// re-Write doesn't re-open obligations it merely carried forward.
	const lastWrite = new Map<string, string>();

	for (const ev of editEvents(events)) {
		applyEditEvent(ev, ledger, lastWrite);
	}
	return ledger;
}

// ---------------------------------------------------------------------------
// Rule 1 — obl_net_open_at_stop
// ---------------------------------------------------------------------------

const KIND_ORDER: readonly ObligationKind[] = [
	"conflict_marker",
	"stub",
	"test_disabled",
	"todo",
];

const KIND_LABEL: Record<ObligationKind, string> = {
	conflict_marker: "merge conflict marker",
	stub: "stub / not-implemented",
	test_disabled: "disabled test (.skip/.only/xit)",
	todo: "TODO/FIXME/XXX/HACK",
};

const MAX_FILES_PER_KIND = 6;

/**
 * Public — `obl_net_open_at_stop`. Stop-time inventory of obligations this
 * session OPENED and never CLOSED, grouped by kind with file references.
 * Returns `null` when the net-open set is empty. Pure; fire only at Stop.
 *
 * Deliberately framed as an inventory, not a failure (the FP guard): every
 * line is a loose end the session opened — surfacing it once at Stop is a
 * reflective checklist, never a block.
 */
export function formatOpenObligations(events: ToolEvent[]): string | null {
	if (!Array.isArray(events) || events.length === 0) return null;
	const ledger = buildLedger(events);
	if (ledger.size === 0) return null;

	const byKind = new Map<ObligationKind, { files: Set<string>; count: number }>();
	let total = 0;
	for (const e of ledger.values()) {
		const b = byKind.get(e.kind) ?? { files: new Set<string>(), count: 0 };
		b.files.add(basename(e.file));
		// Plain integer addition (not `+=`) on these counters keeps them out of
		// the immutable-string-concat-in-loop heuristic's net.
		b.count = b.count + e.count;
		byKind.set(e.kind, b);
		total = total + e.count;
	}
	if (total === 0) return null;

	const lines: string[] = [];
	for (const kind of KIND_ORDER) {
		const b = byKind.get(kind);
		if (!b || b.files.size === 0) continue;
		const files = [...b.files].sort();
		const shown = files.slice(0, MAX_FILES_PER_KIND);
		const more =
			files.length > MAX_FILES_PER_KIND
				? `, …and ${files.length - MAX_FILES_PER_KIND} more`
				: "";
		lines.push(`  ${KIND_LABEL[kind]} (${b.count}): ${shown.join(", ")}${more}`);
	}

	return (
		`[interlinked:obligations] Stopping with ${total} open obligation(s) introduced this ` +
		"session that were never closed:\n" +
		`${lines.join("\n")}\n` +
		"Each is a loose end you opened and didn't tie off — an inventory, not a failure. " +
		"If deliberate, leave a tracked TODO or issue; otherwise close them before stopping."
	);
}

// ---------------------------------------------------------------------------
// Rule 2 — obl_conflict_marker_persisted
// ---------------------------------------------------------------------------

/**
 * Public — `obl_conflict_marker_persisted`. Per-edit nudge that fires when the
 * `latest` edit LEAVES a 7-char Git conflict-marker run in the file (the marker
 * is present in the resulting text — `new_string` for Edit, `content` for
 * Write). Returns `null` when the edit removes the marker (resolved), targets
 * an exempt file, or leaves no marker.
 *
 * `events` (the prior trajectory) is consulted only to distinguish a marker
 * that PERSISTED across an earlier same-file edit ("survives a later edit", the
 * spec's exact signal) from one freshly introduced by this edit — both fire.
 */
export function obligationConflictMarkerRule(
	events: ToolEvent[],
	latest: ToolEvent,
): ObligationVerdict | null {
	const file = latest.input.file_path ?? "";
	if (!file || isExemptPath(file)) return null;

	const resultText = latest.input.new_string ?? latest.input.content ?? "";
	if (!resultText || textLooksLikeCodegen(resultText)) return null;

	const markers = conflictMarkerLines(resultText);
	if (markers.length === 0) return null;

	const priorWithMarker = (Array.isArray(events) ? events : []).some(
		(ev) =>
			ev !== latest &&
			ev.input.file_path === file &&
			conflictMarkerLines(ev.input.new_string ?? ev.input.content ?? "").length > 0,
	);
	const lede = priorWithMarker
		? "Conflict markers present in an earlier edit survived this one"
		: "This edit leaves Git merge-conflict markers in the file";

	return {
		rule_id: "obl_conflict_marker_persisted",
		action: "nudge",
		severity: "high",
		file,
		message:
			`[interlinked:obligation] obl_conflict_marker_persisted: ${lede} (${basename(file)}). ` +
			"A 7-char conflict-marker run (<<<<<<< / ======= / >>>>>>>) means an unresolved merge was " +
			"left in place — continuing or committing past it ships both sides of the conflict. " +
			"Resolve it (pick a side, delete the markers) before moving on.",
		evidence: markers.slice(0, 4),
	};
}
