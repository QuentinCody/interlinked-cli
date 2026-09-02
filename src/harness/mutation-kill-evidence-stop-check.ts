// ===========================================
// Mutation-kill evidence — Stop-time nudge
// ===========================================
// Companion to verification-stop-checks.ts. Sibling-file style, like
// dead-on-arrival.ts / fixture-leak.ts / untested-exports-stop-check.ts:
// detector + formatter live together here so lifecycle-stop-warnings.ts can
// mock ONE module for both. Only the formatter is re-exported from
// verification-stop-checks.ts (which is close to the per-file line cap).
//
// Grounding: docs/design/luna-gate-audit-2026-08-14.md §3(b). The audit's
// worked example — a Codex sub-agent added 30 new assertions to a
// `*.survivors.test.ts` file and self-reported "No mutation measurement was
// run" — is exactly the gap this nudge closes: that sentence was sitting in
// plain text in the agent's own final answer with nothing downstream reading
// it. This is the buildable-today subset of the audit's proposal — it does
// NOT require plan 19's receipt store
// (docs/plans/19-test-receipt-blinded-review-machine.md); it reads the
// mutation manifest's freshness and the test file's own test-contract
// markers directly, and detects the receipt store's ABSENCE rather than
// building it.
//
// Scope: `MUTATION_DIRECTED_PATH` (owned by checks/test-legitimacy.ts, reused
// here — not redefined) is the self-declaring file class: an agent that
// names a file `*.mutation-kill.*` / `*.mutation-hardening.*` /
// `*.survivors?.*` opted it into the stricter evidence bar by its own naming
// choice — the same "self-declared scope" logic large-file-policy.ts's
// `isCappableFile` already uses. Firing is gated on NEW-CASE INTRODUCTION
// (via check-evidence/case-parser.ts's block-opener walker, counted
// before/after this session against the git HEAD-sha baseline) so a
// drive-by maintenance edit to an EXISTING mutation-kill file — touching
// zero test cases — never fires. Two evidence gaps are checked; EITHER
// alone is enough to fire (this is a nudge, not two separate checks):
//
//   (a) staleMeasurement — no mutation measurement (manifest
//       `authoritativeAt`) newer than this session's last write to the
//       file. Test files can never be manifest KEYS themselves
//       (mutation/manifest.ts's `applyMeasuredRun` refuses — the test is
//       the oracle, mutating it proves nothing), so there is no
//       PER-TEST-FILE measurement timestamp to read; `authoritativeAt`
//       (bumped on every measured-clean persist, for any file) is the
//       closest honest proxy for "was anything re-measured after these
//       tests were added."
//   (b) missingContractCount — among the newly-introduced case lines, at
//       least one still lacks an adjacent `// test-contract: …` marker.
//       Reuses checks/test-legitimacy.ts's OWN missing-contract detection
//       (not a second definition of the same check) and
//       pre-block-gate.ts's introduced-only multiset diff
//       (`splitIntroduced`), so a PRE-EXISTING missing marker elsewhere in
//       the file never counts against THIS session's edit — the
//       bio-orchestrator-wall lesson pre-block-gate.ts was built to fix.
//
// Warn-only; stderr; NEVER blocks — the same "lever held in reserve" stance
// as every other nudge in this family. No new session-state capture: reads
// only already-recorded `files_written` / `file_write_times` /
// `git_session_baseline.head_sha`.
//
// No git HEAD sha (non-git working tree, or the SessionStart capture
// failed) ⇒ no reliable before/after anchor for "new" vs "pre-existing" ⇒
// the whole detector stays silent for that session, rather than guessing.
//
// Per-runner reality (NOT verified in this change — see
// docs/design/luna-gate-audit-2026-08-14.md §3(b)'s own caveat): Stop is a
// session-lifecycle hook, not per-tool-call. Whether a given foreign runner
// (Codex CLI, Copilot, Gemini) fires an equivalent end-of-session hook at
// all — and, if so, whether the harness's Stop branch actually runs for it
// — was not re-verified here. Confirmed reachable: Claude Code (the daemon's
// primary Stop surface, exercised by lifecycle-stop-warnings.test.ts).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { countTestCaseOpeners } from "./check-evidence/case-parser.js";
import { getExtension, JS_TS_EXTS } from "./checks/shared.js";
import { checkTestLegitimacy, MUTATION_DIRECTED_PATH } from "./checks/test-legitimacy.js";
import { loadSurvivorsIndex } from "./mutation/survivors-index.js";
import { splitIntroduced } from "./pre-block-gate.js";
import type { ServerRuntime } from "./server/runtime-context.js";
import {
	loadStopDigestState,
	priorSnapshot,
	wasTagReported,
} from "./stop-digest-state.js";
import type { HarnessEvent, SessionTrajectory } from "./types.js";

const GIT_TIMEOUT_MS = 1_500;

/** Prefix of `checkTestLegitimacy`'s own missing-contract finding text
 *  (checks/test-legitimacy.ts's `pushMissingContract`) — matched, not
 *  reimplemented, so the two checks can never drift apart on what "missing a
 *  test-contract marker" means. */
const MISSING_CONTRACT_PREFIX = "missing test-contract for mutation-directed case:";

const MUTATION_KILL_EVIDENCE_MAX_SHOWN = 5;

/** This check's `[interlinked:<tag>]` prefix. Named once so the warning text
 *  and the digest's per-session "already reported" record cannot drift. */
const MUTATION_KILL_EVIDENCE_TAG = "mutation-kill-evidence";

/** `git show <ref>` content-reader shape — injected so tests never shell out
 *  to a real git process. Returns null on any failure (path absent from
 *  that tree, no HEAD, git missing). */
type GitShowReader = (cwd: string, ref: string) => string | null;

/** Default {@link GitShowReader} — mirrors
 *  evaluator/commit-baseline-gate.ts's `gitShow`: fail-open by design. A
 *  null baseline is read as "0 pre-session cases"
 *  (pre-block-gate.ts's STRICT DEGRADE), which is exactly correct for a
 *  file created fresh this session. */
function defaultGitShow(cwd: string, ref: string): string | null {
	try {
		return execFileSync("git", ["-C", cwd, "show", ref], {
			encoding: "utf-8",
			timeout: GIT_TIMEOUT_MS,
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch {
		return null;
	}
}

function defaultReadFile(absPath: string): string | null {
	try {
		if (existsSync(absPath)) return readFileSync(absPath, "utf-8");
	} catch (err) {
		void err; // unreadable — treat as "can't tell", caller skips the file.
	}
	return null;
}

/** Narrowed to the one field this detector reads. Both a real `MutationManifest`
 *  and a `SurvivorsIndex` satisfy this structurally, so tests can fake
 *  `{ authoritativeAt }` without constructing either. */
function defaultLoadMeasurement(interlinkedDir: string): { authoritativeAt?: string } | null {
	// Reads the SIDECAR, never the manifest. A fresh parse of the ~44MB manifest
	// inside the daemon costs ~1.7GB transient heap and stays ~1.7GB resident in
	// the loader's cache — the 2026-08-16 daemon killer. The stale-tolerant
	// loader only lowered the re-parse frequency; the sidecar removes the
	// manifest from this path entirely (see mutation/survivors-index.ts). The
	// sidecar is written in the same operation as the manifest, so
	// `authoritativeAt` here is the same value the manifest carries.
	//
	// Absent sidecar ⇒ null ⇒ the caller treats measurement as unknown, exactly
	// as it already did for an absent manifest. Silent, zero-FP.
	return loadSurvivorsIndex(interlinkedDir);
}

export interface MutationKillEvidenceHit {
	/** Repo-relative path (POSIX), for display. */
	file: string;
	/** Test-case openers present now but not in the session-start baseline. */
	newCaseCount: number;
	/** True when no mutation measurement (manifest `authoritativeAt`) postdates
	 *  this session's last write to the file. */
	staleMeasurement: boolean;
	/** Newly-introduced case lines still missing an adjacent test-contract marker. */
	missingContractCount: number;
}

/** Newly-introduced "missing test-contract" findings only — pre-existing
 *  instances elsewhere in the file must never count against THIS session's
 *  edit. */
function newMissingContractCount(
	currentContent: string,
	baselineContent: string,
	filePath: string,
): number {
	const current = checkTestLegitimacy(currentContent, filePath).filter((m) =>
		m.text.startsWith(MISSING_CONTRACT_PREFIX),
	);
	if (current.length === 0) return 0;
	const baseline = checkTestLegitimacy(baselineContent, filePath).filter((m) =>
		m.text.startsWith(MISSING_CONTRACT_PREFIX),
	);
	return splitIntroduced(current, baseline).introduced.length;
}

interface DetectMutationKillEvidenceGapsOpts {
	filesWritten: ReadonlySet<string>;
	fileWriteTimes: ReadonlyMap<string, string>;
	/** Session-start HEAD sha (`git_session_baseline.head_sha`); empty/undefined
	 *  ⇒ no reliable before/after anchor ⇒ detector returns no hits. */
	gitHeadSha: string | undefined;
	cwd: string;
	/** Injected for testing; defaults to a real `git show <ref>` shell-out. */
	gitShow?: GitShowReader;
	/** Injected for testing; defaults to a real `readFileSync`. Returns null
	 *  when the file doesn't exist or can't be read. */
	readFile?: (absPath: string) => string | null;
	/** Injected for testing. Defaults to {@link defaultLoadMeasurement}, which
	 *  reads the survivors-index SIDECAR — NOT the manifest (the name predates
	 *  the 2026-08-16 switch; the manifest is no longer on any daemon Stop path).
	 *  Returns null when no measurement record exists, which the detector reads
	 *  as "never measured". */
	loadMutationManifest?: (interlinkedDir: string) => { authoritativeAt?: string } | null;
}

/**
 * Public — Stop-time scan of the files written this session for
 * mutation-directed test files (`*.mutation-kill.*` / `*.mutation-hardening.*`
 * / `*.survivors?.*`) that gained new test cases with incomplete kill
 * evidence. See the module docstring for the two evidence gaps checked.
 */
export function detectMutationKillEvidenceGaps(
	opts: DetectMutationKillEvidenceGapsOpts,
): MutationKillEvidenceHit[] {
	const {
		filesWritten,
		fileWriteTimes,
		gitHeadSha,
		cwd,
		gitShow = defaultGitShow,
		readFile = defaultReadFile,
		loadMutationManifest = defaultLoadMeasurement,
	} = opts;
	if (!gitHeadSha) return [];

	const hits: MutationKillEvidenceHit[] = [];
	const seen = new Set<string>();
	// Lazy, resolved at most once across the whole scan — shared via this
	// mutable box so the per-entry helper can memoize without becoming a
	// closure over loop-local state.
	const measurementCache: { value: number | null | undefined } = { value: undefined };

	for (const entry of filesWritten) {
		const abs = resolveMutationDirectedWrite(entry, cwd, seen);
		if (abs === null) continue;
		const hit = evaluateMutationKillEvidence(entry, abs, {
			cwd,
			gitHeadSha,
			gitShow,
			readFile,
			fileWriteTimes,
			loadMutationManifest,
			measurementCache,
		});
		if (hit !== null) hits.push(hit);
	}

	return hits;
}

/**
 * Resolves one `filesWritten` entry to its dedup'd, in-scope absolute path,
 * or null when the entry should be skipped this scan (already seen, not a
 * JS/TS file, or not under the mutation-directed naming convention).
 */
function resolveMutationDirectedWrite(
	entry: string,
	cwd: string,
	seen: Set<string>,
): string | null {
	const abs = resolve(cwd, entry);
	if (seen.has(abs)) return null;
	seen.add(abs);

	if (!JS_TS_EXTS.has(getExtension(abs))) return null;
	const posixAbs = abs.replace(/\\/g, "/");
	if (!MUTATION_DIRECTED_PATH.test(posixAbs)) return null;
	return abs;
}

/** Lazily resolves + memoizes the mutation-measurement timestamp for one scan. */
function resolveMeasurementMs(
	cwd: string,
	loadMutationManifest: NonNullable<DetectMutationKillEvidenceGapsOpts["loadMutationManifest"]>,
	cache: { value: number | null | undefined },
): number | null {
	if (cache.value === undefined) {
		const manifest = loadMutationManifest(join(cwd, ".interlinked"));
		const ms = manifest?.authoritativeAt ? Date.parse(manifest.authoritativeAt) : NaN;
		cache.value = Number.isNaN(ms) ? null : ms;
	}
	return cache.value;
}

/**
 * Evaluates one in-scope, dedup'd written file for the two evidence gaps
 * (stale measurement / missing test-contract marker). Returns the hit, or
 * null when the file has no new cases or has complete evidence.
 */
function evaluateMutationKillEvidence(
	entry: string,
	abs: string,
	ctx: {
		cwd: string;
		gitHeadSha: string;
		gitShow: GitShowReader;
		readFile: NonNullable<DetectMutationKillEvidenceGapsOpts["readFile"]>;
		fileWriteTimes: ReadonlyMap<string, string>;
		loadMutationManifest: NonNullable<DetectMutationKillEvidenceGapsOpts["loadMutationManifest"]>;
		measurementCache: { value: number | null | undefined };
	},
): MutationKillEvidenceHit | null {
	const currentContent = ctx.readFile(abs);
	if (currentContent === null) return null; // deleted / unreadable — can't tell

	const relPath = relative(ctx.cwd, abs).replace(/\\/g, "/");
	const baselineContent = ctx.gitShow(ctx.cwd, `${ctx.gitHeadSha}:${relPath}`) ?? "";

	const newCaseCount = Math.max(
		0,
		countTestCaseOpeners(currentContent) - countTestCaseOpeners(baselineContent),
	);
	if (newCaseCount === 0) return null; // no new cases — maintenance edit, stay silent

	const measurementMs = resolveMeasurementMs(ctx.cwd, ctx.loadMutationManifest, ctx.measurementCache);
	const writeTimeRaw = ctx.fileWriteTimes.get(entry) ?? ctx.fileWriteTimes.get(abs);
	const writeMs = writeTimeRaw ? Date.parse(writeTimeRaw) : NaN;
	const staleMeasurement = Number.isNaN(writeMs)
		? false // can't determine write time — don't claim staleness
		: measurementMs === null || measurementMs < writeMs;

	const missingContractCount = newMissingContractCount(currentContent, baselineContent, abs);

	if (staleMeasurement || missingContractCount > 0) {
		return { file: relPath, newCaseCount, staleMeasurement, missingContractCount };
	}
	return null;
}

/**
 * Public — pure formatter for the mutation-kill-evidence Stop nudge. Returns
 * null when there are no hits. Re-exported from verification-stop-checks.ts.
 */
export function formatMutationKillEvidenceWarning(
	hits: ReadonlyArray<MutationKillEvidenceHit>,
): string | null {
	if (hits.length === 0) return null;
	const shown = hits.slice(0, MUTATION_KILL_EVIDENCE_MAX_SHOWN);
	const lines = shown.map((h) => {
		const reasons: string[] = [];
		if (h.staleMeasurement) reasons.push("no mutation measurement since this edit");
		if (h.missingContractCount > 0) {
			reasons.push(`${h.missingContractCount} new case(s) missing a test-contract marker`);
		}
		return `  - ${h.file}: +${h.newCaseCount} new case(s) — ${reasons.join("; ")}`;
	});
	const more =
		hits.length > MUTATION_KILL_EVIDENCE_MAX_SHOWN
			? `\n  ...and ${hits.length - MUTATION_KILL_EVIDENCE_MAX_SHOWN} more`
			: "";
	return (
		`[interlinked:mutation-kill-evidence] Stopping with ${hits.length} mutation-directed test ` +
		`file(s) (*.mutation-kill.* / *.mutation-hardening.* / *.survivors?.*) carrying newly-` +
		`introduced case(s) with incomplete kill evidence:\n${lines.join("\n")}${more}\n` +
		"A new case in one of these files is a claim that it kills a mutant — that claim is only " +
		"as good as the measurement or marker behind it. Re-run the mutation measurement for the " +
		"file(s) these tests target, or add a `// test-contract: <kind> — <rationale>` marker above " +
		"each case, before stopping."
	);
}

/**
 * PIPELINE AWARENESS: a mutation measurement is not instant, so a second Stop
 * while one is still owed does not need the full explanation again — the agent
 * has already read it and cannot act faster by being told twice. Returns the
 * one-line acknowledgment when this tag was reported at a PRIOR Stop of this
 * session, else null (meaning: print the full warning).
 *
 * Reads the digest's existing per-session tag record (stop-digest-state.ts).
 * No new state field anywhere, and no new capture on the hook path.
 */
function acknowledgedRepeatLine(opts: {
	cwd: string;
	sessionId: string;
	hitCount: number;
}): string | null {
	const prior = priorSnapshot(loadStopDigestState(join(opts.cwd, ".interlinked")), opts.sessionId);
	if (!wasTagReported(prior, MUTATION_KILL_EVIDENCE_TAG)) return null;
	return `[interlinked:${MUTATION_KILL_EVIDENCE_TAG}] ${opts.hitCount} file(s) still awaiting measurement (reported at previous stop).`;
}

/**
 * Stop-event wiring for this check — co-located with the detector it drives,
 * the same shape `checkDeadOnArrival` (dead-on-arrival.ts) uses. Lives here
 * rather than in server/lifecycle-stop-warnings.ts so the detector, its
 * formatter, and the one call site that joins them stay in one file.
 * Reflection only: it returns a warning string, it never blocks.
 */
export function checkMutationKillEvidence(
	ctx: ServerRuntime,
	event: HarnessEvent,
	session: SessionTrajectory,
): string | null {
	const cwd = event.cwd || ctx.cwd;
	const hits = detectMutationKillEvidenceGaps({
		filesWritten: session.files_written,
		fileWriteTimes: session.file_write_times,
		gitHeadSha: session.git_session_baseline?.head_sha,
		cwd,
	});
	const warning = formatMutationKillEvidenceWarning(hits);
	if (warning === null) return null;
	ctx.log(`Verify-before-stop: ${MUTATION_KILL_EVIDENCE_TAG} (${hits.length} file(s))`);
	const repeat = acknowledgedRepeatLine({
		cwd,
		sessionId: session.session_id,
		hitCount: hits.length,
	});
	return repeat ?? warning;
}
