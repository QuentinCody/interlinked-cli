// ===========================================
// Deterministic Trajectory-Analysis Engine — incremental state
// ===========================================
//
// `createState` allocates an empty TrajectoryState; `applyEvent` folds one
// ToolEvent into it in O(delta) and returns the same (mutated) object for
// chaining. Folding is gated on PostToolUse — the phase where the edit has
// landed and the content-hash / outcome / check fields are populated — so
// calling applyEvent on both the PreToolUse and PostToolUse of one tool call
// never double-counts. Rules read the folded state PLUS the current event, so a
// PreToolUse block rule sees every PRIOR completed leg.
//
// Deterministic: no IO, no network, no Date.now, no randomness. `event.ts` is
// data carried on the event, never a live clock read.

import {
	anchorHash,
	commandFamily,
	detectAllSecretLiterals,
	detectSecretLiteral,
	isBashEvent,
	isEditEvent,
	isSecretPath,
	isVerifyCommand,
	normalizeCommand,
	sha256,
	splitSegments,
} from "./helpers.js";
import {
	commandReadsSecretPath,
	editAddsDisabledRule,
	hasExecOrEgressSink,
	isDisruptCommand,
	isEnvConfigFile,
	isHighEntropyLabel,
	parseDnsQuery,
	parseHarnessDisable,
	parseRemoteScriptDownloads,
} from "./helpers-commands.js";
import type { EditRecord, ToolEvent, TrajectoryState } from "./types.js";

// Bounds — every collection is capped so a long session cannot grow memory
// without limit (oldest entries drop first).
const SHA_HISTORY_CAP = 64;
const EDIT_LOG_CAP = 64;
const ANCHOR_SEQ_CAP = 32;
const RECENT_EVENTS_CAP = 64;
const WORKTREE_SNAP_CAP = 64;
const DNS_QUERY_CAP = 64;
const SEED_CAP = 3;

/** Allocate an empty per-session trajectory state. */
export function createState(session: string): TrajectoryState {
	return {
		session,
		stepCount: 0,
		greenCount: 0,
		successfulEditCount: 0,
		verifyRunCount: 0,
		lastDisruptStep: 0,
		fileShaHistory: new Map(),
		currentFileShas: new Map(),
		fileEditLog: new Map(),
		anchorValueSeq: new Map(),
		editsSinceGreen: new Map(),
		commandFailures: new Map(),
		familyReruns: new Map(),
		worktreeSnapshots: [],
		seedFiles: [],
		recentEvents: [],
		fileReadSteps: new Map(),
		readCount: 0,
		searchCount: 0,
		secretsRead: new Set(),
		lastSecretReadStep: 0,
		downloadedScripts: new Map(),
		pendingSecretWrites: new Map(),
		taintedSecretTokens: new Set(),
		scrubbedSecretHashes: new Set(),
		gitHookWrites: new Map(),
		harnessDisabled: null,
		dnsQueries: [],
	};
}

/** Fold one event into state (mutating it) and return it for chaining. */
export function applyEvent(state: TrajectoryState, event: ToolEvent): TrajectoryState {
	state.stepCount += 1;
	pushCapped(state.recentEvents, event, RECENT_EVENTS_CAP);

	if (event.hook !== "PostToolUse") return state;
	if (isEditEvent(event)) foldEdit(state, event);
	else if (isBashEvent(event)) foldBash(state, event);
	else if (event.tool === "Read") foldRead(state, event);
	else if (event.tool === "Grep" || event.tool === "Glob") state.searchCount += 1;
	return state;
}

// ===========================================
// Edit folds (churn substrate + edit-derived security legs)
// ===========================================

function foldEdit(state: TrajectoryState, event: ToolEvent): void {
	const file = event.input.file_path;
	if (!file) return;
	const newContent = event.input.content ?? event.input.new_string ?? "";
	const oldContent = event.input.old_string ?? "";
	const failed = (event.failedCheckIds?.length ?? 0) > 0 || event.checkDecision === "block";
	const landed = event.toolOutcome !== "fail";
	const clean = landed && !failed;
	// Greens that happened strictly BEFORE this edit — recorded on the edit so
	// the revert-combo rule can test "no green between E1 and E3" exactly,
	// independent of whether E3 itself turns out clean.
	const greenBefore = state.greenCount;

	if (state.seedFiles.length < SEED_CAP && !state.seedFiles.includes(file)) {
		state.seedFiles.push(file);
	}

	if (landed) state.successfulEditCount += 1;
	if (clean) {
		state.greenCount += 1;
		state.editsSinceGreen.set(file, 0);
	} else {
		state.editsSinceGreen.set(file, (state.editsSinceGreen.get(file) ?? 0) + 1);
	}

	const sha = event.contentSha256;
	if (sha) {
		const normSha = sha256(normalizeWhitespace(newContent));
		pushCapped(
			getOrInit(state.fileShaHistory, file, () => []),
			{ sha, normSha, atStep: state.stepCount },
			SHA_HISTORY_CAP,
		);
		state.currentFileShas.set(file, sha);
		pushCapped(state.worktreeSnapshots, worktreeSnapshot(state.currentFileShas), WORKTREE_SNAP_CAP);
	}

	const anchor = anchorHash(oldContent);
	const rec: EditRecord = {
		old: oldContent,
		new: newContent,
		anchor,
		atStep: state.stepCount,
		failedCheck: failed,
		greenCountAtEntry: greenBefore,
	};
	pushCapped(getOrInit(state.fileEditLog, file, () => []), rec, EDIT_LOG_CAP);

	pushCapped(
		getOrInit(state.anchorValueSeq, `${file} ${anchor}`, () => []),
		{ valueHash: sha256(newContent), atStep: state.stepCount, verifyCountAtEntry: state.verifyRunCount },
		ANCHOR_SEQ_CAP,
	);

	// An intervening edit resets the repeated-failing-bash loop (catalog FP guard).
	state.commandFailures.clear();

	foldEditSecurity(state, file, oldContent, newContent);
}

function foldEditSecurity(
	state: TrajectoryState,
	file: string,
	oldContent: string,
	newContent: string,
): void {
	for (const m of detectAllSecretLiterals(newContent)) state.taintedSecretTokens.add(m.token);

	for (const m of detectAllSecretLiterals(oldContent)) {
		if (!newContent.includes(m.token)) state.scrubbedSecretHashes.add(sha256(m.token));
	}

	if (isEnvConfigFile(file)) {
		const sec = detectSecretLiteral(newContent);
		if (sec) state.pendingSecretWrites.set(file, { kind: sec.kind, atStep: state.stepCount });
		else state.pendingSecretWrites.delete(file);
	}

	const hookM = /(?:^|\/)\.git\/hooks\/([\w-]+)$/.exec(file);
	if (hookM?.[1]) {
		state.gitHookWrites.set(hookM[1], {
			atStep: state.stepCount,
			hasSink: hasExecOrEgressSink(newContent),
		});
	}

	if (/guard-rules(?:\.local)?\.json$/.test(file) && editAddsDisabledRule(oldContent, newContent)) {
		state.harnessDisabled = { atStep: state.stepCount, how: "grew disabled_rules" };
	}
}

// ===========================================
// Bash folds (command-derived legs)
// ===========================================

function foldBash(state: TrajectoryState, event: ToolEvent): void {
	const cmd = event.input.command;
	if (!cmd) return;
	const failed = event.toolOutcome === "fail";

	// A failed cat/grep displayed no content, so it earns no pseudo-read credit.
	if (!failed) foldBashReadBalance(state, cmd);

	if (isDisruptCommand(cmd)) {
		state.lastDisruptStep = state.stepCount;
		state.commandFailures.clear();
		state.familyReruns.clear();
	}

	if (isVerifyCommand(cmd)) {
		state.verifyRunCount += 1;
		foldFamilyRerun(state, cmd, failed);
		if (!failed) state.greenCount += 1;
	}

	if (failed) {
		const norm = normalizeCommand(cmd);
		const entry = state.commandFailures.get(norm) ?? { count: 0, lastStep: 0 };
		entry.count += 1;
		entry.lastStep = state.stepCount;
		state.commandFailures.set(norm, entry);
	}

	for (const d of parseRemoteScriptDownloads(cmd)) {
		if (d.localPath) {
			state.downloadedScripts.set(d.localPath, {
				host: d.host,
				atStep: state.stepCount,
				isScript: d.isScript,
			});
		}
	}

	const dis = parseHarnessDisable(cmd);
	if (dis) state.harnessDisabled = { atStep: state.stepCount, how: dis.how };

	const dns = parseDnsQuery(cmd);
	if (dns && isHighEntropyLabel(dns.label)) {
		pushCapped(state.dnsQueries, { ...dns, atStep: state.stepCount }, DNS_QUERY_CAP);
	}

	if (commandReadsSecretPath(cmd)) {
		state.secretsRead.add(normalizeCommand(cmd).slice(0, 80));
		state.lastSecretReadStep = state.stepCount;
	}
}

/**
 * Maintain the per-family rerun counter. A passing run clears it; a failing run
 * after a successful edit (or the first failing run) starts a fresh count of 1;
 * a failing re-run with no successful edit between increments. The rule fires at
 * count ≥3 (original fail + one allowed confirmation re-run + this one).
 */
function foldFamilyRerun(state: TrajectoryState, cmd: string, failed: boolean): void {
	const fam = commandFamily(cmd);
	if (fam !== "test" && fam !== "build") return;
	const prev = state.familyReruns.get(fam);
	const editsBetween = prev ? state.successfulEditCount > prev.editCountAtLastRun : true;
	let failingNoEditCount: number;
	if (!failed) failingNoEditCount = 0;
	else if (!prev || editsBetween) failingNoEditCount = 1;
	else failingNoEditCount = prev.failingNoEditCount + 1;
	state.familyReruns.set(fam, {
		failingNoEditCount,
		editCountAtLastRun: state.successfulEditCount,
		lastStep: state.stepCount,
	});
}

// ===========================================
// Read folds (+ Family 9 read/edit-balance substrate)
// ===========================================

function foldRead(state: TrajectoryState, event: ToolEvent): void {
	const file = event.input.file_path;
	if (!file) return;
	state.readCount += 1;
	recordRead(state, file);
	if (isSecretPath(file)) {
		state.secretsRead.add(file);
		state.lastSecretReadStep = state.stepCount;
	}
}

const FILE_READ_CAP = 512;

/** Record a read (or bash pseudo-read) of `path` at the current step, evicting
 *  the oldest entry once the map is full (insertion order = age). */
function recordRead(state: TrajectoryState, path: string): void {
	if (!state.fileReadSteps.has(path) && state.fileReadSteps.size >= FILE_READ_CAP) {
		const oldest = state.fileReadSteps.keys().next().value;
		if (oldest !== undefined) state.fileReadSteps.delete(oldest);
	}
	state.fileReadSteps.set(path, state.stepCount);
}

/** Bash verbs whose segment is a search (counts toward `searchCount`). */
const SEARCH_VERBS: ReadonlySet<string> = new Set(["grep", "rg", "fd", "find", "ag", "ack"]);
/** Bash verbs that display file content (a pseudo-read of the named paths). */
const INSPECT_VERBS: ReadonlySet<string> = new Set([
	"cat", "head", "tail", "sed", "awk", "less", "more", "bat",
]);

/**
 * Family 9 substrate, bash side: a grep/rg/fd/find segment counts as a search;
 * a search or inspect segment NAMING a path token records a pseudo-read of
 * that path (the agent saw the content / hit). Over-recording (e.g. a grep
 * PATTERN that looks path-ish) only ever suppresses the read/edit-balance
 * rules, so loose token matching is FP-safe by construction.
 */
/** Record a pseudo-read for each non-flag, path-shaped token among a search/inspect
 *  segment's arguments (the deepest-nested block of `foldBashReadBalance`). */
function recordPathLikeTokenReads(state: TrajectoryState, argToks: string[]): void {
	for (const raw of argToks) {
		const t = raw.replace(/^['"]|['"]$/g, "");
		if (t.startsWith("-")) continue;
		if (t.includes("/") || /\.[A-Za-z0-9]{1,8}$/.test(t)) recordRead(state, t);
	}
}

function foldBashReadBalance(state: TrajectoryState, cmd: string): void {
	for (const seg of splitSegments(cmd)) {
		const toks = seg.split(/\s+/).filter((t) => t.length > 0);
		const head = ((toks[0] ?? "").split("/").pop() ?? "").toLowerCase();
		const isSearch = SEARCH_VERBS.has(head);
		if (isSearch) state.searchCount += 1;
		if (!isSearch && !INSPECT_VERBS.has(head)) continue;
		recordPathLikeTokenReads(state, toks.slice(1));
	}
}

// ===========================================
// Small pure utilities
// ===========================================

function normalizeWhitespace(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

function worktreeSnapshot(currentFileShas: Map<string, string>): string {
	const tuples = [...currentFileShas.entries()]
		.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
		.map(([f, s]) => `${f}:${s}`);
	return sha256(tuples.join("\n"));
}

function pushCapped<T>(arr: T[], item: T, cap: number): void {
	arr.push(item);
	if (arr.length > cap) arr.splice(0, arr.length - cap);
}

function getOrInit<K, V>(map: Map<K, V>, key: K, init: () => V): V {
	let v = map.get(key);
	if (v === undefined) {
		v = init();
		map.set(key, v);
	}
	return v;
}
