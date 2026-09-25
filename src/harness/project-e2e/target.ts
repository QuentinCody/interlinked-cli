// ===========================================
// Check targets — working tree, index, revision (Unit F1, plan §7.3)
// ===========================================
// A pre-commit check concerns the exact staged bytes; a pre-push or CI check
// concerns an exact revision. Both are materialized into a DISPOSABLE
// directory straight from git's OBJECT STORE (`ls-tree` for membership and
// modes, `cat-file --batch` for blob bytes): never `git archive` (honours
// `export-ignore` / `export-subst`, review F-R5) and never `checkout-index`
// (applies smudge filters and other checkout conversions, so a configured
// filter could repair a committed defect on the way out, review F2-1). The
// index is frozen to its tree object first (`write-tree`), so both routes
// are the same function over a tree id. The user's working tree, index and
// stash are never touched (PE-35, PE-73). A target that cannot be exported
// is UNAVAILABLE, never a pass.

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export type E2eTarget = { mode: "working-tree" } | { mode: "index" } | { mode: "revision"; revision: string };
/** What was checked: recorded on the evaluation so a verdict names its exact target, not "the repository". */
export interface TargetIdentity { mode: E2eTarget["mode"]; commit?: string; tree?: string; }
export type ExportedTarget = { ok: true; directory: string; identity: TargetIdentity; cleanup(): void } | { ok: false; reason: string };
interface TreeEntry { mode: string; sha: string; path: string; }

const MAX_EXPORT_BYTES = 512 * 1024 * 1024;
const SHA = /^[0-9a-f]{40}$/;
const EXECUTABLE = 0o755, REGULAR = 0o644;

function git(root: string, args: string[], input?: Buffer): Buffer {
    return execFileSync("git", args, { cwd: root, stdio: ["pipe", "pipe", "pipe"], maxBuffer: MAX_EXPORT_BYTES, ...(input ? { input } : {}) });
}
function sha(root: string, args: string[]): string {
    const value = git(root, args).toString("utf8").trim();
    if (!SHA.test(value)) throw new Error(`git ${args.join(" ")} did not yield an object id`);
    return value;
}
function describe(error: unknown): string {
    const stderr = (error as { stderr?: Buffer | string }).stderr; // SAFETY: execFileSync errors carry stderr
    const text = stderr ? stderr.toString().trim() : "";
    return text || (error instanceof Error ? error.message : String(error));
}
/** Every blob and symlink under the tree, recursively, with the committed mode (submodule entries are skipped: they are not bytes of this repository). */
function treeEntries(root: string, tree: string): TreeEntry[] {
    // `--full-tree`: without it, ls-tree run from a project SUBDIRECTORY limits the listing to that prefix and a subtree lists nothing.
    const listing = git(root, ["ls-tree", "-r", "-z", "--full-tree", tree]).toString("utf8");
    return listing.split("\0").filter(Boolean).flatMap(line => {
        const tab = line.indexOf("\t");
        const [mode, type, sha] = line.slice(0, tab).split(" ");
        if (!mode || !sha || type === "commit") return [];
        return [{ mode, sha, path: line.slice(tab + 1) }];
    });
}
/** Blob bytes by object id through ONE `cat-file --batch` round trip — no checkout conversion of any kind. */
function blobBytes(root: string, shas: readonly string[]): Map<string, Buffer> {
    const out = new Map<string, Buffer>();
    if (!shas.length) return out;
    const batch = git(root, ["cat-file", "--batch"], Buffer.from(`${shas.join("\n")}\n`));
    let offset = 0;
    while (offset < batch.length) {
        const newline = batch.indexOf(10, offset);
        const header = batch.subarray(offset, newline).toString("utf8").split(" ");
        const [id, type, size] = header;
        if (!id || type !== "blob" || size === undefined) throw new Error(`unexpected cat-file record: ${header.join(" ")}`);
        const start = newline + 1, end = start + Number(size);
        out.set(id, Buffer.from(batch.subarray(start, end)));
        offset = end + 1;
    }
    return out;
}
/** Materialize `tree` under `directory`: exact membership, exact bytes, committed modes. Exported for the proof-comparison side (sensitivity.ts). */
export function materializeTree(root: string, tree: string, directory: string): void {
    const entries = treeEntries(root, tree);
    // A symlink is a blob too (its bytes are the link target): fetch every blob, recreate links without following them (review round 3).
    const blobs = blobBytes(root, [...new Set(entries.map(entry => entry.sha))]);
    for (const entry of entries) {
        const target = join(directory, entry.path);
        mkdirSync(dirname(target), { recursive: true });
        const bytes = blobs.get(entry.sha);
        if (bytes === undefined) throw new Error(`blob ${entry.sha} for ${entry.path} missing from cat-file output`);
        if (entry.mode === "120000") { symlinkSync(bytes.toString("utf8"), target); continue; }
        writeFileSync(target, bytes);
        chmodSync(target, entry.mode === "100755" ? EXECUTABLE : REGULAR);
    }
}
/** The index as a tree object (no commit is created; `write-tree` refuses an unmerged index), then materialized from that tree. */
function exportIndex(root: string, directory: string): TargetIdentity {
    const tree = sha(root, ["write-tree"]);
    materializeTree(root, tree, directory);
    return { mode: "index", tree };
}
/** The revision's exact tree (the commit is resolved first; a name that is not a commit is a refusal). */
function exportRevision(root: string, directory: string, revision: string): TargetIdentity {
    const commit = sha(root, ["rev-parse", "--verify", "--quiet", `${revision}^{commit}`]);
    const tree = sha(root, ["rev-parse", `${commit}^{tree}`]);
    materializeTree(root, tree, directory);
    return { mode: "revision", commit, tree };
}
/** Exports the target's bytes into a fresh temp directory the caller must `cleanup()`; the working tree is only read. */
export function exportTarget(root: string, target: Exclude<E2eTarget, { mode: "working-tree" }>): ExportedTarget {
    const directory = mkdtempSync(join(tmpdir(), `interlinked-e2e-${target.mode}-`));
    const cleanup = (): void => rmSync(directory, { recursive: true, force: true });
    try {
        const identity = target.mode === "index" ? exportIndex(root, directory) : exportRevision(root, directory, target.revision);
        return { ok: true, directory, identity, cleanup };
    } catch (error) {
        cleanup();
        const what = target.mode === "index" ? "the index" : `revision ${target.revision}`;
        return { ok: false, reason: `cannot export ${what} of ${root}: ${describe(error)}` };
    }
}
