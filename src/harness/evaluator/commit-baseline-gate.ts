// ===========================================
// PreToolUse Bash gate — COMMIT-TIME baseline-integrity backstop
// ===========================================
//
// The edit-time gate (`baseline-integrity-gate.ts`) blocks an agent hand-LOOSENING
// a ratchet water-line at Write/Edit time. This backstop closes the residual hole:
// an agent could stage a loosened baseline through a path the write gate didn't
// reconstruct (an apply_patch, a sub-agent, a manual editor) and then `git commit`
// it. On a real `git commit` we diff the pre-commit tree vs the content the commit
// WILL carry for each git-TRACKED baseline through the SAME pure
// `detectBaselineGaming` detector and block the commit if the change loosens a
// water-line.
//
// Red-team 2026-10-21 hardened two holes in the original "HEAD vs index" model:
//   1. DELETE-THEN-READD: `git rm <baseline> && git commit`, then re-add a loosened
//      copy. The deletion passed (nothing staged to compare) and the re-add passed
//      (HEAD lacked the file, so before="" read as a brand-new baseline). Now a
//      commit that DELETES a tracked water-line blocks outright (every bound →
//      infinity), and a re-add is compared against the LAST COMMITTED version in
//      history, falling back to "new baseline" only when the path never existed.
//      Worktree-sourced commits (`-a`, `git add -A`, pathspecs) read the worktree,
//      so `rm X && git commit -a` is the same deletion.
//   2. PLUMBING-VERB COMMIT: `git write-tree` → `commit-tree` → `update-ref` never
//      says `commit`, so `parseGitCommit` saw nothing. Any plumbing verb that
//      writes trees/commits/refs is now evaluated as a commit of the index.
//
// Scope: only the baselines carved out of the `.interlinked/*` gitignore can ever
// be staged; the other baselines are gitignored local state and never appear in a
// commit. Always-on (mirrors the edit-time gate — only the
// INTERLINKED_DISABLE_BASELINE_GUARD=1 env bypass). Cheap (a few `git` reads per
// baseline, no suite). FAIL-OPEN on every uncertainty EXCEPT a provable deletion.

import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { nonNull } from "../../lib/non-null.js";
import { readToolString } from "./tool-input-values.js";
import type { HarnessDecision, HarnessEvent } from "../types.js";
import { pointerIdsIn } from "../packets/release.js";
import { parsePacketFile } from "../packets/schema.js";
import { isGlobalSource, resolveSourcePath } from "../packets/source-path.js";
import type { SourceReader } from "../packets/water-line.js";
import { detectBaselineGaming } from "./baseline-integrity-gate.js";
import { detectMetricPolicyLoosening, METRIC_POLICY_CONTROL_FILES } from "./metric-policy-integrity.js";
import { rebaseConstructedPaths } from "./commit-gate-changes.js";
import { gitShow, resolveRepoRoot } from "./commit-git-io.js";
import {
	type CommitParse,
	GIT_PLUMBING_COMMIT_VERBS,
	GIT_PLUMBING_WORKTREE_VERBS,
	type GitInvocation,
	listGitInvocations,
	parseGitCommit,
} from "./commit-parse.js";

/** Baselines carved out of the `.interlinked/*` gitignore — the only ones that can
 *  stage. The other baselines are gitignored, so they never reach a commit. */
const TRACKED_BASELINES = [
	".interlinked/large-files-baseline.json",
	// Instruction packets are committed (gitignore carve-out); the same packet
	// detector judges HEAD vs the staged blob (packets/water-line.ts).
	".interlinked/instruction-packets.json",
	".interlinked/untested-files-baseline.json",
	".interlinked/metric-caps.json",
	".interlinked/skipped-tests-baseline.json",
	// Per-function complexity grandfather ledger (2026-09-01) — its sibling
	// detector lives in function-complexity-baseline-gate.ts, reached via
	// detectBaselineGaming like the disposition ledger below.
	".interlinked/function-complexity-baseline.json",
	// Mutation adjudication ledger (plan 18 M0) — committed sidecar; its monotonic
	// detector lives in disposition-ledger-gate.ts and reaches here via detectBaselineGaming.
	".interlinked/mutation-dispositions.json",
] as const;

const GIT_TIMEOUT_MS = 1_500;

/** The content this commit will carry for one baseline. */
type CommitContent = { kind: "unchanged" } | { kind: "deleted" } | { kind: "content"; text: string };

/** How the commit sources its content: the index, or the worktree (staged during the command). */
interface CommitModel {
	cwd: string | null;
	/** True when the commit stages WORKTREE bytes broadly (`-a`, `git add -A`, `update-index`). */
	worktreeBroad: boolean;
	/** Worktree paths (command-cwd relative) a narrow stage brings in; empty when broad or none. */
	worktreePaths: string[];
	/** Paths selected by a path-only commit; null when the index participates. */
	onlyPaths: string[] | null;
	/** Each preceding removal retains its own invocation directory. */
	/** `git rm` / `git mv` sources before the commit; `broad` when the paths come from a file the gate cannot see. */
	removals: Array<{ paths: string[]; cwd: string | null; broad: boolean }>;
}

/** Where the gate reads from: the repo toplevel and the command's effective directory. */
interface RepoIo {
	repoRoot: string;
	commandCwd: string;
	baseCwd: string;
}

/** `git <args>` stdout, or null on any failure (fail-open, like `gitShow`). */
function gitRead(repoRoot: string, args: string[]): string | null {
	try {
		return execFileSync("git", ["-C", repoRoot, ...args], {
			encoding: "utf-8",
			timeout: GIT_TIMEOUT_MS,
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch {
		return null;
	}
}

/** `realpathSync(p)`, or `p` itself when it cannot be resolved (fail-open). */
function realPath(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
}

/** The positional pathspecs of a `git rm` invocation (flags skipped, `--` honored). */
function rmPathspecs(inv: GitInvocation): string[] {
	const dash = inv.args.indexOf("--");
	if (dash >= 0) return inv.args.slice(dash + 1);
	return inv.args.filter((a) => !a.startsWith("-"));
}

/** The paths a `git rm` or `git mv` takes away from where they are; null when they come from a file
 *  (`--pathspec-from-file`, review-100 n19), which the gate must treat as the whole tree. A `git mv` moves every
 *  positional but the last (the destination) away (n21); a dry run (`-n`, `--dry-run`) moves nothing. */
function removalPathspecs(inv: GitInvocation): string[] | null {
	if (inv.args.some((a) => a.startsWith("--pathspec-from-file"))) return null;
	if (inv.verb === "rm") return rmPathspecs(inv);
	if (inv.args.includes("-n") || inv.args.includes("--dry-run")) return [];
	return rmPathspecs(inv).slice(0, -1);
}

/** Worktree paths a `git add` stages, or null when it stages broadly (`-A`, `-u`, from-file). */
function addPathspecs(inv: GitInvocation): string[] | null {
	if (inv.args.some((a) => a.startsWith("--pathspec-from-file"))) return null;
	const paths = rmPathspecs(inv);
	return paths.length === 0 ? null : paths;
}

/** Hashing without -w reads bytes but creates no Git object or commit state. */
function writesPlumbingState(inv: GitInvocation): boolean {
	if (!GIT_PLUMBING_COMMIT_VERBS.has(inv.verb)) return false;
	return inv.verb !== "hash-object" || inv.args.includes("-w");
}

/** Build the commit model from the porcelain parse and/or the plumbing invocations. */
function commitModel(parse: CommitParse | null, invocations: GitInvocation[]): CommitModel | null {
	const plumbing = invocations.filter(writesPlumbingState);
	if (!parse?.isCommit && plumbing.length === 0) return null;
	const commitAt = invocations.findIndex((i) => i.verb === "commit");
	const preceding = commitAt < 0 ? invocations : invocations.slice(0, commitAt);
	const removals = preceding
		.filter((i) => i.verb === "rm" || i.verb === "mv")
		.map((i) => {
			const paths = removalPathspecs(i);
			return { paths: paths ?? [], cwd: i.cwd, broad: paths === null };
		});
	// A porcelain commit already folds its `git add` segments into the parse (with
	// git's --only/--include semantics). A plumbing commit has no parse, so a
	// `git add <baseline>` in the same command stages WORKTREE bytes the index does
	// not hold yet (the red-team record's own first line).
	const adds = parse?.isCommit ? [] : invocations.filter((i) => i.verb === "add").map(addPathspecs);
	const worktreeBroad =
		parse?.all === true ||
		(parse?.constructsContent === true && (parse.constructedPaths ?? []).length === 0) ||
		plumbing.some((i) => GIT_PLUMBING_WORKTREE_VERBS.has(i.verb)) ||
		adds.some((p) => p === null);
	return {
		cwd: parse?.cwd ?? plumbing[0]?.cwd ?? null,
		worktreeBroad,
		worktreePaths: [...(parse?.constructedPaths ?? []), ...adds.flatMap((p) => p ?? [])],
		// A constructed commit without paths was already classified as broad above.
		onlyPaths: parse?.constructsContent && !parse.includesIndex && !worktreeBroad ? nonNull(parse.constructedPaths) : null,
		removals,
	};
}

/** True when one of `specs` (rebased onto the repo root) names `rel` or an ancestor dir. */
function specsCover(specs: string[], io: RepoIo, rel: string): boolean {
	if (specs.length === 0) return false;
	const rebased = rebaseConstructedPaths(specs, io.commandCwd, io.repoRoot);
	if (rebased === null) return true; // repo root / unresolvable → broad
	return rebased.some((p) => p === rel || rel.startsWith(`${p}/`));
}

/** The worktree bytes of `rel`, or null when the file is absent. */
function readWorktree(repoRoot: string, rel: string): string | null {
	try {
		return readFileSync(resolve(repoRoot, rel), "utf-8");
	} catch {
		return null;
	}
}

/** A removal affects this repository only, relative to the rm invocation. */
function removesBaseline(model: CommitModel, io: RepoIo, rel: string): boolean {
	return model.removals.some((removal) => {
		const commandCwd = realPath(removal.cwd ? resolve(io.baseCwd, removal.cwd) : io.baseCwd);
		if (resolveRepoRoot(commandCwd) !== io.repoRoot) return false;
		return removal.broad || specsCover(removal.paths, { ...io, commandCwd }, rel);
	});
}

/** What this commit will carry for `rel`, given the pre-commit index and HEAD blobs. */
function commitContentFor(
	model: CommitModel,
	io: RepoIo,
	rel: string,
	staged: string | null,
	head: string | null,
): CommitContent {
	if (model.onlyPaths !== null && !specsCover(model.onlyPaths, io, rel)) return { kind: "unchanged" };
	const tracked = staged !== null || head !== null;
	if (removesBaseline(model, io, rel)) {
		return tracked ? { kind: "deleted" } : { kind: "unchanged" };
	}
	const fromWorktree = model.worktreeBroad || specsCover(model.worktreePaths, io, rel);
	if (fromWorktree) {
		const wt = readWorktree(io.repoRoot, rel);
		if (wt === null) return tracked ? { kind: "deleted" } : { kind: "unchanged" };
		return wt === head ? { kind: "unchanged" } : { kind: "content", text: wt };
	}
	if (staged === null) return head !== null ? { kind: "deleted" } : { kind: "unchanged" };
	return staged === head ? { kind: "unchanged" } : { kind: "content", text: staged };
}

/**
 * The last committed version of `rel` when HEAD no longer carries it: the commit
 * that last touched the path is its deletion, so its first parent holds the
 * final content. Null when the path never existed in history (a genuinely new
 * baseline) or git cannot answer.
 */
function lastCommittedVersion(repoRoot: string, rel: string): { text: string; commit: string } | null {
	const sha = gitRead(repoRoot, ["rev-list", "-1", "HEAD", "--", rel])?.trim();
	if (!sha) return null;
	const text = gitShow(repoRoot, `${sha}^:${rel}`);
	return text === null ? null : { text, commit: sha.slice(0, 7) };
}

/** Findings for one tracked baseline, as `[rule] message` lines. */
function baselineFindings(model: CommitModel, io: RepoIo, rel: string): string[] {
	const staged = gitShow(io.repoRoot, `:${rel}`);
	const head = gitShow(io.repoRoot, `HEAD:${rel}`);
	const content = commitContentFor(model, io, rel, staged, head);
	if (content.kind === "unchanged") return [];
	if (content.kind === "deleted") {
		return [
			`[deleted] ${rel} is deleted by this commit: every water-line it holds would be removed, the maximal loosening. Restore the file (re-adding a loosened copy later is compared against this version).`,
		];
	}
	const base = head !== null ? { text: head, commit: null } : lastCommittedVersion(io.repoRoot, rel);
	if (base === null) return []; // never existed in history → new baseline, never a loosening
	const note = base.commit ? ` (compared against the last committed version, ${base.commit}; HEAD no longer carries the file)` : "";
	// The packet file's releases are vouched for by the instruction files AS THIS COMMIT CARRIES THEM, not by
	// unstaged worktree bytes (audit C2: identical trees used to get opposite verdicts).
	const packets = rel === PACKET_FILE ? { origin: "recorded" as const, readSource: committedReader(model, io) } : undefined;
	return detectBaselineGaming(resolve(io.repoRoot, rel), base.text, content.text, undefined, undefined, packets).map(
		(f) => `[${f.rule}] ${f.message}${note}`,
	);
}

const PACKET_FILE = ".interlinked/instruction-packets.json";

/** A file's text as this commit will carry it: its committed bytes when the commit changes it, else HEAD's; an
 *  untracked or home-relative (`~/`) instruction file is not in any commit, so the disk is its only truth. */
function committedText(model: CommitModel, io: RepoIo, rel: string): string | null {
	if (isGlobalSource(rel)) return readWorktree(io.repoRoot, resolveSourcePath(io.repoRoot, rel));
	const head = gitShow(io.repoRoot, `HEAD:${rel}`);
	const content = commitContentFor(model, io, rel, gitShow(io.repoRoot, `:${rel}`), head);
	if (content.kind === "content") return content.text;
	if (content.kind === "deleted") return null;
	return head ?? readWorktree(io.repoRoot, rel);
}

function committedReader(model: CommitModel, io: RepoIo): SourceReader {
	return (file) => committedText(model, io, file);
}

/** Policy controls are judged conditionally, so deleting a historical check-only file stays allowed. */
function metricPolicyFindings(model: CommitModel, io: RepoIo, rel: string): string[] {
	const head = gitShow(io.repoRoot, `HEAD:${rel}`);
	const content = commitContentFor(model, io, rel, gitShow(io.repoRoot, `:${rel}`), head);
	if (content.kind === "unchanged") return [];
	const prior = head ?? lastCommittedVersion(io.repoRoot, rel)?.text ?? null;
	const after = content.kind === "deleted" ? null : content.text;
	return detectMetricPolicyLoosening(resolve(io.repoRoot, rel), prior, after, {
		root: io.repoRoot,
		readBefore: path => gitShow(io.repoRoot, `HEAD:${path}`) ?? readWorktree(io.repoRoot, path),
		readAfter: committedReader(model, io),
	}).map(finding => `[${finding.rule}] ${finding.message}`);
}

/** Repo-relative paths this commit may carry changed: the index's, plus the worktree's when the commit stages
 *  worktree bytes (untracked files too when broadly). Bounded: past the cap the list is reported truncated, never
 *  cut silently (a pointer file sorting after the cap would go unscanned). A git error yields what was read. */
function changedPaths(model: CommitModel, io: RepoIo): { paths: string[]; truncated: boolean } {
	const list = (args: string[]) => (gitRead(io.repoRoot, args) ?? "").split("\0").filter(Boolean);
	const out = new Set(list(["diff", "--cached", "--name-only", "-z"]));
	if (model.worktreeBroad || model.worktreePaths.length > 0 || model.onlyPaths !== null) for (const p of list(["diff", "--name-only", "-z"])) out.add(p);
	if (model.worktreeBroad) for (const p of list(["ls-files", "--others", "--exclude-standard", "-z"])) out.add(p);
	const paths = [...out];
	return { paths: paths.slice(0, MAX_POINTER_SCAN), truncated: paths.length > MAX_POINTER_SCAN };
}
const MAX_POINTER_SCAN = 500;

type PacketSetView = Pick<Extract<ReturnType<typeof parsePacketFile>, { ok: true }>["value"], "packets" | "sources">;

/** The packet set the commit carries. No packet file in the commit (absent from HEAD and the index, or deleted)
 *  is an empty set: no pointer it carries has a release. An unparsable file is null (judged elsewhere). */
function committedPacketSet(packetText: string | null): PacketSetView | null {
	if (packetText === null) return { packets: [], sources: {} };
	const parsed = parsePacketFile(packetText);
	return parsed.ok ? parsed.value : null;
}

function truncationFindings(truncated: boolean): string[] {
	if (!truncated) return [];
	return [`[pointer-scan-truncated] this commit changes more than ${MAX_POINTER_SCAN} paths, so the gate cannot check every changed file for a packet pointer without a release in ${PACKET_FILE}. Commit the instruction files and ${PACKET_FILE} in a smaller commit.`];
}

/** Every pointer an instruction file will carry must be backed by a release in the packet file the commit
 *  carries; otherwise the committed tree holds neither the words nor anything that hands them back (audit C2:
 *  `git add CLAUDE.md && git commit`, or `git commit CLAUDE.md`, after a release). Checked only when the commit
 *  changes the packet file or that instruction file — an untouched pair is HEAD's business. */
function pointerFindings(model: CommitModel, io: RepoIo): string[] {
	const packetHead = gitShow(io.repoRoot, `HEAD:${PACKET_FILE}`);
	const packetChange = commitContentFor(model, io, PACKET_FILE, gitShow(io.repoRoot, `:${PACKET_FILE}`), packetHead);
	const packetText = packetChange.kind === "content" ? packetChange.text : packetChange.kind === "unchanged" ? packetHead : null;
	const set = committedPacketSet(packetText);
	if (set === null) return [];
	const releasedIn = new Map(set.packets.filter((p) => p.release !== null).map((p) => [p.id, p.source.file]));
	const changed = changedPaths(model, io);
	const out = truncationFindings(changed.truncated);
	// Every file the set names, plus every path the commit changes: a renamed instruction file carries its pointer
	// under a name no packet records (break R4 #10).
	const named = [...Object.keys(set.sources), ...set.packets.map((p) => p.source.file)];
	const candidates = new Set([...named, ...changed.paths].filter((f) => f !== PACKET_FILE && !isGlobalSource(f)));
	for (const file of candidates) {
		const head = gitShow(io.repoRoot, `HEAD:${file}`);
		const change = commitContentFor(model, io, file, gitShow(io.repoRoot, `:${file}`), head);
		if (change.kind !== "content" && packetChange.kind !== "content") continue;
		const text = change.kind === "content" ? change.text : change.kind === "unchanged" ? head : null;
		for (const id of pointerIdsIn(text ?? "")) {
			if (releasedIn.get(id) === file) continue;
			out.push(`[pointer-without-release:${id}] ${file} carries the pointer of packet ${id}, but the ${PACKET_FILE} this commit carries holds no release of it: the committed tree would lose the instruction's words. Commit ${PACKET_FILE} together with ${file}, or run \`interlinked packets restore ${file}\`.`);
		}
	}
	return out;
}

/**
 * Returns a `block` decision when the command is a real `git commit` (porcelain or
 * plumbing) AND the content it will commit for a tracked baseline loosens or
 * deletes a water-line; otherwise null. A pure no-op (no git shell-out) for
 * non-commit commands. Never throws (fail-open).
 */
export function checkCommitBaselineGate(event: HarnessEvent): HarnessDecision | null {
	if (process.env.INTERLINKED_DISABLE_BASELINE_GUARD === "1") return null;

	const command = readToolString(event.tool_input?.command);
	const model = commitModel(parseGitCommit(command), listGitInvocations(command));
	if (!model) return null;

	const baseCwd = event.cwd || process.cwd();
	// Real path, because `git rev-parse --show-toplevel` answers with one: through a
	// symlinked cwd (`/var/…` vs `/private/var/…` on macOS) every rebased pathspec
	// escaped the root and read as BROAD, so `git rm note.txt` deleted every baseline.
	const commandCwd = realPath(model.cwd ? resolve(baseCwd, model.cwd) : baseCwd);
	const repoRoot = resolveRepoRoot(commandCwd);
	if (!repoRoot) return null;

	const io: RepoIo = { repoRoot, commandCwd, baseCwd };
	const findings = [...TRACKED_BASELINES.flatMap((rel) => baselineFindings(model, io, rel)),
		...METRIC_POLICY_CONTROL_FILES.flatMap(rel => metricPolicyFindings(model, io, rel)), ...pointerFindings(model, io)];
	if (findings.length === 0) return null;

	return {
		decision: "block",
		reason:
			`BLOCKED: this commit stages a loosened ratchet baseline:\n  ${findings.join("\n  ")}\n\n` +
			"Ratchet water-lines may only move in the tightening direction. Unstage the baseline change, or set INTERLINKED_DISABLE_BASELINE_GUARD=1 for an intentional reset.",
		rule_id: "commit_baseline_integrity_gate",
		severity: "high",
		category: "config",
	};
}

/**
 * Pipeline wrapper (wired in pre-tool-pipeline.ts before runCommitGate). Only fires
 * while the running decision is still `allow` and the tool is Bash; merges any
 * accumulated warnings onto the block. Never throws.
 */
export function runCommitBaselineGate(
	event: HarnessEvent,
	preDecision: HarnessDecision,
): HarnessDecision | null {
	if (preDecision.decision !== "allow") return null;
	if (event.tool_name !== "Bash") return null;
	const decision = checkCommitBaselineGate(event);
	if (!decision) return null;
	if (preDecision.warnings && preDecision.warnings.length > 0) {
		decision.warnings = [...preDecision.warnings, ...(decision.warnings ?? [])];
	}
	return decision;
}
