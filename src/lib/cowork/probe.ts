import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { CoworkEvent } from "./native.js";
import { digest } from "./receipts.js";

export function probeControl(event: CoworkEvent): string | undefined {
    if (event.event !== "PreToolUse" || event.tool !== "Write" || typeof event.input.file_path !== "string") return undefined;
    const controls: Record<string, string> = {
        "interlinked-probe-deny.txt": "deny", "interlinked-probe-ask.txt": "ask", "interlinked-probe-rewrite-before.txt": "rewrite_input",
        "interlinked-probe-crash.txt": "crash", "interlinked-probe-timeout.txt": "timeout", "interlinked-probe-once.txt": "deny_once",
    };
    return controls[basename(event.input.file_path)];
}

/** Fault injection is available only in separately packaged probe mode. All
 * effects target synthetic files; no command execution is performed here. */
export async function coworkProbeOutput(event: CoworkEvent, evidenceRoot: string): Promise<Record<string, unknown> | null> {
    if (event.event !== "PreToolUse" || event.tool !== "Write" || typeof event.input.file_path !== "string") return null;
    const name = basename(event.input.file_path);
    const specific: Record<string, unknown> = { hookEventName: "PreToolUse" };
    if (name === "interlinked-probe-deny.txt") {
        specific.permissionDecision = "deny";
        specific.permissionDecisionReason = "Synthetic Interlinked veto. Do not retry through another tool.";
    } else if (name === "interlinked-probe-ask.txt") {
        specific.permissionDecision = "ask";
        specific.permissionDecisionReason = "Synthetic Interlinked approval probe for this scratch file only.";
    } else if (name === "interlinked-probe-rewrite-before.txt") {
        specific.updatedInput = { ...event.input, file_path: event.input.file_path.replace(/interlinked-probe-rewrite-before\.txt$/, "interlinked-probe-rewrite-after.txt") };
    } else if (name === "interlinked-probe-crash.txt") {
        // Intentionally exits outside the guard's error handler to measure
        // provider behavior for an actual failed hook process.
        process.exit(1);
    } else if (name === "interlinked-probe-timeout.txt") {
        await new Promise(resolve => setTimeout(resolve, 20000));
    } else if (name === "interlinked-probe-once.txt") {
        mkdirSync(evidenceRoot, { recursive: true });
        const marker = join(evidenceRoot, `${digest(event.session)}.once`);
        if (!existsSync(marker)) {
            writeFileSync(marker, "observed", { flag: "wx", mode: 0o600 });
            specific.permissionDecision = "deny";
            specific.permissionDecisionReason = "Synthetic first-attempt veto.";
        }
    }
    return Object.keys(specific).length > 1 ? { hookSpecificOutput: specific } : null;
}

export const COWORK_PROBE_PROMPT = "Run the interlinked-cowork-probe compatibility skill. Use only a new synthetic folder /tmp/interlinked-cowork-native. Use native Write separately for interlinked-probe-allow.txt, interlinked-probe-deny.txt, interlinked-probe-rewrite-before.txt, interlinked-probe-ask.txt, interlinked-probe-crash.txt, and interlinked-probe-timeout.txt, with content PROBE. Do not retry denied actions or substitute tools. Read back actual directory contents through Bash after all attempts. Run Bash exit 7 to exercise failure events. If available, delegate one read-only synthetic task to a subagent. Do not send messages, publish, access personal data, or change settings. Report tool results separately from observed filesystem effects. Export the plugin evidence/events.jsonl and actual file listing via SendUserFile. Missing events mean unmeasured, not unsupported.";
