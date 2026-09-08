// @codegen-data — template-string carrier for the generated .mjs hook; no
// hand-written runtime logic to unit-test (exempts the every-file-tested gate).
// Extracted from hooks-template.ts.
// This is DATA — the body of the generated `.interlinked/hooks/interlinked-activity.mjs`.
// Do not edit escape sequences (`\\b`, `\\s`, `\\n`, etc.) — they are the source form
// for the runtime script. `\\b` in this file becomes `\b` in the emitted .mjs.

import { COLD_WRITE_GUARDS_SOURCE } from "./cold-write-guards.js";
import { DESTRUCTIVE_COMMAND_GUARD_SOURCE } from "./destructive-command-guard.js";
import { FILE_DUMP_COLD_GUARD_SOURCE } from "./file-dump-cold-guard.js";
import { PACKAGE_INSTALL_COLD_GUARD_SOURCE } from "./package-install-cold-guard.js";

/** Public API — consumed by buildHookScript in hooks-template.ts. */
export const GUARDS_INLINE_CHUNK = `/**
 * Inline fallback guard — comprehensive pattern matching covering all ~40 rules.
 * This is the PRIMARY guard — runs under Node.js on every tool call with zero dependencies.
 * When the harness is available, it provides additional quality checks and cohort awareness.
 */
// Cold-fallback FILE-DUMP gate — joined function declarations from
// src/lib/hook-template-chunks/file-dump-cold-guard.ts. Spliced bare; the blob
// is already a run of \`function\` declarations, which hoist.
${FILE_DUMP_COLD_GUARD_SOURCE}

// Cold-fallback FILE-WRITE guards — joined function declarations from
// src/lib/hook-template-chunks/cold-write-guards.ts (target/content extraction
// helpers + one function per gate). This is the SAME source
// src/hook-entry-cold-gates.ts imports, so the .mjs (harness-down) and
// hook-entry.ts cold paths cannot diverge. Spliced bare — the blob is already a
// run of \`function\` declarations, which hoist, so join order does not matter.
${COLD_WRITE_GUARDS_SOURCE}

/**
 * Filesystem/path functions the shared guards take as an injected argument.
 * They are top-level imports of the generated .mjs, but a serialized function
 * body cannot reference them by free identifier (the bundler that emits this
 * chunk may rename its own imports), so the call site hands them over. Resolved
 * with \`typeof\` so a host that did not provide one degrades to null instead of
 * throwing a ReferenceError.
 */
function inlineFsDeps() {
    return {
        existsSync: typeof existsSync === "undefined" ? null : existsSync,
        statSync: typeof statSync === "undefined" ? null : statSync,
        readFileSync: typeof readFileSync === "undefined" ? null : readFileSync,
        openSync: typeof openSync === "undefined" ? null : openSync,
        readSync: typeof readSync === "undefined" ? null : readSync,
        closeSync: typeof closeSync === "undefined" ? null : closeSync,
        join: typeof join === "undefined" ? null : join,
    };
}

// Destructive shell-command ladder — joined function declarations from
// src/lib/hook-template-chunks/destructive-command-guard.ts (the mask/shutdown
// helpers + one function per rule family + checkDestructiveCommand itself).
// This is the SAME source src/hook-entry.ts imports for its cold fallback, so
// the .mjs (harness-down) and hook-entry.ts cold paths cannot diverge. Spliced
// bare (no wrapping \`const x = \`) because the blob already contains a
// \`function checkDestructiveCommand(...) {}\` declaration; plain function
// declarations hoist so call order inside the blob doesn't matter.
${DESTRUCTIVE_COMMAND_GUARD_SOURCE}

// Cold-fallback PACKAGE-INSTALL gate — joined function declarations from
// src/lib/hook-template-chunks/package-install-cold-guard.ts. Conservative by
// design: the .mjs cannot reach the parser or the allowlist, so every install
// verb is refused while the daemon is unreachable. Spliced bare; the blob is
// already a run of \`function\` declarations, which hoist.
${PACKAGE_INSTALL_COLD_GUARD_SOURCE}

function inlineGuardDisabled() {
    try {
        for (const name of ["guard-disabled.local.json", "guard-disabled.json"]) {
            const p = join(CONFIG_DIR, name);
            if (!existsSync(p)) continue;
            const rec = JSON.parse(readFileSync(p, "utf-8"));
            if (!rec || rec.disabled !== true) continue;
            // Fail toward guarding on a malformed expiry: an unparseable expires_at
            // (NaN) must NOT read as a live stand-down (mirrors guard-state.ts).
            if (rec.expires_at !== undefined) { const exp = Date.parse(rec.expires_at); if (!Number.isFinite(exp) || exp <= Date.now()) continue; }
            return true;
        }
    } catch (_e) { /* malformed/unreadable -> fail toward guarding */ }
    return false;
}

function inlineGuardCheck(hookEvent, toolName, toolInput) {
    if (hookEvent !== "PreToolUse"
        && hookEvent !== "BeforeTool"
        && hookEvent !== "PermissionRequest") return null;
    if (!toolName) return null;

    // Intentional, recorded stand-down (interlinked disable) honors the marker
    // so the operator can run unguarded here, mirroring the daemon + dist cold
    // gates. A crash leaves no marker, so the gates below still fail closed.
    if (inlineGuardDisabled()) return null;

    // Merge-conflict markers in file-write content are a guaranteed parse
    // error — mirror the daemon's write-content-guards A1 gate.
    const mergeBlock = checkMergeConflictWrite(toolName, toolInput);
    if (mergeBlock) return mergeBlock;

    // Graph-prediction fail-closed gate. Runs early so file-write events
    // targeting a Supermodel-shard'd file get the protocol-restart message
    // instead of silently passing through the Bash-only path below.
    const shardBlock = checkGraphShardWrite(toolName, toolInput, process.cwd(), inlineFsDeps());
    if (shardBlock) return shardBlock;

    // Supply-chain fail-closed gate. Daemon-down + package install = block.
    const supplyBlock = checkPackageInstallCold(toolName, toolInput);
    if (supplyBlock) return supplyBlock;

    // File-dump output-budget gate. Must run BEFORE the data-only references
    // skip below, since that skip returns null for any command starting with
    // tail/head/cat and would otherwise hide every dump-budget block.
    const dumpBlock = checkFileDumpCold(toolName, toolInput, process.cwd(), inlineFsDeps());
    if (dumpBlock) return dumpBlock;

    const isBash = ["Bash", "Shell", "shell", "run_command"].includes(toolName);
    if (!isBash) return null;

	const cmd = toolInput?.command || "";
	if (!cmd) return null;

	// Destructive shell-command ladder. checkDestructiveCommand is spliced in
	// above from src/lib/hook-template-chunks/destructive-command-guard.ts —
	// the SAME function src/hook-entry.ts imports for its cold fallback, so
	// the .mjs (harness-down) and hook-entry.ts cold paths cannot diverge.
	return checkDestructiveCommand(cmd);
}`;
