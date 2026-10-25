import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { collectRepositoryInventory } from "./inventory.js";

const roots: string[] = [];
const GIT_SELECTION = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"] as const;

function fixture(): string {
    const root = mkdtempSync(join(tmpdir(), "inventory-root-"));
    roots.push(root);
    return root;
}

afterEach(() => {
    vi.unstubAllEnvs();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("preserves an empty Git scope instead of measuring ignored source files", () => {
    const root = fixture();
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    writeFileSync(join(root, ".gitignore"), "*\n");
    writeFileSync(join(root, "ignored.ts"), "export const ignored = true;");
    const inventory = collectRepositoryInventory(root);
    expect(inventory.discovery).toBe("git");
    expect(inventory.files).toEqual([]);
    expect(inventory.issues).toEqual([]);
});

// Release requirement: explicit ignored-directory selection keeps its filesystem
// census, while an actually empty Git scope and tracked inventory stay authoritative.
it("preserves an empty ordinary subdirectory when only its files are ignored", () => {
    const root = fixture(), selected = join(root, "selected");
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    mkdirSync(selected);
    writeFileSync(join(root, ".gitignore"), "*.ts\n");
    writeFileSync(join(selected, "ignored.ts"), "export const ignored = true;");
    const inventory = collectRepositoryInventory(selected);
    expect(inventory.discovery).toBe("git");
    expect(inventory.files).toEqual([]);
    expect(inventory.issues).toEqual([]);
});

it("measures an explicitly selected ignored descendant despite inherited Git selectors", () => {
    for (const name of GIT_SELECTION) vi.stubEnv(name, undefined);
    const root = fixture(), foreign = fixture(), selected = join(root, "ignored", "nested directory");
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    execFileSync("git", ["init", "--quiet"], { cwd: foreign });
    mkdirSync(selected, { recursive: true });
    writeFileSync(join(root, ".gitignore"), "ignored/\n");
    writeFileSync(join(selected, "local.ts"), "export const local = true;");
    writeFileSync(join(foreign, "foreign.ts"), "export const foreign = true;");
    execFileSync("git", ["add", "foreign.ts"], { cwd: foreign });
    vi.stubEnv("GIT_DIR", join(foreign, ".git"));
    vi.stubEnv("GIT_WORK_TREE", foreign);
    vi.stubEnv("GIT_COMMON_DIR", join(foreign, ".git"));
    vi.stubEnv("GIT_INDEX_FILE", join(foreign, ".git/index"));
    const inventory = collectRepositoryInventory(selected);
    expect(inventory.discovery).toBe("filesystem");
    expect(inventory.files.map(file => file.path)).toEqual(["local.ts"]);
    expect(inventory.gaps).toEqual([]);
    expect(process.env.GIT_WORK_TREE).toBe(foreign);
});

it("keeps an ignored directory's tracked inventory instead of including its ignored files", () => {
    const root = fixture(), selected = join(root, "ignored");
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    mkdirSync(selected);
    writeFileSync(join(root, ".gitignore"), "ignored/\n");
    writeFileSync(join(selected, "tracked.ts"), "export const tracked = true;");
    writeFileSync(join(selected, "ignored.ts"), "export const ignored = true;");
    execFileSync("git", ["add", "--force", "ignored/tracked.ts"], { cwd: root });
    const inventory = collectRepositoryInventory(selected);
    expect(inventory.discovery).toBe("git");
    expect(inventory.files.map(file => file.path)).toEqual(["tracked.ts"]);
    expect(inventory.gaps).toEqual([]);
});

it.each([false, true])("keeps discovery and edit identities in the selected root (Git checkout: %s)", gitCheckout => {
    for (const name of GIT_SELECTION) vi.stubEnv(name, undefined);
    const foreign = fixture(), selected = fixture();
    execFileSync("git", ["init", "--quiet"], { cwd: foreign });
    writeFileSync(join(foreign, "foreign.ts"), "export const foreign = true;");
    execFileSync("git", ["add", "foreign.ts"], { cwd: foreign });
    if (gitCheckout) execFileSync("git", ["init", "--quiet"], { cwd: selected });
    const source = join(selected, "local.ts"), original = "export const value = 1;";
    writeFileSync(source, original);
    if (gitCheckout) execFileSync("git", ["add", "local.ts"], { cwd: selected });

    vi.stubEnv("GIT_DIR", join(foreign, ".git"));
    vi.stubEnv("GIT_WORK_TREE", foreign);
    vi.stubEnv("GIT_COMMON_DIR", join(foreign, ".git"));
    vi.stubEnv("GIT_INDEX_FILE", join(foreign, ".git/index"));
    const before = collectRepositoryInventory(selected);
    expect(before.discovery).toBe(gitCheckout ? "git" : "filesystem");
    expect(before.files.map(file => file.path)).toEqual(["local.ts"]);
    expect(before.gaps).toEqual([]);

    writeFileSync(source, "export const value = 2;");
    const changed = collectRepositoryInventory(selected).inputHash;
    expect(changed).not.toBe(before.inputHash);
    writeFileSync(source, "export const value = 2;");
    expect(collectRepositoryInventory(selected).inputHash).toBe(changed);
    rmSync(source);
    const removed = collectRepositoryInventory(selected);
    expect(removed.files).toEqual([]);
    expect(removed.inputHash).not.toBe(changed);
    writeFileSync(source, original);
    expect(collectRepositoryInventory(selected).inputHash).toBe(before.inputHash);
    expect(process.env.GIT_WORK_TREE).toBe(foreign);
});
