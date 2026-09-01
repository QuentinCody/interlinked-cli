// interlinked-tdd: exempt — type declarations only, no runtime logic.
// ===========================================
// Deterministic Trajectory-Analysis Engine — shared types
// ===========================================
//
// This module owns the *new* trajectory engine that lives entirely under
// `src/harness/trajectory/`. It is intentionally decoupled from the older
// `sequence-checks/` SequenceDetector framework: it operates on a normalized
// `ToolEvent` (not `HarnessEvent`), carries its own incremental `TrajectoryState`
// object, and exposes rules as pure `(state, event) => Verdict | null` functions.
//
// Framing (per docs/design/deterministic-trajectory-rules.md): every rule is
// complex-event processing over the tool-call stream — counting, grouping,
// hashing, and reachability with NO model inference. Rules are pure: no IO,
// no network, no randomness, no Date.now. Determinism is structural.

/**
 * The normalized tool-call event the harness feeds the trajectory engine. One
 * is emitted per hook firing (PreToolUse / PostToolUse / Stop). The
 * content-hash + outcome + check fields are only populated at PostToolUse
 * (they require the file on disk and the check pipeline to have run).
 */
export interface ToolEvent {
	/** ISO-8601 timestamp the harness stamped on the event (data, not a clock read). */
	ts: string;
	/** Session id this event belongs to. */
	session: string;
	/** Agent name / source. */
	agent: string;
	/** Tool name. The union lists the common tools; any string is accepted. */
	tool: string;
	/** Stable per-tool-call id; the PreToolUse and PostToolUse share it. */
	toolUseId: string;
	/** Which hook fired. Block rules evaluate at PreToolUse; churn rules at PostToolUse. */
	hook: string;
	/** Raw tool input (the fields the rules care about). */
	input: {
		file_path?: string;
		old_string?: string;
		new_string?: string;
		content?: string;
		command?: string;
	};
	/** sha256 of the file's post-edit content. Populated at PostToolUse only. */
	contentSha256?: string;
	/** Outcome of the tool call. Populated at PostToolUse only. */
	toolOutcome?: "success" | "fail" | null;
	/** The harness's block/allow decision for this edit. Populated at PostToolUse. */
	checkDecision?: "allow" | "block" | null;
	/** Ids of checks (error/warning severity) that fired on this edit. */
	failedCheckIds?: string[];
}

/** What a firing rule asks the harness to do. */
type VerdictAction = "block" | "nudge" | "silent_metric";

/** Confidence/impact band. */
type VerdictSeverity = "high" | "medium" | "low";

/** A single rule firing. */
export interface Verdict {
	/** snake_case rule id (matches the catalog). */
	ruleId: string;
	/** block (deterministic harm) / nudge (default) / silent_metric (labeler only). */
	action: VerdictAction;
	severity: VerdictSeverity;
	/** Human-readable explanation shown to the agent (block/nudge) or logged (metric). */
	reason: string;
}

/**
 * A trajectory rule. Pure and total: given the (already-folded) state and the
 * triggering event, returns a Verdict or null. Must not mutate `state`, must
 * not throw, must not perform IO. The caller folds the event into state via
 * `applyEvent` BEFORE invoking the rules, so a rule sees state that already
 * reflects the current event.
 */
export type TrajectoryRule = (state: TrajectoryState, event: ToolEvent) => Verdict | null;

// ===========================================
// TrajectoryState sub-records
// ===========================================

/** One entry in a file's ordered content-sha history. */
export interface ShaEntry {
	/** sha256 of the exact post-edit content. */
	sha: string;
	/** sha256 of the whitespace-collapsed content (to exclude cosmetic cycles). */
	normSha: string;
	atStep: number;
}

/** One recorded edit (old→new) on a file, with the check + green context. */
export interface EditRecord {
	old: string;
	new: string;
	/** anchorHash(old) — content-anchored region key that survives line drift. */
	anchor: string;
	atStep: number;
	/** Whether this edit failed a check (failedCheckIds non-empty or decision=block). */
	failedCheck: boolean;
	/** Snapshot of state.greenCount when this edit was recorded ("green between" test). */
	greenCountAtEntry: number;
}

/** One value an anchor held at a point in time (for undo-war A,B,A detection). */
interface AnchorValueEntry {
	/** sha256 of the new_string written at this anchor. */
	valueHash: string;
	atStep: number;
	/** Snapshot of state.verifyRunCount ("did a test/build run between toggles"). */
	verifyCountAtEntry: number;
}

/** Per-normalized-command failure tracking. */
interface CommandFailure {
	count: number;
	lastStep: number;
}

/** Per-command-family rerun tracking (test/build re-run without source change). */
interface FamilyRerun {
	/** Consecutive failing runs of this family with no successful edit between. */
	failingNoEditCount: number;
	/** state.successfulEditCount snapshot at the last run of this family. */
	editCountAtLastRun: number;
	lastStep: number;
}

/** A downloaded remote artifact (download leg of fetch-then-execute). */
export interface DownloadRecord {
	/** External host the artifact came from. */
	host: string;
	atStep: number;
	/** Whether the URL path looked like an executable script (.sh/.py/...). */
	isScript: boolean;
}

/** A secret literal pending in a tracked env/config file (env-add-then-commit). */
interface PendingSecretWrite {
	kind: string;
	atStep: number;
}

/** A write to a git hook file (git-hook-backdoor leg). */
interface GitHookWrite {
	atStep: number;
	/** Whether the hook body contained an exec/egress sink. */
	hasSink: boolean;
}

/** A DNS lookup observed in a Bash command (dns-exfil-burst substrate). */
interface DnsQuery {
	baseDomain: string;
	label: string;
	atStep: number;
}

/** A self-blinding harness-disable event (harness-disable-then-guarded-op leg). */
interface HarnessDisable {
	atStep: number;
	how: string;
}

// ===========================================
// TrajectoryState
// ===========================================

/**
 * All per-session trajectory state, maintained incrementally (O(delta) per
 * event) by `applyEvent`. Every collection is bounded so a long session cannot
 * grow memory without limit (see the *_CAP constants in state.ts).
 */
export interface TrajectoryState {
	session: string;
	/** Monotonic event counter (incremented on every applyEvent call). */
	stepCount: number;
	/** Count of "green" events (clean edit OR passing verify) — the revert-combo gate. */
	greenCount: number;
	/** Count of successful edits (for "no successful edit between" reasoning). */
	successfulEditCount: number;
	/** Count of test/build runs (for "test ran between toggles"). */
	verifyRunCount: number;
	/** stepCount of the most recent install / env-set / git-checkout (churn reset). */
	lastDisruptStep: number;

	// ---- Family 1 (churn) substrate ----
	/** Per-file ordered content_sha256 list. */
	fileShaHistory: Map<string, ShaEntry[]>;
	/** Latest content_sha256 per file (for the worktree snapshot). */
	currentFileShas: Map<string, string>;
	/** Per-file recent edit (old→new) log. */
	fileEditLog: Map<string, EditRecord[]>;
	/** Per-(file,anchor) value sequence. Key = `${file}\x00${anchor}`. */
	anchorValueSeq: Map<string, AnchorValueEntry[]>;
	/** Per-file "edits since green" counter. */
	editsSinceGreen: Map<string, number>;
	/** Per-normalized-command failure tracking. */
	commandFailures: Map<string, CommandFailure>;
	/** Per-command-family rerun tracking. */
	familyReruns: Map<string, FamilyRerun>;
	/** Bounded list of whole-worktree snapshot hashes (sorted (file,sha) tuples). */
	worktreeSnapshots: string[];
	/** First 1-3 distinct edited files this session (frozen SEED). */
	seedFiles: string[];
	/** Bounded rolling window of the most recent events. */
	recentEvents: ToolEvent[];

	// ---- Family 9 (read/edit balance) substrate ----
	/**
	 * Last read step per path — Read tool calls plus bash pseudo-reads (a
	 * cat/grep/rg/sed/… segment naming the path). Keys are recorded as given
	 * (absolute for Read, possibly relative for bash), so consumers match by
	 * suffix as well as exactly. Over-recording only ever SUPPRESSES the
	 * read/edit-balance rules, so loose matching here is FP-safe.
	 */
	fileReadSteps: Map<string, number>;
	/** Total Read tool calls this session. */
	readCount: number;
	/** Total search calls (Grep/Glob tools + bash grep/rg/fd/find heads). */
	searchCount: number;

	// ---- Family 5 (security) substrate ----
	/** Secret-classified file paths read this session. */
	secretsRead: Set<string>;
	/** stepCount of the most recent secret read (0 = none). */
	lastSecretReadStep: number;
	/** Downloaded artifacts keyed by local path. */
	downloadedScripts: Map<string, DownloadRecord>;
	/** Secret literals pending in tracked env/config files, keyed by file path. */
	pendingSecretWrites: Map<string, PendingSecretWrite>;
	/** Structured secret tokens introduced via edits (taint set). */
	taintedSecretTokens: Set<string>;
	/** Hashes of structured secrets removed this session (in-session scrub set). */
	scrubbedSecretHashes: Set<string>;
	/** Git-hook writes keyed by hook name (e.g. "pre-commit"). */
	gitHookWrites: Map<string, GitHookWrite>;
	/** Most recent non-sanctioned harness-disable event, or null. */
	harnessDisabled: HarnessDisable | null;
	/** Bounded list of observed DNS lookups. */
	dnsQueries: DnsQuery[];
}
