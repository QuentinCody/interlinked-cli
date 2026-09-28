// interlinked-tdd: exempt
// ===========================================
// PostToolUse pipeline — edited-path resolution
// ===========================================
// Leaf helper split verbatim out of `post-tool-pipeline.ts` to keep the
// orchestrator under the per-file line cap. Resolves which file(s) a
// PostToolUse edited (direct-edit declared paths or a source path scanned out
// of a Bash command). No module-private state — depends only on its argument
// + imports.

import { isReadOnlyToolName } from "../../lib/hook-read-only-tools.js";
import { resolve } from "node:path";
import { isDirectFileEditTool } from "../../lib/write-tool-registry.js";
import { detectBashCodeFileWrite } from "../pre-checks-bash-write-detect.js";
import { extractAllEditedFilePaths } from "../server-tool-helpers.js";
import type { HarnessEvent } from "../types.js";

/** Tool names whose payload is a shell command that may edit files. */
const SHELL_TOOLS = ["Bash", "Shell", "shell", "run_command", "exec_command"];

/** Directory segments whose contents are GENERATED — never worth analyzing. */
const GENERATED_DIR_SEGMENTS = [
	"dist",
	"build",
	"node_modules",
	"coverage",
	".wrangler",
	".stryker-tmp",
	// Dotless twin of the above. Stryker's sandbox directory is only called
	// `.stryker-tmp` by DEFAULT — `tempDirName` renames it, and a sweep that
	// gives each run its own sandbox necessarily does. The contents are just as
	// generated (a full tree copy per run), so matching only the dotted form
	// left ~1GB of copied tree analyzable: measured 2026-08-04 as a 936MB RSS
	// spike in the daemon ledger plus anti-stomp restart churn.
	"stryker-tmp",
	".next",
	"out",
];

/**
 * Generated build artifacts must never enter the quality pipeline.
 *
 * The bash extractor used to match ANY source-looking path, so `rg -c …
 * dist/index.js` fed a 25,000-line bundle to the full inline-check family —
 * clone detection and AST parses over 300KB of generated code. Ledgered
 * 2026-07-28 as +922MB…+1078MB heap spikes in single 30s ticks ending in
 * row-less daemon deaths (OOM): the direct mechanism behind "the harness
 * keeps going down". Analyzing a bundle also has zero value — findings in
 * generated output are not actionable by editing it.
 *
 * Exported as the ONE generated-artifact predicate: the test corpus pins it
 * directly, and any other surface that fans analyzers over paths should
 * consult it rather than grow a second segment list.
 */
export function isGeneratedArtifactPath(path: string): boolean {
	const norm = path.replace(/\\/g, "/");
	if (/\.min\.[cm]?js$/.test(norm)) return true;
	const segments = norm.split("/");
	return segments.some((s) => GENERATED_DIR_SEGMENTS.includes(s));
}

/** The set of files a PostToolUse should fan its quality pipeline across,
 *  plus whether the triggering tool was a direct file edit and whether any
 *  checks should run at all. */
export interface EditedPathResolution {
	/** First/primary edited file (back-compat single-path value). */
	readonly editedFilePath: string;
	/** Full fan-out set — Codex `apply_patch` can carry multiple file sections. */
	readonly editedFilePaths: string[];
	readonly isDirectFileEdit: boolean;
	readonly shouldRunChecks: boolean;
}

function resolveDeclaredPaths(event: HarnessEvent, isDirectFileEdit: boolean, includeGenerated: boolean): string[] {
	if (isDirectFileEdit) {
		return extractAllEditedFilePaths(event).filter((path) => includeGenerated || !isGeneratedArtifactPath(path));
	}
	if (!event.tool_name || !SHELL_TOOLS.includes(event.tool_name)) return [];
	const cmd = typeof event.tool_input?.command === "string" ? event.tool_input.command : "";
	// Reuse the deterministic write detector. The old fallback matched the
	// first source-looking token in ANY shell command, so read-only inspection
	// such as `sed -n ... cloud-runner.ts` entered the full post-edit pipeline
	// and emitted capacity-deferral warnings while another agent held the
	// compiler lease. Mentioning a file is not evidence of writing it.
	const write = detectBashCodeFileWrite(cmd);
	if (write === null || (!includeGenerated && isGeneratedArtifactPath(write.target))) return [];
	return [write.target];
}

/**
 * Paths the post-call filesystem comparison observed, ATTRIBUTED to this call.
 *
 * A tool with no write capability contributes NONE of them. The ChangeSet is a
 * diff of the window the call occupied, not a record of what the call did — so
 * on a Read / Grep / WebFetch every path in it was written by somebody else
 * (another agent on the same tree, a background test run, a watcher). Charging
 * those to the reader ran the whole per-file pipeline — `affected_tests` shells
 * out to vitest — on a call that changed nothing: measured as a ~21s `rg` that
 * reported a test failure it did not cause.
 *
 * Bash is NOT read-only and keeps its ChangeSet: a shell command's effects are
 * only knowable post-call, and the bash-edit obligation gate is built on it.
 * The read-only set lives in `lib/hook-read-only-tools.ts`, shared with the
 * generated `.mjs` runtime's fast path.
 */
function observedPaths(event: HarnessEvent, includeGenerated: boolean): string[] {
	if (isReadOnlyToolName(event.tool_name)) return [];
	return (event.change_set?.files ?? [])
		.map((effect) => effect.path)
		.filter((path) => includeGenerated || !isGeneratedArtifactPath(path));
}

/**
 * Resolve which file(s) this PostToolUse edited. Direct edits use the tool's
 * declared paths (Codex `apply_patch` may carry several); Bash/shell commands
 * are scanned for an edited source path so sed/awk/tee edits still get checked.
 *
 * Which tools count as a direct edit comes from `lib/write-tool-registry.ts`,
 * the SAME table the Claude Code adapter builds its PostToolUse matcher from.
 * Two hand-maintained lists is what let `MultiEdit` be registered by the adapter
 * and then dropped here: no ChangeSet meant zero paths and `shouldRunChecks:
 * false` (the whole per-file pass skipped), and a ChangeSet meant
 * `isDirectFileEdit: false`, which handed a pre-write-GATED edit to the
 * bash-channel obligation gate.
 */
export function resolveEditedPaths(event: HarnessEvent, includeGenerated = false): EditedPathResolution {
	const isDirectFileEdit = isDirectFileEditTool(event.tool_name);
	const effects = observedPaths(event, includeGenerated);
	const editedFilePaths = effects.length > 0
		? effects
		: resolveDeclaredPaths(event, isDirectFileEdit, includeGenerated);
	const editedFilePath = editedFilePaths[0] || "";
	const shouldRunChecks = isDirectFileEdit || editedFilePaths.length > 0;
	return { editedFilePath, editedFilePaths, isDirectFileEdit, shouldRunChecks };
}

/** A snapshot overlap establishes observation, never authorship. */
export function writeAttribution(event: HarnessEvent, file: string, cwd: string): "declared-target" | "observed-workspace" {
	const targets = resolveDeclaredPaths(event, isDirectFileEditTool(event.tool_name), true);
	return targets.some(target => resolve(cwd, target) === resolve(cwd, file))
		? "declared-target" : "observed-workspace";
}
