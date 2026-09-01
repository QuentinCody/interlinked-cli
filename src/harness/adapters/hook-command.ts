// Shared shell command builder for runner settings fragments.

import { READ_ONLY_TOOL_NAMES } from "../../lib/hook-read-only-tools.js";

/**
 * What the shell fallback does when the baked hook binary is MISSING.
 *
 * Per-adapter, per-NATIVE-EVENT (review 2026-08-28 P0: a global PascalCase
 * event set silently left Copilot's `preToolUse`, Gemini's `BeforeTool`, and
 * Cursor's `beforeShellExecution` non-blocking — the caller, who knows its
 * provider's names, decides; this module only renders the decision):
 *  - `fail_closed` → known native read-only tools can still run in degraded
 *    mode; mutating and unclassified tools exit 2, the block code the provider
 *    docs describe —
 *    verified in Claude's official reference; Codex behavior is LOCALLY
 *    OBSERVED (mirrors Claude's contract, not officially documented); the
 *    ecosystem comparison (docs/hooks-ecosystem-comparison.md:84) claims the
 *    same for Cursor/Copilot/Gemini but those three lack provider-level
 *    contract tests and stay experimental. Reserve fail_closed for actual
 *    tool/permission gates — blocking Stop-class hooks risks a stop-hook loop.
 *  - `warn_open` → exit 1, a loud logged failure that does NOT claim a block
 *    it cannot deliver (exit 1 is non-blocking on every provider).
 */
type MissingRuntimePolicy = "fail_closed" | "warn_open";

const MISSING_RUNTIME_BLOCK_EXIT = 2;
const HOOK_REFRESH_COMMAND = "interlinked install-hooks --refresh --preserve-mode";

// The embedded program cannot import the CLI after that CLI has disappeared.
// Read allowances must therefore bind to a provider-owned native event and an
// exact reserved built-in name. A global `read_file`/`search` list is unsafe:
// an MCP or custom writer may use the same friendly name. Cursor's dedicated
// beforeReadFile event is handled separately because the event itself proves
// the operation. Copilot and Gemini generic tool gates have no trustworthy
// origin field, so they deliberately receive no name-based read exception.
const MISSING_RUNTIME_READ_ONLY_NAMES_BY_GATE: Readonly<Record<string, readonly string[]>> = {
	"claude-code:PreToolUse": READ_ONLY_TOOL_NAMES,
	"codex:PreToolUse": READ_ONLY_TOOL_NAMES,
};

// This program is intentionally embedded in every foreground hook command.
// It is the only code still available when the baked hook entry point is
// missing. The recovery escape is deliberately narrower than a shell parser:
// an actual shell-tool payload must carry the exact documented command. Any
// prefix, suffix, flag reordering, pipe, or compound command remains blocked.
const MISSING_RUNTIME_FALLBACK_SOURCE = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const [message, exitCodeText, runner, event, repair, binaryPath, mode] = process.argv.slice(1);
const exitCode = Number(exitCodeText);
const readOnlyNamesByGate = ${JSON.stringify(MISSING_RUNTIME_READ_ONLY_NAMES_BY_GATE)};
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const asObject = (value) => {
  if (isObject(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
};
const nativeTool = (raw) => {
  if (!isObject(raw)) return null;
  if (runner === "claude-code" || runner === "codex") {
    return typeof raw.tool_name === "string" && raw.toolName === undefined ? raw.tool_name : null;
  }
  if (runner === "copilot-cli") {
    return typeof raw.toolName === "string" && raw.tool_name === undefined ? raw.toolName : null;
  }
  if (runner === "gemini-cli") {
    return typeof raw.tool_name === "string" && raw.toolName === undefined ? raw.tool_name : null;
  }
  return null;
};
const nativeInput = (raw) => {
  if (!isObject(raw)) return null;
  if (runner === "claude-code" || runner === "codex") return asObject(raw.tool_input);
  if (runner === "copilot-cli") return asObject(raw.toolArgs);
  if (runner === "gemini-cli") return asObject(raw.tool_input) || asObject(raw.arguments);
  return null;
};
const isCanonicalBuildCheckout = () => {
  try {
    const cwd = process.cwd();
    const packagePath = path.join(cwd, "package.json");
    const buildPath = path.join(cwd, "scripts", "build-atomic-cli.mjs");
    if (!fs.statSync(packagePath).isFile() || !fs.statSync(buildPath).isFile()) return false;
    const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    const resolvedBinary = typeof binaryPath === "string" ? path.resolve(binaryPath) : "";
    const binaryDir = path.dirname(resolvedBinary);
    const binaryRoot = path.dirname(binaryDir);
    return isObject(packageJson) &&
      packageJson.name === "interlinked-cli" &&
      isObject(packageJson.scripts) &&
      packageJson.scripts.build === "node scripts/build-atomic-cli.mjs" &&
      path.basename(resolvedBinary) === "hook-entry.js" &&
      path.basename(binaryDir) === "dist" &&
      fs.realpathSync(binaryRoot) === fs.realpathSync(cwd);
  } catch {
    return false;
  }
};
const recoveryRequested = (raw) => {
  if (!isObject(raw)) return false;
  const input = nativeInput(raw);
  const command = runner === "cursor" && event === "beforeShellExecution"
    ? raw.command
    : input && input.command;
  if (typeof command !== "string" || /[;&|><\x60$(){}\n]/.test(command)) return false;
  const trimmed = command.trim();
  const cli = "(?:interlinked|npx tsx src/index[.]ts|node dist/index[.]js)";
  const exactBuild = (trimmed === "npm run build" || trimmed === "node scripts/build-atomic-cli.mjs") &&
    isCanonicalBuildCheckout();
  const exactRefresh = trimmed === repair ||
    trimmed === "interlinked install-hooks --preserve-mode --refresh" ||
    trimmed === "npx tsx src/index.ts install-hooks --refresh --preserve-mode" ||
    trimmed === "npx tsx src/index.ts install-hooks --preserve-mode --refresh" ||
    trimmed === "node dist/index.js install-hooks --refresh --preserve-mode" ||
    trimmed === "node dist/index.js install-hooks --preserve-mode --refresh";
  const status = new RegExp("^" + cli + " harness status(?: --json)?$");
  const start = new RegExp("^" + cli + " harness (?:start|restart)(?:(?: --(?:json|verbose))|(?: --protocol (?:raw|framed|dual))|(?: --session-id [A-Za-z0-9_-]{1,64})){0,8}$");
  const doctor = new RegExp("^" + cli + " doctor(?: --json)?$");
  const disable = new RegExp("^" + cli + " disable(?:(?: --team)|(?: --reason [A-Za-z0-9_./:@-]{1,80})|(?: --until [A-Za-z0-9_.:-]{1,40})|(?: --by [A-Za-z0-9_./:@-]{1,80})){0,8}$");
  if (!exactBuild && !exactRefresh && !status.test(trimmed) && !start.test(trimmed) && !doctor.test(trimmed) && !disable.test(trimmed)) return false;
  if (runner === "cursor" && event === "beforeShellExecution") return true;
  const tool = nativeTool(raw);
  const shellNames = {
    "claude-code": ["bash"],
    codex: ["bash", "shell", "exec_command"],
    "copilot-cli": ["bash", "shell"],
    "gemini-cli": ["run_shell_command"],
  }[runner];
  return typeof tool === "string" && Array.isArray(shellNames) && shellNames.includes(tool.toLowerCase());
};
const readOnlyRequested = (raw) => {
  if (!isObject(raw)) return false;
  // Cursor's dedicated event is provider-owned proof of a file read. Never
  // extend this to beforeMCPExecution/preToolUse based on a friendly name.
  if (runner === "cursor" && event === "beforeReadFile") return true;
  const permitted = readOnlyNamesByGate[runner + ":" + event];
  const tool = nativeTool(raw);
  return Array.isArray(permitted) && typeof tool === "string" && permitted.includes(tool);
};
const blockNatively = () => {
  fs.writeSync(2, message + "\n");
  if ((runner === "claude-code" || runner === "codex") && event === "PermissionRequest") {
    fs.writeSync(1, JSON.stringify({ hookSpecificOutput: { hookEventName: event, decision: { behavior: "deny", message } } }));
    process.exit(0);
  }
  if (runner === "codex" && event === "PreToolUse") {
    fs.writeSync(1, JSON.stringify({ hookSpecificOutput: { hookEventName: event, permissionDecision: "deny", permissionDecisionReason: message } }));
    process.exit(0);
  }
  if (runner === "copilot-cli" && event === "preToolUse") {
    fs.writeSync(1, JSON.stringify({ permissionDecision: "deny", permissionDecisionReason: message }));
    process.exit(0);
  }
  process.exit(exitCode);
};
let raw = null;
try {
  const text = fs.readFileSync(0, "utf8");
  raw = text === "" ? null : JSON.parse(text);
} catch {}
const wantsRecovery = recoveryRequested(raw);
if (mode === "probe") process.exit(wantsRecovery ? 0 : 1);
if (exitCode === 2 && wantsRecovery) process.exit(0);
if (exitCode === 2 && readOnlyRequested(raw)) {
  // Hook stderr is normally a pipe. A blocking write prevents process.exit(0)
  // from truncating the degraded-mode warning under parallel runner load.
  fs.writeSync(2, message + "\n");
  process.exit(0);
}
if (exitCode === 2) blockNatively();
fs.writeSync(2, message + "\n");
process.exit(exitCode);
`.trim();

// interlinked: defer same_typed_primitive_params -- the three strings are
// (path, runner-id, event-name) with no plausible swap that still runs: a
// swapped runner/event produces a hook that self-identifies wrongly on the
// FIRST invocation, and every call site is pinned by the executed-fragment
// matrix in hook-command.test.ts.
// interlinked: defer function_arg_count -- `policy` is deliberately a REQUIRED
// positional so the compiler forces every adapter to decide fail-closed vs
// warn-open per native event; an options object would keep that but churn 5
// adapters + the executed test matrix for no behavior change.
export function buildHookCommand(
	binaryPath: string,
	runner: string,
	event: string,
	policy: MissingRuntimePolicy,
): string {
	// FAIL CLOSED when the baked binary is gone (Grok 2026-08-28 issue 6): the
	// old bare `if test -f …; fi` exited 0 on a missing file, so an unbuilt or
	// moved install silently turned every hook into a no-op — an install that
	// reports success and gates nothing. The message targets installed users,
	// not this repo.
	const isFailClosed = policy === "fail_closed";
	const fallbackExit = isFailClosed ? MISSING_RUNTIME_BLOCK_EXIT : 1;
	const verb = isFailClosed
		? "allowing known read-only tools in degraded mode; blocking mutating or unclassified tool calls until repaired"
		: "hook skipped";
	const repairSteer =
		`Repair with '${HOOK_REFRESH_COMMAND}', never plain 'interlinked enable' — it rewrites enforcement mode. ` +
		"If the 'interlinked' command is unavailable, reinstall the CLI or rebuild this checkout first, then run that repair. " +
		"Alternatively, remove Interlinked's hooks from your runner settings.";
	const missingMessage =
		`[interlinked] hook binary missing or empty: ${binaryPath} — ${verb}. ${repairSteer}`;
	const runtimeFailureMessage =
		`[interlinked] hook runtime failed before returning a valid decision: ${binaryPath} — ${verb}. ${repairSteer}`;
	const runtime = runtimeInvocation(binaryPath, runner, event);
	const missingFallback = fallbackInvocation({
		binaryPath,
		message: missingMessage,
		exitCode: fallbackExit,
		runner,
		event,
	});

	return isFailClosed
		? failClosedRuntimeCommand({
				binaryPath,
				runtime,
				missingFallback,
				runtimeFailureMessage,
				runner,
				event,
			})
		: warnOpenRuntimeCommand({
				binaryPath,
				runtime,
				missingFallback,
				runtimeFailureMessage,
			});
}

interface RuntimeCommandParts {
	binaryPath: string;
	runtime: string;
	missingFallback: string;
	runtimeFailureMessage: string;
}

interface FailClosedRuntimeCommandParts extends RuntimeCommandParts {
	runner: string;
	event: string;
}

function failClosedRuntimeCommand(parts: FailClosedRuntimeCommandParts): string {
	const recoveryProbe = recoveryProbeInvocation(parts.binaryPath, parts.runner, parts.event);
	const failureFallback = fallbackInvocation({
		binaryPath: parts.binaryPath,
		message: parts.runtimeFailureMessage,
		exitCode: MISSING_RUNTIME_BLOCK_EXIT,
		runner: parts.runner,
		event: parts.event,
	});
	return [
		'_il_payload="$(cat)" ;',
		'case "$_il_payload" in',
		"*harness*|*doctor*|*disable*|*install-hooks*|*npm*run*build*|*build-atomic-cli.mjs*)",
		'printf %s "$_il_payload" |',
		recoveryProbe,
		'; _il_recovery="$?" ;',
		'if test "$_il_recovery" -eq 0 ; then exit 0 ; fi ;',
		";; esac ;",
		"if test -f",
		shellQuote(parts.binaryPath),
		"&& test -s",
		shellQuote(parts.binaryPath),
		"; then",
		"_il_output=$(",
		'printf %s "$_il_payload" |',
		parts.runtime,
		') ; _il_status="$?" ;',
		'if test "$_il_status" -eq 0 || test "$_il_status" -eq 2 ; then printf %s "$_il_output" ; exit "$_il_status" ; fi ;',
		'printf %s "$_il_payload" |',
		failureFallback,
		"; else",
		'printf %s "$_il_payload" |',
		parts.missingFallback,
		"; fi",
	].join(" ");
}

function recoveryProbeInvocation(binaryPath: string, runner: string, event: string): string {
	return [
		"node -e",
		shellQuote(MISSING_RUNTIME_FALLBACK_SOURCE),
		shellQuote(""),
		shellQuote(String(MISSING_RUNTIME_BLOCK_EXIT)),
		shellQuote(runner),
		shellQuote(event),
		shellQuote(HOOK_REFRESH_COMMAND),
		shellQuote(binaryPath),
		shellQuote("probe"),
	].join(" ");
}

function warnOpenRuntimeCommand(parts: RuntimeCommandParts): string {
	return [
		"if test -f",
		shellQuote(parts.binaryPath),
		"&& test -s",
		shellQuote(parts.binaryPath),
		"; then",
		parts.runtime,
		'; _il_status="$?" ;',
		'if test "$_il_status" -eq 0 ; then exit 0 ; fi ;',
		"echo",
		shellQuote(parts.runtimeFailureMessage),
		">&2 ; exit 1 ; else",
		parts.missingFallback,
		"; fi",
	].join(" ");
}

function runtimeInvocation(binaryPath: string, runner: string, event: string): string {
	return [
		"node",
		shellQuote(binaryPath),
		"--runner",
		shellQuote(runner),
		"--event",
		shellQuote(event),
	].join(" ");
}

function fallbackInvocation(opts: {
	binaryPath: string;
	message: string;
	exitCode: number;
	runner: string;
	event: string;
}): string {
	const invocation = [
		"node -e",
		shellQuote(MISSING_RUNTIME_FALLBACK_SOURCE),
		shellQuote(opts.message),
		shellQuote(String(opts.exitCode)),
		shellQuote(opts.runner),
		shellQuote(opts.event),
		shellQuote(HOOK_REFRESH_COMMAND),
		shellQuote(opts.binaryPath),
	].join(" ");
	// If Node itself is unavailable, normalize the shell's 127 instead of
	// letting a gate event fail open. The embedded program already printed the
	// message for its intentional exit; only an unexpected bootstrap status
	// needs the shell-side copy.
	return [
		invocation,
		'; _il_fallback="$?" ;',
		`if test "$_il_fallback" -eq 0 || test "$_il_fallback" -eq ${opts.exitCode} ; then exit "$_il_fallback" ; fi ;`,
		"echo",
		shellQuote(opts.message),
		`>&2 ; exit ${opts.exitCode}`,
	].join(" ");
}

/**
 * Detached (fire-and-forget) variant for events whose output the runner never
 * consumes. The subshell backgrounds node and the outer shell returns in
 * milliseconds, so a runner that tears down immediately after its own work —
 * `claude update` is the observed case: it fires SessionEnd and exits, which
 * cancels any still-booting foreground hook ("Hook cancelled") — has nothing
 * left to cancel. Node still reads the payload from the inherited stdin pipe;
 * stdout/stderr go to /dev/null so the detached process can never write to a
 * closed pipe. ONLY for output-less events (SessionEnd): Stop/SessionStart/
 * PostToolUse emit context or block decisions and must stay foreground.
 */
export function buildDetachedHookCommand(
	binaryPath: string,
	runner: string,
	event: string,
): string {
	return [
		"if test -f",
		shellQuote(binaryPath),
		"; then",
		"( node",
		shellQuote(binaryPath),
		"--runner",
		shellQuote(runner),
		"--event",
		shellQuote(event),
		">/dev/null 2>&1 & )",
		"; fi",
	].join(" ");
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}
