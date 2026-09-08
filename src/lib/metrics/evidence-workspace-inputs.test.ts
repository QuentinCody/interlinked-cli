import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { captureWorkspaceInputs, changedWorkspaceInputs } from "./evidence-workspace-inputs.js";
import { captureWorkspaceInputsSync } from "./evidence-workspace-inputs-sync.js";
import { copyEvidenceWorkspace, MAX_WORKSPACE_BYTES, removeEvidenceWorkspace } from "./evidence-workspace.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(): string { const root = mkdtempSync(join(tmpdir(), "metrics-workspace-digest-")); roots.push(root); return root; }
function options() { return { artifact: "report.json", deadline: Date.now() + 10_000 }; }

it("includes empty and newly added ignored inputs while excluding the declared output and control state", async () => {
    const root = fixture(), initial = await captureWorkspaceInputs(root, options());
    mkdirSync(join(root, ".interlinked"));
    writeFileSync(join(root, ".interlinked/config.json"), "local state");
    writeFileSync(join(root, "report.json"), "old output");
    expect((await captureWorkspaceInputs(root, options())).hash).toBe(initial.hash);
    writeFileSync(join(root, ".env"), "");
    const emptyConfig = await captureWorkspaceInputs(root, options());
    expect(emptyConfig.hash).not.toBe(initial.hash);
    writeFileSync(join(root, "new-output.log"), "test output");
    expect(await changedWorkspaceInputs(root, emptyConfig, options())).toEqual([]);
    rmSync(join(root, ".env"));
    await expect(changedWorkspaceInputs(root, emptyConfig, options())).rejects.toThrow("ENOENT");
});

it("refuses hashing or copying when cancellation or the deadline has already arrived", async () => {
    const source = fixture(), destination = fixture(), controller = new AbortController();
    writeFileSync(join(source, ".env"), "input");
    controller.abort();
    await expect(captureWorkspaceInputs(source, { ...options(), signal: controller.signal })).rejects.toThrow("cancelled");
    await expect(captureWorkspaceInputs(source, { artifact: "report.json", deadline: Date.now() - 1 })).rejects.toThrow("time budget");
    await expect(copyEvidenceWorkspace({ source, destination, deadline: Date.now() + 10_000, signal: controller.signal })).rejects.toThrow("cancelled");
});

it("rejects a sparse file above the byte budget before allocating or copying it", async () => {
    const source = fixture(), destination = fixture(), path = join(source, ".env");
    writeFileSync(path, ""); truncateSync(path, MAX_WORKSPACE_BYTES + 1);
    await expect(captureWorkspaceInputs(source, options())).rejects.toThrow("isolation hash bound");
    await expect(copyEvidenceWorkspace({ source, destination, deadline: Date.now() + 10_000 })).rejects.toThrow("isolation copy bound");
});

it("rejects linked content outside the copied tree and absolute links", async () => {
    const root = fixture(), external = fixture();
    writeFileSync(join(external, "config"), "outside");
    symlinkSync(join(external, "config"), join(root, ".env"));
    await expect(captureWorkspaceInputs(root, options())).rejects.toThrow("External workspace symlink");
    rmSync(join(root, ".env"));
    writeFileSync(join(root, "config"), "inside");
    symlinkSync(join(root, "config"), join(root, ".env"));
    await expect(captureWorkspaceInputs(root, options())).rejects.toThrow("Absolute workspace symlink");
});

it("removes temporary links without following them into another workspace", async () => {
    const workspace = fixture(), external = fixture();
    writeFileSync(join(external, "retained.txt"), "retained");
    symlinkSync(external, join(workspace, "outside-directory"));
    await removeEvidenceWorkspace(workspace);
    expect(existsSync(workspace)).toBe(false);
    expect(readFileSync(join(external, "retained.txt"), "utf8")).toBe("retained");
    await removeEvidenceWorkspace(workspace);
});

it("uses identical byte and link identity for execution and synchronous freshness checks", async () => {
    const root = fixture();
    writeFileSync(join(root, ".env"), Buffer.alloc(64 * 1024 + 7, 0xff));
    symlinkSync(".env", join(root, "runtime-link"));
    const executed = await captureWorkspaceInputs(root, options());
    expect(captureWorkspaceInputsSync(root, options())).toEqual(executed);
    writeFileSync(join(root, ".env"), Buffer.alloc(64 * 1024 + 7, 0xfe));
    expect(captureWorkspaceInputsSync(root, options()).hash).not.toBe(executed.hash);
});
