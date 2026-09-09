import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep, posix } from "node:path";
import { CheckEngine, type CheckReport, type ToolId } from "../../harness/check-engine/index.js";
import { captureWorkspaceInputs } from "../metrics/evidence-workspace-inputs.js";
import type { CoworkEvent } from "./native.js";

export interface CoworkWorkspace { id: string; hostRoot: string; runtimeRoot: string }
export interface CoworkWorkspaceReport { status: "checked" | "unmeasured"; workspace: string; before: string; after: string; report: CheckReport; limitations: string[] }

function existingAncestor(path: string): string {
    let ancestor = path;
    while (!existsSync(ancestor)) {
        try { if (lstatSync(ancestor).isSymbolicLink()) throw new Error("Dangling symlink in mapped path"); }
        catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
        ancestor = dirname(ancestor);
    }
    return ancestor;
}

/** Host mapping never interprets a cloud path as a host path by coincidence. */
export function mapCoworkPath(workspace: CoworkWorkspace, native: string): string {
    if (!posix.isAbsolute(native) || !posix.isAbsolute(workspace.runtimeRoot)) throw new Error("Workspace paths must be absolute");
    const rel = posix.relative(posix.normalize(workspace.runtimeRoot), posix.normalize(native));
    if (!rel || rel === ".." || rel.startsWith("../") || posix.isAbsolute(rel)) throw new Error("File is outside mapped workspace");
    const root = realpathSync(workspace.hostRoot), target = resolve(root, rel), ancestor = existingAncestor(target);
    const canonical = join(realpathSync(ancestor), relative(ancestor, target));
    const check = relative(root, canonical);
    if (check === ".." || check.startsWith(`..${sep}`) || isAbsolute(check)) throw new Error("Mapped file escapes workspace through a symlink");
    return canonical;
}

export function mapCoworkFileEvent(workspace: CoworkWorkspace, event: CoworkEvent): Record<string, unknown> {
    if (!["Read", "Write", "Edit"].includes(event.tool) || typeof event.input.file_path !== "string") throw new Error("Host bridge currently requires an explicit native Read/Write/Edit file target");
    if (!posix.isAbsolute(event.input.file_path) && !posix.isAbsolute(event.cwd)) throw new Error("Native working directory is unknown");
    const native = posix.isAbsolute(event.input.file_path) ? event.input.file_path : posix.resolve(event.cwd, event.input.file_path);
    return { hook_event_name: event.event, session_id: event.session, tool_name: event.tool,
        tool_use_id: event.callId ?? undefined, cwd: realpathSync(workspace.hostRoot),
        tool_input: { ...event.input, file_path: mapCoworkPath(workspace, native) } };
}

export async function verifyCoworkWorkspace(root: string, tools: ToolId[] = ["tsc", "biome", "gitleaks"]): Promise<CoworkWorkspaceReport> {
    root = realpathSync(root);
    const options = { artifact: ".interlinked/cowork/verification.json", deadline: Date.now() + 120000 };
    const before = await captureWorkspaceInputs(root, options);
    const report = await new CheckEngine(root).runChecksAsync({ projectRoot: root, mode: "project" }, { tools, timeoutMs: 30000 });
    const after = await captureWorkspaceInputs(root, options);
    const limitations = ["Only the listed external tools ran; test/coverage/mutation ratchets require their configured Interlinked commands."];
    if (before.hash !== after.hash) limitations.push("Workspace inputs changed during verification; results are stale.");
    if (report.toolsSkipped.length || report.skipped.length) limitations.push("Some checks were skipped or unavailable; inspect report.");
    const complete = before.hash === after.hash && !report.toolsSkipped.length && !report.skipped.length && tools.every(tool => report.toolsRun.some(row => row.id === tool));
    return { status: complete ? "checked" : "unmeasured", workspace: root, before: before.hash, after: after.hash, report, limitations };
}
