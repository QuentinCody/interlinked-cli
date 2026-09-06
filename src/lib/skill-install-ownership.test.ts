import { createHash } from "node:crypto";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `realpathSync` is call-through by default (every other test in this file
// relies on real filesystem behavior) so a single test can force its SECOND
// call within one `ensureSafeParent` invocation to return a path outside the
// repository root — the one way to reach the parent-escape branch without a
// genuine cross-filesystem symlink setup. Plain `vi.spyOn(fs, ...)` throws
// "Module namespace is not configurable in ESM" for node:fs, so the module
// factory is the seam (prior art: src/lib/bounded-file-transfer.test.ts).
vi.mock("node:fs", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs")>();
    return {
        ...actual,
        realpathSync: vi.fn(actual.realpathSync),
    };
});
import type { ManagedSkillFile, SkillInstallManifest } from "./skill-install-ownership.js";
import type { ClientName } from "./settings.js";
import {
    assertSafeSkillPath,
    contentDigest,
    loadSkillInstallManifest,
    removeManagedSkillFiles,
    removeOwnedFilesForClients,
    saveSkillInstallManifest,
    SKILL_INSTALL_MANIFEST,
    writeManagedSkillFiles,
} from "./skill-install-ownership.js";
import {
    installEnforceSkill,
    installSkills,
    uninstallEnforceSkill,
    uninstallSkills,
} from "./skill-installers.js";

let tmpRoot: string;

function write(path: string, content: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
}

/** Runs `fn` and returns whatever it threw, or `undefined` if it didn't throw. */
function captureThrown(fn: () => void): unknown {
    try {
        fn();
        return undefined;
    } catch (err) {
        return err;
    }
}

beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "skill-installer-safety-"));
});

afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
});

describe("skill install ownership", () => {
    it("refuses to overwrite an unowned runner skill", () => {
        const target = join(tmpRoot, ".claude", "skills", "enforce", "SKILL.md");
        const userContent = "---\nname: enforce\ndescription: user-owned\n---\n# Mine\n";
        write(target, userContent);

        const [result] = installEnforceSkill(tmpRoot, ["claude"]);

        expect(result?.installed).toBe(false);
        expect(result?.error).toContain("Refusing to overwrite unowned skill file");
        expect(readFileSync(target, "utf-8")).toBe(userContent);
    });

    it("preserves a managed file after the user modifies it", () => {
        const target = join(tmpRoot, ".claude", "skills", "enforce", "SKILL.md");
        expect(installEnforceSkill(tmpRoot, ["claude"])[0]?.installed).toBe(true);
        writeFileSync(target, "user modification\n");

        const [reinstall] = installEnforceSkill(tmpRoot, ["claude"]);
        expect(reinstall?.installed).toBe(false);
        expect(reinstall?.error).toContain("modified managed skill file");
        // Other unmodified resources may be removed, but the modified target is preserved.
        expect(uninstallEnforceSkill(tmpRoot, ["claude"])).toBe(true);
        expect(readFileSync(target, "utf-8")).toBe("user modification\n");
    });

    it("rejects a symlinked target parent without writing outside the repo", () => {
        const outside = mkdtempSync(join(tmpdir(), "skill-installer-outside-"));
        mkdirSync(join(tmpRoot, ".claude"), { recursive: true });
        symlinkSync(outside, join(tmpRoot, ".claude", "skills"), "dir");
        try {
            const [result] = installEnforceSkill(tmpRoot, ["claude"]);
            expect(result?.installed).toBe(false);
            expect(result?.error).toContain("symlinked directory");
            expect(existsSync(join(outside, "enforce", "SKILL.md"))).toBe(false);
        } finally {
            rmSync(outside, { recursive: true, force: true });
        }
    });

    it("uninstall leaves an unrelated Copilot teaching prompt untouched", () => {
        const prompt = join(
            tmpRoot,
            ".github",
            "prompts",
            "interlinked-setup.prompt.md",
        );
        write(prompt, "user teaching prompt\n");
        installSkills(tmpRoot, ["copilot"]);

        expect(uninstallSkills(tmpRoot, ["copilot"])).toBe(true);
        expect(readFileSync(prompt, "utf-8")).toBe("user teaching prompt\n");
    });

    it("rejects a forged manifest entry outside a runner skill root", () => {
        const readme = join(tmpRoot, "README.md");
        const content = "repository documentation\n";
        writeFileSync(readme, content);
        write(
            join(tmpRoot, SKILL_INSTALL_MANIFEST),
            `${JSON.stringify({
                version: 1,
                files: {
                    "README.md": {
                        sha256: createHash("sha256").update(content).digest("hex"),
                        skill: "enforce",
                        owner: "claude",
                        kind: "spec",
                    },
                },
            })}\n`,
        );

        expect(uninstallSkills(tmpRoot, ["claude"])).toBe(false);
        expect(readFileSync(readme, "utf-8")).toBe(content);
    });
});

describe("legacy skill migration", () => {
    it("migrates the old Codex directory only when its content is recognized", () => {
        const current = join(tmpRoot, ".agents", "skills", "enforce", "SKILL.md");
        expect(installEnforceSkill(tmpRoot, ["codex"])[0]?.installed).toBe(true);
        const managedContent = readFileSync(current);
        rmSync(join(tmpRoot, ".agents"), { recursive: true, force: true });

        const legacy = join(tmpRoot, ".codex", "skills", "enforce", "SKILL.md");
        mkdirSync(dirname(legacy), { recursive: true });
        writeFileSync(legacy, managedContent);

        expect(installEnforceSkill(tmpRoot, ["codex"])[0]?.installed).toBe(true);
        expect(existsSync(current)).toBe(true);
        expect(existsSync(legacy)).toBe(false);
    });

    it("repairs a recognized stale description from an unmanifested install", () => {
        const target = join(tmpRoot, ".claude", "skills", "enforce", "SKILL.md");
        expect(installEnforceSkill(tmpRoot, ["claude"])[0]?.installed).toBe(true);
        const stale = readFileSync(target, "utf-8").replace(
            /^description:.*$/m,
            "description: stale unquoted description",
        );
        rmSync(join(tmpRoot, SKILL_INSTALL_MANIFEST), { force: true });
        rmSync(join(tmpRoot, ".interlinked", "skills", "enforce", "agents"), {
            recursive: true,
            force: true,
        });
        rmSync(join(tmpRoot, ".claude", "skills", "enforce", "agents"), {
            recursive: true,
            force: true,
        });
        writeFileSync(target, stale);

        const [result] = installEnforceSkill(tmpRoot, ["claude"]);
        expect(result?.installed).toBe(true);
        expect(readFileSync(target, "utf-8")).not.toContain(
            "description: stale unquoted description",
        );
    });

    it("refreshes matching stale canonical and runner copies from the old installer", () => {
        const canonical = join(
            tmpRoot,
            ".interlinked",
            "skills",
            "interlinked",
            "SKILL.md",
        );
        const runner = join(
            tmpRoot,
            ".claude",
            "skills",
            "interlinked",
            "SKILL.md",
        );
        installSkills(tmpRoot, ["claude"]);
        const oldGenerated = `${readFileSync(canonical, "utf-8")}\n<!-- old generated copy -->\n`;
        writeFileSync(canonical, oldGenerated);
        writeFileSync(runner, oldGenerated);
        rmSync(join(tmpRoot, SKILL_INSTALL_MANIFEST), { force: true });
        rmSync(join(dirname(canonical), "agents"), { recursive: true, force: true });
        rmSync(join(dirname(runner), "agents"), { recursive: true, force: true });

        const result = installSkills(tmpRoot, ["claude"]).find(
            (entry) => entry.skill === "interlinked",
        );

        expect(result?.installed).toBe(true);
        expect(readFileSync(canonical, "utf-8")).not.toContain("old generated copy");
        expect(readFileSync(runner, "utf-8")).not.toContain("old generated copy");
    });
});

describe("assertSafeSkillPath", () => {
    it("rejects an absolute relPath", () => {
        expect(() => assertSafeSkillPath(tmpRoot, "/etc/passwd")).toThrow(
            "repository-relative",
        );
    });

    it("rejects a path that escapes the repository via ..", () => {
        expect(() => assertSafeSkillPath(tmpRoot, join("..", "outside.md"))).toThrow(
            "escapes the repository",
        );
    });

    it("rejects a symlinked target file itself, not only a symlinked parent", () => {
        const real = mkdtempSync(join(tmpdir(), "skill-real-"));
        writeFileSync(join(real, "SKILL.md"), "x");
        mkdirSync(join(tmpRoot, "symtarget"), { recursive: true });
        symlinkSync(join(real, "SKILL.md"), join(tmpRoot, "symtarget", "SKILL.md"));
        expect(() =>
            assertSafeSkillPath(tmpRoot, join("symtarget", "SKILL.md")),
        ).toThrow("symlinked skill target");
        rmSync(real, { recursive: true, force: true });
    });

    it("returns the resolved absolute path for a safe relPath", () => {
        expect(assertSafeSkillPath(tmpRoot, join("a", "b.md"))).toBe(
            join(tmpRoot, "a", "b.md"),
        );
    });
});

describe("loadSkillInstallManifest — malformed manifest rejection", () => {
    it("rejects a manifest whose top-level JSON value is not an object", () => {
        write(join(tmpRoot, SKILL_INSTALL_MANIFEST), "null\n");
        expect(() => loadSkillInstallManifest(tmpRoot)).toThrow(
            /Cannot read .*: Skill install manifest is not an object/,
        );
    });

    it("rejects an unsupported manifest version", () => {
        write(
            join(tmpRoot, SKILL_INSTALL_MANIFEST),
            JSON.stringify({ version: 2, files: {} }),
        );
        expect(() => loadSkillInstallManifest(tmpRoot)).toThrow(
            /Unsupported or malformed skill install manifest/,
        );
    });

    it("rejects a manifest entry with an invalid skill-name pattern", () => {
        const relPath = join(".interlinked", "skills", "Bad_Name", "SKILL.md");
        write(
            join(tmpRoot, SKILL_INSTALL_MANIFEST),
            JSON.stringify({
                version: 1,
                files: {
                    [relPath]: {
                        sha256: "a".repeat(64),
                        skill: "Bad_Name",
                        owner: "canonical",
                        kind: "skill",
                    },
                },
            }),
        );
        expect(() => loadSkillInstallManifest(tmpRoot)).toThrow(
            /Unsafe skill install manifest entry/,
        );
    });

    it("rejects a manifest entry that is not an object", () => {
        write(
            join(tmpRoot, SKILL_INSTALL_MANIFEST),
            JSON.stringify({ version: 1, files: { "a.md": "not-an-object" } }),
        );
        expect(() => loadSkillInstallManifest(tmpRoot)).toThrow(
            /Malformed skill install manifest entry/,
        );
    });

    it("rejects a manifest entry with a malformed sha256", () => {
        const relPath = join(".interlinked", "skills", "enforce", "SKILL.md");
        write(
            join(tmpRoot, SKILL_INSTALL_MANIFEST),
            JSON.stringify({
                version: 1,
                files: {
                    [relPath]: {
                        sha256: "not-a-hash",
                        skill: "enforce",
                        owner: "canonical",
                        kind: "skill",
                    },
                },
            }),
        );
        expect(() => loadSkillInstallManifest(tmpRoot)).toThrow(
            /Malformed skill install manifest entry/,
        );
    });

    it("returns an empty manifest when no file exists yet", () => {
        expect(loadSkillInstallManifest(tmpRoot)).toEqual({ version: 1, files: {} });
    });
});

describe("saveSkillInstallManifest — atomic write", () => {
    it("cleans up the temp file when the atomic rename fails", () => {
        const manifestPath = join(tmpRoot, SKILL_INSTALL_MANIFEST);
        mkdirSync(manifestPath, { recursive: true });
        const manifest: SkillInstallManifest = { version: 1, files: {} };

        expect(() => saveSkillInstallManifest(tmpRoot, manifest)).toThrow();

        const leftover = readdirSync(join(tmpRoot, ".interlinked")).filter((f) =>
            f.startsWith("skill-install-manifest.json.tmp-"),
        );
        expect(leftover).toHaveLength(0);
    });

    it("round-trips a manifest through save and load", () => {
        const manifest: SkillInstallManifest = {
            version: 1,
            files: {
                [join(".interlinked", "skills", "enforce", "SKILL.md")]: {
                    sha256: "a".repeat(64),
                    skill: "enforce",
                    owner: "canonical",
                    kind: "skill",
                },
            },
        };
        saveSkillInstallManifest(tmpRoot, manifest);
        expect(loadSkillInstallManifest(tmpRoot)).toEqual(manifest);
    });
});

describe("contentDigest", () => {
    it("matches the sha256 hex digest of the buffer", () => {
        const buf = Buffer.from("hello world");
        expect(contentDigest(buf)).toBe(
            createHash("sha256").update(buf).digest("hex"),
        );
    });

    it("differs for different content", () => {
        expect(contentDigest(Buffer.from("a"))).not.toBe(contentDigest(Buffer.from("b")));
    });
});

describe("writeManagedSkillFiles — duplicate targets and rollback", () => {
    it("throws on duplicate write targets within the same batch", () => {
        const manifest: SkillInstallManifest = { version: 1, files: {} };
        const spec: ManagedSkillFile = {
            relPath: join("dup", "a", "SKILL.md"),
            content: Buffer.from("x"),
            skill: "a",
            owner: "canonical",
            kind: "skill",
        };
        expect(() => writeManagedSkillFiles(tmpRoot, manifest, [spec, spec])).toThrow(
            "Duplicate skill target",
        );
    });

    it("rolls back a newly-created file when a later spec in the batch fails", () => {
        const manifest: SkillInstallManifest = { version: 1, files: {} };
        const specA: ManagedSkillFile = {
            relPath: join("rollback", "a", "SKILL.md"),
            content: Buffer.from("a"),
            skill: "a",
            owner: "canonical",
            kind: "skill",
        };
        const lockedDir = join(tmpRoot, "rollback", "locked");
        mkdirSync(lockedDir, { recursive: true });
        chmodSync(lockedDir, 0o555);
        const specB: ManagedSkillFile = {
            relPath: join("rollback", "locked", "SKILL.md"),
            content: Buffer.from("b"),
            skill: "b",
            owner: "canonical",
            kind: "skill",
        };

        expect(() => writeManagedSkillFiles(tmpRoot, manifest, [specA, specB])).toThrow();
        chmodSync(lockedDir, 0o755);

        expect(existsSync(join(tmpRoot, "rollback", "a", "SKILL.md"))).toBe(false);
        expect(manifest.files[specA.relPath]).toBeUndefined();
    });

    it("restores previous content and manifest entry when a later spec fails after an update", () => {
        const manifest: SkillInstallManifest = { version: 1, files: {} };
        const specA: ManagedSkillFile = {
            relPath: join("rollback2", "a", "SKILL.md"),
            content: Buffer.from("original"),
            skill: "a",
            owner: "canonical",
            kind: "skill",
        };
        writeManagedSkillFiles(tmpRoot, manifest, [specA]);
        const targetA = join(tmpRoot, "rollback2", "a", "SKILL.md");
        expect(readFileSync(targetA, "utf-8")).toBe("original");

        const specAUpdated: ManagedSkillFile = { ...specA, content: Buffer.from("updated") };
        const lockedDir = join(tmpRoot, "rollback2", "locked");
        mkdirSync(lockedDir, { recursive: true });
        chmodSync(lockedDir, 0o555);
        const specB: ManagedSkillFile = {
            relPath: join("rollback2", "locked", "SKILL.md"),
            content: Buffer.from("b"),
            skill: "b",
            owner: "canonical",
            kind: "skill",
        };

        expect(() =>
            writeManagedSkillFiles(tmpRoot, manifest, [specAUpdated, specB]),
        ).toThrow();
        chmodSync(lockedDir, 0o755);

        expect(readFileSync(targetA, "utf-8")).toBe("original");
        expect(manifest.files[specA.relPath]?.sha256).toBe(
            contentDigest(Buffer.from("original")),
        );
    });

    it("refuses a write whose parent directory's real path escapes the repository root", () => {
        // assertSafeSkillPath's own lexical/symlink checks can only see a
        // symlinked path COMPONENT; they cannot see the root and its parent
        // resolving to two different real locations (e.g. a bind-mount or a
        // race between the check and the write). ensureSafeParent's own
        // realpath comparison is the second, independent guard against
        // exactly that gap — reached here by making the SECOND of its two
        // `realpathSync` calls (the parent's) answer with a path outside
        // whatever the FIRST call (the root's) answered. The first call is
        // left on the mock's default call-through implementation, so only
        // the parent's resolution is forced to diverge.
        const manifest: SkillInstallManifest = { version: 1, files: {} };
        const spec: ManagedSkillFile = {
            relPath: join("escape", "sub", "SKILL.md"),
            content: Buffer.from("x"),
            skill: "escape",
            owner: "canonical",
            kind: "skill",
        };
        // SAFETY: `mockImplementationOnce` must match `realpathSync`'s
        // overloaded signature; ensureSafeParent only ever calls it with a
        // single string path and reads the result as a string, so a
        // same-shape stub is sound for these two queued calls.
        const mockedRealpathSync = vi.mocked(realpathSync);
        const callThrough = mockedRealpathSync.getMockImplementation();
        mockedRealpathSync
            .mockImplementationOnce(
                (...args: Parameters<typeof realpathSync>) =>
                    callThrough!(...args) as ReturnType<typeof realpathSync>,
            )
            .mockImplementationOnce(() => "/definitely-outside-the-repo" as ReturnType<typeof realpathSync>);
        try {
            expect(() => writeManagedSkillFiles(tmpRoot, manifest, [spec])).toThrow(
                `Skill target parent escapes the repository: ${spec.relPath}`,
            );
        } finally {
            vi.mocked(realpathSync).mockClear();
        }
    });
});

describe("removeManagedSkillFiles — stale manifest entry cleanup", () => {
    it("clears a manifest entry when the file it points to is already gone", () => {
        const manifest: SkillInstallManifest = {
            version: 1,
            files: {
                [join("stale", "a.md")]: {
                    sha256: "x".repeat(64),
                    skill: "a",
                    owner: "canonical",
                    kind: "skill",
                },
            },
        };

        const changed = removeManagedSkillFiles(tmpRoot, manifest, [
            { relPath: join("stale", "a.md") },
        ]);

        expect(changed).toBe(false);
        expect(manifest.files[join("stale", "a.md")]).toBeUndefined();
        // hadEntry(true) + now-undefined must independently trigger a save
        // even though `changed` itself is false — pins the `changed ||
        // manifestChanged` OR, distinct from the all-false case covered by
        // "does not touch the manifest file at all when there is nothing to
        // change" below.
        expect(existsSync(join(tmpRoot, SKILL_INSTALL_MANIFEST))).toBe(true);
    });

    it("does not touch the manifest file at all when there is nothing to change", () => {
        // No manifest entry, no file on disk: hadEntry=false and removeOne returns
        // false without deleting anything, so `changed || manifestChanged` must be
        // false and saveSkillInstallManifest must never run.
        const manifest: SkillInstallManifest = { version: 1, files: {} };
        const changed = removeManagedSkillFiles(tmpRoot, manifest, [
            { relPath: join("never", "existed.md") },
        ]);
        expect(changed).toBe(false);
        expect(existsSync(join(tmpRoot, SKILL_INSTALL_MANIFEST))).toBe(false);
    });

    it("leaves an untracked, unrecognized file on disk and does not touch the manifest", () => {
        const target = join(tmpRoot, "untracked", "a.md");
        write(target, "not managed by us\n");
        const manifest: SkillInstallManifest = { version: 1, files: {} };

        const changed = removeManagedSkillFiles(tmpRoot, manifest, [
            { relPath: join("untracked", "a.md") },
        ]);

        expect(changed).toBe(false);
        expect(existsSync(target)).toBe(true);
        expect(readFileSync(target, "utf-8")).toBe("not managed by us\n");
        expect(existsSync(join(tmpRoot, SKILL_INSTALL_MANIFEST))).toBe(false);
    });

    it("drops manifest ownership but preserves the file when the owned file was modified", () => {
        // A digest mismatch means the user touched the file: removeOne must NOT
        // delete it, but it DOES drop the (now-stale) manifest entry, and that
        // drop alone must be enough to trigger a manifest save (manifestChanged).
        const relPath = join("modified", "a.md");
        const target = join(tmpRoot, relPath);
        write(target, "user changed this\n");
        const manifest: SkillInstallManifest = {
            version: 1,
            files: {
                [relPath]: {
                    sha256: "0".repeat(64),
                    skill: "a",
                    owner: "canonical",
                    kind: "skill",
                },
            },
        };

        const changed = removeManagedSkillFiles(tmpRoot, manifest, [{ relPath }]);

        expect(changed).toBe(false);
        expect(existsSync(target)).toBe(true);
        expect(readFileSync(target, "utf-8")).toBe("user changed this\n");
        expect(manifest.files[relPath]).toBeUndefined();
        expect(existsSync(join(tmpRoot, SKILL_INSTALL_MANIFEST))).toBe(true);
    });

    it("removes an owned, unmodified file and reports changed=true", () => {
        const relPath = join("owned", "a.md");
        const target = join(tmpRoot, relPath);
        write(target, "managed content\n");
        const manifest: SkillInstallManifest = {
            version: 1,
            files: {
                [relPath]: {
                    sha256: contentDigest(Buffer.from("managed content\n")),
                    skill: "a",
                    owner: "canonical",
                    kind: "skill",
                },
            },
        };

        const changed = removeManagedSkillFiles(tmpRoot, manifest, [{ relPath }]);

        expect(changed).toBe(true);
        expect(existsSync(target)).toBe(false);
        expect(manifest.files[relPath]).toBeUndefined();
    });

    it("removes an unmanifested file only when isRecognizedLegacy strictly returns true", () => {
        const relPath = join("legacy", "a.md");
        const target = join(tmpRoot, relPath);
        write(target, "legacy content\n");
        const manifest: SkillInstallManifest = { version: 1, files: {} };

        // A truthy-but-not-strictly-true return value must NOT count as recognized
        // (pins the `=== true` identity check, not a loose truthiness check).
        const notStrictlyTrue = removeManagedSkillFiles(tmpRoot, manifest, [
            // SAFETY: deliberately violating the declared boolean return type to
            // prove the implementation checks `=== true`, not plain truthiness.
            { relPath, isRecognizedLegacy: () => "yes" as unknown as boolean },
        ]);
        expect(notStrictlyTrue).toBe(false);
        expect(existsSync(target)).toBe(true);

        const recognized = removeManagedSkillFiles(tmpRoot, manifest, [
            { relPath, isRecognizedLegacy: () => true },
        ]);
        expect(recognized).toBe(true);
        expect(existsSync(target)).toBe(false);
    });

    it("prunes empty parent directories after removal but stops at the repository root", () => {
        const relPath = join("prune", "only-child", "SKILL.md");
        const target = join(tmpRoot, relPath);
        write(target, "content\n");
        const manifest: SkillInstallManifest = {
            version: 1,
            files: {
                [relPath]: {
                    sha256: contentDigest(Buffer.from("content\n")),
                    skill: "a",
                    owner: "canonical",
                    kind: "skill",
                },
            },
        };
        // Captured before the call: tmpRoot is otherwise empty at the moment
        // pruning reaches it (the manifest save that would recreate a deleted
        // root hasn't run yet), so an inode change here is the only way to
        // observe a wrongly-attempted rmdir on the stop boundary itself — the
        // final existsSync check alone can't, because mkdirSync({recursive})
        // inside the subsequent saveSkillInstallManifest call would silently
        // recreate a deleted root and existsSync would still read true.
        const rootIno = statSync(tmpRoot).ino;

        removeManagedSkillFiles(tmpRoot, manifest, [{ relPath }]);

        expect(existsSync(join(tmpRoot, "prune", "only-child"))).toBe(false);
        expect(existsSync(join(tmpRoot, "prune"))).toBe(false);
        // The repository root itself must never be pruned: same inode, not a
        // delete-then-recreate.
        expect(existsSync(tmpRoot)).toBe(true);
        expect(statSync(tmpRoot).ino).toBe(rootIno);
    });

    it("does not prune past a 5-directory-deep boundary from the removed file", () => {
        // dirs (deepest first, relative to root): f, e, d, c, b, a — six levels.
        // pruneEmptyParents loops for depth 0..4 (5 iterations): it removes
        // f, e, d, c, b and then stops, leaving "a" behind even though it is
        // now empty. This pins the `depth < 5` loop bound.
        const relPath = join("a", "b", "c", "d", "e", "f", "SKILL.md");
        const target = join(tmpRoot, relPath);
        write(target, "deep\n");
        const manifest: SkillInstallManifest = {
            version: 1,
            files: {
                [relPath]: {
                    sha256: contentDigest(Buffer.from("deep\n")),
                    skill: "a",
                    owner: "canonical",
                    kind: "skill",
                },
            },
        };

        removeManagedSkillFiles(tmpRoot, manifest, [{ relPath }]);

        expect(existsSync(join(tmpRoot, "a", "b", "c", "d", "e", "f"))).toBe(false);
        expect(existsSync(join(tmpRoot, "a", "b", "c", "d", "e"))).toBe(false);
        expect(existsSync(join(tmpRoot, "a", "b"))).toBe(false);
        // "a" survives: only 5 prune iterations run (f,e,d,c,b), not 6.
        expect(existsSync(join(tmpRoot, "a"))).toBe(true);
    });

    it("does not attempt to prune when the removed file lived directly at the repo root", () => {
        // dirname(target) === stopAt on the very first check, so pruneEmptyParents
        // must return immediately without ever calling rmdirSync on the root.
        const relPath = "top-level.md";
        const target = join(tmpRoot, relPath);
        write(target, "root file\n");
        const manifest: SkillInstallManifest = {
            version: 1,
            files: {
                [relPath]: {
                    sha256: contentDigest(Buffer.from("root file\n")),
                    skill: "a",
                    owner: "canonical",
                    kind: "skill",
                },
            },
        };

        const rootIno = statSync(tmpRoot).ino;

        const changed = removeManagedSkillFiles(tmpRoot, manifest, [{ relPath }]);

        expect(changed).toBe(true);
        expect(existsSync(target)).toBe(false);
        expect(existsSync(tmpRoot)).toBe(true);
        // Same inode as before: the root was never rmdir'd and recreated.
        expect(statSync(tmpRoot).ino).toBe(rootIno);
    });
});

describe("removeOwnedFilesForClients", () => {
    function manifestWith(
        entries: Record<string, { skill: string; owner: SkillInstallManifest["files"][string]["owner"] }>,
    ): SkillInstallManifest {
        const files: SkillInstallManifest["files"] = {};
        for (const [relPath, { skill, owner }] of Object.entries(entries)) {
            const target = join(tmpRoot, relPath);
            write(target, `${relPath}\n`);
            files[relPath] = {
                sha256: contentDigest(Buffer.from(`${relPath}\n`)),
                skill,
                owner,
                kind: "skill",
            };
        }
        return { version: 1, files };
    }

    it("removes only files owned by the requested client, leaving canonical files intact", () => {
        const claudePath = join("claude-owned", "SKILL.md");
        const canonicalPath = join("canonical-owned", "SKILL.md");
        const manifest = manifestWith({
            [claudePath]: { skill: "a", owner: "claude" },
            [canonicalPath]: { skill: "a", owner: "canonical" },
        });

        const changed = removeOwnedFilesForClients(tmpRoot, manifest, new Set(["claude"]));

        expect(changed).toBe(true);
        expect(existsSync(join(tmpRoot, claudePath))).toBe(false);
        expect(existsSync(join(tmpRoot, canonicalPath))).toBe(true);
        expect(manifest.files[canonicalPath]).toBeDefined();
    });

    it("leaves files owned by a client that is not in the requested set", () => {
        const copilotPath = join("copilot-owned", "SKILL.md");
        const manifest = manifestWith({
            [copilotPath]: { skill: "a", owner: "copilot" },
        });

        const changed = removeOwnedFilesForClients(tmpRoot, manifest, new Set(["claude"]));

        expect(changed).toBe(false);
        expect(existsSync(join(tmpRoot, copilotPath))).toBe(true);
        expect(manifest.files[copilotPath]).toBeDefined();
    });

    it("filters by skill name when a skills set is provided", () => {
        const wantedPath = join("wanted", "SKILL.md");
        const otherPath = join("other", "SKILL.md");
        const manifest = manifestWith({
            [wantedPath]: { skill: "wanted", owner: "claude" },
            [otherPath]: { skill: "other", owner: "claude" },
        });

        const changed = removeOwnedFilesForClients(
            tmpRoot,
            manifest,
            new Set(["claude"]),
            new Set(["wanted"]),
        );

        expect(changed).toBe(true);
        expect(existsSync(join(tmpRoot, wantedPath))).toBe(false);
        expect(existsSync(join(tmpRoot, otherPath))).toBe(true);
        expect(manifest.files[otherPath]).toBeDefined();
    });

    it("removes files for every skill when the skills filter is omitted", () => {
        const pathA = join("skill-a", "SKILL.md");
        const pathB = join("skill-b", "SKILL.md");
        const manifest = manifestWith({
            [pathA]: { skill: "skill-a", owner: "claude" },
            [pathB]: { skill: "skill-b", owner: "claude" },
        });

        const changed = removeOwnedFilesForClients(tmpRoot, manifest, new Set(["claude"]));

        expect(changed).toBe(true);
        expect(existsSync(join(tmpRoot, pathA))).toBe(false);
        expect(existsSync(join(tmpRoot, pathB))).toBe(false);
    });
});

describe("writeManagedSkillFiles — changed detection and legacy-recognition strictness", () => {
    it("reports changed=true for a brand-new file (no previous content to compare)", () => {
        const manifest: SkillInstallManifest = { version: 1, files: {} };
        const spec: ManagedSkillFile = {
            relPath: join("new", "SKILL.md"),
            content: Buffer.from("fresh"),
            skill: "a",
            owner: "canonical",
            kind: "skill",
        };
        const result = writeManagedSkillFiles(tmpRoot, manifest, [spec]);
        expect(result).toEqual({ changed: true });
        expect(readFileSync(join(tmpRoot, "new", "SKILL.md"), "utf-8")).toBe("fresh");
        // Exact object, not just presence: pins every field written into the
        // manifest entry (ObjectLiteral survivors — a dropped/mis-mapped field
        // would flip this without changing `changed` or the file content).
        expect(manifest.files[spec.relPath]).toEqual({
            sha256: contentDigest(spec.content),
            skill: "a",
            owner: "canonical",
            kind: "skill",
        });
    });

    it("reports changed=false when rewriting identical content over an owned file", () => {
        const manifest: SkillInstallManifest = { version: 1, files: {} };
        const spec: ManagedSkillFile = {
            relPath: join("same", "SKILL.md"),
            content: Buffer.from("stable content"),
            skill: "a",
            owner: "canonical",
            kind: "skill",
        };
        writeManagedSkillFiles(tmpRoot, manifest, [spec]);

        const result = writeManagedSkillFiles(tmpRoot, manifest, [spec]);
        expect(result.changed).toBe(false);
        expect(readFileSync(join(tmpRoot, "same", "SKILL.md"), "utf-8")).toBe("stable content");
    });

    it("refuses to overwrite an unowned file whose isRecognizedLegacy returns a truthy non-true value", () => {
        const relPath = join("almost-legacy", "SKILL.md");
        write(join(tmpRoot, relPath), "some pre-existing content");
        const manifest: SkillInstallManifest = { version: 1, files: {} };
        const spec: ManagedSkillFile = {
            relPath,
            content: Buffer.from("new content"),
            skill: "a",
            owner: "canonical",
            kind: "skill",
            // SAFETY: deliberately violating the declared boolean return type to
            // prove preflightWrite checks `=== true`, not plain truthiness.
            isRecognizedLegacy: () => "truthy but not true" as unknown as boolean,
        };

        expect(() => writeManagedSkillFiles(tmpRoot, manifest, [spec])).toThrow(
            "Refusing to overwrite unowned skill file",
        );
        expect(readFileSync(join(tmpRoot, relPath), "utf-8")).toBe("some pre-existing content");
    });

    it("refuses to overwrite an untracked file with no isRecognizedLegacy hook at all", () => {
        const relPath = join("plain-unowned", "SKILL.md");
        write(join(tmpRoot, relPath), "untouched by us");
        const manifest: SkillInstallManifest = { version: 1, files: {} };
        const spec: ManagedSkillFile = {
            relPath,
            content: Buffer.from("new content"),
            skill: "a",
            owner: "canonical",
            kind: "skill",
        };

        expect(() => writeManagedSkillFiles(tmpRoot, manifest, [spec])).toThrow(
            "Refusing to overwrite unowned skill file",
        );
    });
});

describe("assertSafeSkillPath — isWithin boundary cases", () => {
    it("allows the root itself when relPath resolves to '.'", () => {
        const sub = join(tmpRoot, "plain-subdir");
        mkdirSync(sub, { recursive: true });
        expect(assertSafeSkillPath(sub, ".")).toBe(sub);
    });

    it("rejects the direct parent directory via '..'", () => {
        expect(() => assertSafeSkillPath(tmpRoot, "..")).toThrow("escapes the repository");
    });

    it("rejects a sibling directory that merely shares a string prefix with the root", () => {
        // Construct a relPath that resolves to a sibling of tmpRoot, not a
        // descendant, even though the sibling's name starts with the same
        // characters as tmpRoot's basename plus a suffix (e.g. root
        // ".../skill-installer-safety-abc" vs sibling
        // ".../skill-installer-safety-abc-suffix").
        const siblingName = `${tmpRoot.split("/").pop()}-suffix`;
        expect(() =>
            assertSafeSkillPath(tmpRoot, join("..", siblingName)),
        ).toThrow("escapes the repository");
    });

    it("allows a plain descendant path", () => {
        const target = assertSafeSkillPath(tmpRoot, join("a", "b.md"));
        expect(target).toBe(join(tmpRoot, "a", "b.md"));
    });
});

describe("loadSkillInstallManifest — manifestEntries edge cases", () => {
    it("rejects a manifest whose files property is an array", () => {
        write(join(tmpRoot, SKILL_INSTALL_MANIFEST), JSON.stringify({ version: 1, files: [] }));
        expect(() => loadSkillInstallManifest(tmpRoot)).toThrow(
            /Unsupported or malformed skill install manifest/,
        );
    });

    it("rejects a manifest whose files property is null", () => {
        write(join(tmpRoot, SKILL_INSTALL_MANIFEST), JSON.stringify({ version: 1, files: null }));
        expect(() => loadSkillInstallManifest(tmpRoot)).toThrow(
            /Unsupported or malformed skill install manifest/,
        );
    });

    it("rejects a top-level manifest value that is truthy but not an object (typeof branch, not falsy branch)", () => {
        // `!value || typeof value !== "object"`: 42 is truthy, so this only
        // fails through the `typeof` disjunct, distinct from the `null`/`!value`
        // case above. Kills a mutant that drops or inverts the typeof check.
        write(join(tmpRoot, SKILL_INSTALL_MANIFEST), "42");
        expect(() => loadSkillInstallManifest(tmpRoot)).toThrow(
            /Cannot read .*: Skill install manifest is not an object/,
        );
    });

    it("wraps a JSON parse failure with the manifest path in the message", () => {
        write(join(tmpRoot, SKILL_INSTALL_MANIFEST), "{not valid json");
        expect(() => loadSkillInstallManifest(tmpRoot)).toThrow(
            new RegExp(`Cannot read .*skill-install-manifest\\.json`),
        );
    });

    it("rejects an entry whose owner is not a recognized client or 'canonical'", () => {
        const relPath = join(".interlinked", "skills", "enforce", "SKILL.md");
        write(
            join(tmpRoot, SKILL_INSTALL_MANIFEST),
            JSON.stringify({
                version: 1,
                files: {
                    [relPath]: {
                        sha256: "a".repeat(64),
                        skill: "enforce",
                        owner: "not-a-real-client",
                        kind: "skill",
                    },
                },
            }),
        );
        expect(() => loadSkillInstallManifest(tmpRoot)).toThrow(
            /Malformed skill install manifest entry/,
        );
    });

    it("rejects an entry whose owner is a non-string value", () => {
        const relPath = join(".interlinked", "skills", "enforce", "SKILL.md");
        write(
            join(tmpRoot, SKILL_INSTALL_MANIFEST),
            JSON.stringify({
                version: 1,
                files: {
                    [relPath]: {
                        sha256: "a".repeat(64),
                        skill: "enforce",
                        owner: 7,
                        kind: "skill",
                    },
                },
            }),
        );
        expect(() => loadSkillInstallManifest(tmpRoot)).toThrow(
            /Malformed skill install manifest entry/,
        );
    });

    it("rejects an entry whose sha256 has uppercase hex characters", () => {
        const relPath = join(".interlinked", "skills", "enforce", "SKILL.md");
        write(
            join(tmpRoot, SKILL_INSTALL_MANIFEST),
            JSON.stringify({
                version: 1,
                files: {
                    [relPath]: {
                        sha256: "A".repeat(64),
                        skill: "enforce",
                        owner: "canonical",
                        kind: "skill",
                    },
                },
            }),
        );
        expect(() => loadSkillInstallManifest(tmpRoot)).toThrow(
            /Malformed skill install manifest entry/,
        );
    });

    it("rejects a sha256 one character short of 64 (regex quantifier lower boundary)", () => {
        const relPath = join(".interlinked", "skills", "enforce", "SKILL.md");
        write(
            join(tmpRoot, SKILL_INSTALL_MANIFEST),
            JSON.stringify({
                version: 1,
                files: {
                    [relPath]: {
                        sha256: "a".repeat(63),
                        skill: "enforce",
                        owner: "canonical",
                        kind: "skill",
                    },
                },
            }),
        );
        expect(() => loadSkillInstallManifest(tmpRoot)).toThrow(
            /Malformed skill install manifest entry/,
        );
    });

    it("rejects a sha256 one character longer than 64 (regex quantifier upper boundary)", () => {
        // The regex is unanchored-length-safe only via `^...{64}$`; a trailing
        // extra hex char must still fail the `$` anchor. Distinguishes a
        // mutant that loosens `{64}` to `{64,}` or drops the `$` anchor.
        const relPath = join(".interlinked", "skills", "enforce", "SKILL.md");
        write(
            join(tmpRoot, SKILL_INSTALL_MANIFEST),
            JSON.stringify({
                version: 1,
                files: {
                    [relPath]: {
                        sha256: `${"a".repeat(64)}a`,
                        skill: "enforce",
                        owner: "canonical",
                        kind: "skill",
                    },
                },
            }),
        );
        expect(() => loadSkillInstallManifest(tmpRoot)).toThrow(
            /Malformed skill install manifest entry/,
        );
    });

    it("accepts a sha256 of exactly 64 lowercase hex characters (regex boundary, positive)", () => {
        const relPath = join(".interlinked", "skills", "enforce", "SKILL.md");
        const sha256 = "0123456789abcdef".repeat(4);
        write(
            join(tmpRoot, SKILL_INSTALL_MANIFEST),
            JSON.stringify({
                version: 1,
                files: {
                    [relPath]: { sha256, skill: "enforce", owner: "canonical", kind: "skill" },
                },
            }),
        );
        expect(loadSkillInstallManifest(tmpRoot).files[relPath]?.sha256).toBe(sha256);
    });

    it("accepts a single-character skill name (regex `*` quantifier, not `+`)", () => {
        // If the trailing `[a-z0-9-]*` were mutated to require one-or-more, a
        // single-char skill name would wrongly be rejected.
        const relPath = join(".interlinked", "skills", "a", "SKILL.md");
        write(
            join(tmpRoot, SKILL_INSTALL_MANIFEST),
            JSON.stringify({
                version: 1,
                files: {
                    [relPath]: {
                        sha256: "a".repeat(64),
                        skill: "a",
                        owner: "canonical",
                        kind: "skill",
                    },
                },
            }),
        );
        expect(loadSkillInstallManifest(tmpRoot).files[relPath]?.skill).toBe("a");
    });

    it("rejects a relPath that shares a string prefix with the skill root but is actually a sibling directory", () => {
        // skill "enforce" -> root ".interlinked/skills/enforce"; a path under
        // ".interlinked/skills/enforceX" shares the string "enforce" as a
        // prefix but is a different directory entirely. Only the
        // `${skillRoot}${sep}` (separator-qualified) prefix check may accept
        // it — dropping the `sep` would wrongly accept this.
        const relPath = join(".interlinked", "skills", "enforceX", "SKILL.md");
        write(
            join(tmpRoot, SKILL_INSTALL_MANIFEST),
            JSON.stringify({
                version: 1,
                files: {
                    [relPath]: {
                        sha256: "a".repeat(64),
                        skill: "enforce",
                        owner: "canonical",
                        kind: "skill",
                    },
                },
            }),
        );
        expect(() => loadSkillInstallManifest(tmpRoot)).toThrow(
            /Unsafe skill install manifest entry/,
        );
    });

    it("rejects an entry whose kind is not a string", () => {
        const relPath = join(".interlinked", "skills", "enforce", "SKILL.md");
        write(
            join(tmpRoot, SKILL_INSTALL_MANIFEST),
            JSON.stringify({
                version: 1,
                files: {
                    [relPath]: {
                        sha256: "a".repeat(64),
                        skill: "enforce",
                        owner: "canonical",
                        kind: 42,
                    },
                },
            }),
        );
        expect(() => loadSkillInstallManifest(tmpRoot)).toThrow(
            /Malformed skill install manifest entry/,
        );
    });

    it("accepts a skill name that starts with a digit", () => {
        const relPath = join(".interlinked", "skills", "1skill", "SKILL.md");
        write(
            join(tmpRoot, SKILL_INSTALL_MANIFEST),
            JSON.stringify({
                version: 1,
                files: {
                    [relPath]: {
                        sha256: "a".repeat(64),
                        skill: "1skill",
                        owner: "canonical",
                        kind: "skill",
                    },
                },
            }),
        );
        expect(loadSkillInstallManifest(tmpRoot).files[relPath]?.skill).toBe("1skill");
    });

    it("rejects a skill name that starts with a hyphen", () => {
        const relPath = join(".interlinked", "skills", "-bad", "SKILL.md");
        write(
            join(tmpRoot, SKILL_INSTALL_MANIFEST),
            JSON.stringify({
                version: 1,
                files: {
                    [relPath]: {
                        sha256: "a".repeat(64),
                        skill: "-bad",
                        owner: "canonical",
                        kind: "skill",
                    },
                },
            }),
        );
        expect(() => loadSkillInstallManifest(tmpRoot)).toThrow(
            /Unsafe skill install manifest entry/,
        );
    });

    it("rejects a skill name containing an underscore even in an otherwise valid path", () => {
        const relPath = join(".interlinked", "skills", "bad_name", "SKILL.md");
        write(
            join(tmpRoot, SKILL_INSTALL_MANIFEST),
            JSON.stringify({
                version: 1,
                files: {
                    [relPath]: {
                        sha256: "a".repeat(64),
                        skill: "bad_name",
                        owner: "canonical",
                        kind: "skill",
                    },
                },
            }),
        );
        expect(() => loadSkillInstallManifest(tmpRoot)).toThrow(
            /Unsafe skill install manifest entry/,
        );
    });

    it("rejects a relPath equal to the skill root with no trailing file segment", () => {
        const relPath = join(".interlinked", "skills", "enforce");
        write(
            join(tmpRoot, SKILL_INSTALL_MANIFEST),
            JSON.stringify({
                version: 1,
                files: {
                    [relPath]: {
                        sha256: "a".repeat(64),
                        skill: "enforce",
                        owner: "canonical",
                        kind: "skill",
                    },
                },
            }),
        );
        expect(() => loadSkillInstallManifest(tmpRoot)).toThrow(
            /Unsafe skill install manifest entry/,
        );
    });

    it("accepts the copilot teaching-prompt special case outside the skill root", () => {
        const relPath = join(".github", "prompts", "enforce.prompt.md");
        write(
            join(tmpRoot, SKILL_INSTALL_MANIFEST),
            JSON.stringify({
                version: 1,
                files: {
                    [relPath]: {
                        sha256: "a".repeat(64),
                        skill: "enforce",
                        owner: "copilot",
                        kind: "prompt",
                    },
                },
            }),
        );
        expect(loadSkillInstallManifest(tmpRoot).files[relPath]?.owner).toBe("copilot");
    });

    it("rejects the teaching-prompt path shape for a non-copilot owner", () => {
        const relPath = join(".github", "prompts", "enforce.prompt.md");
        write(
            join(tmpRoot, SKILL_INSTALL_MANIFEST),
            JSON.stringify({
                version: 1,
                files: {
                    [relPath]: {
                        sha256: "a".repeat(64),
                        skill: "enforce",
                        owner: "claude",
                        kind: "prompt",
                    },
                },
            }),
        );
        expect(() => loadSkillInstallManifest(tmpRoot)).toThrow(
            /Unsafe skill install manifest entry/,
        );
    });

    it("rejects a copilot entry whose prompt filename does not match its declared skill", () => {
        const relPath = join(".github", "prompts", "wrong-name.prompt.md");
        write(
            join(tmpRoot, SKILL_INSTALL_MANIFEST),
            JSON.stringify({
                version: 1,
                files: {
                    [relPath]: {
                        sha256: "a".repeat(64),
                        skill: "enforce",
                        owner: "copilot",
                        kind: "prompt",
                    },
                },
            }),
        );
        expect(() => loadSkillInstallManifest(tmpRoot)).toThrow(
            /Unsafe skill install manifest entry/,
        );
    });
});

describe("assertSafeSkillPath — symlinked cwd root (filter(Boolean) on the segment walk)", () => {
    it("does not flag the repository root itself when relPath is a direct child", () => {
        // parentRel is "" for a direct child of root, so
        // "".split(sep).filter(Boolean) is []: zero iterations, root's own
        // symlink-ness is never checked by the per-segment loop (only the
        // target file itself is checked, separately, after the loop). If
        // `.filter(Boolean)` were dropped, "".split(sep) is [""], and
        // path.join(root, "") === root (Node ignores zero-length segments),
        // so the loop would run once with cursor === root and — if root is
        // itself a symlink — wrongly throw here.
        const real = mkdtempSync(join(tmpdir(), "skill-real-root-"));
        const linkRoot = join(tmpRoot, "link-root");
        symlinkSync(real, linkRoot, "dir");
        try {
            expect(assertSafeSkillPath(linkRoot, "file.md")).toBe(join(linkRoot, "file.md"));
        } finally {
            rmSync(real, { recursive: true, force: true });
        }
    });
});

describe("manifestEntries — typeof-object check on `files`, isolated from the falsy check", () => {
    it("rejects a truthy, non-array `files` value that is not an object", () => {
        // `files: "notanobject"` is truthy (so `!candidate.files` is false)
        // and not an array, isolating `typeof candidate.files !== "object"`
        // as the only disjunct that can fire.
        write(
            join(tmpRoot, SKILL_INSTALL_MANIFEST),
            JSON.stringify({ version: 1, files: "notanobject" }),
        );
        expect(() => loadSkillInstallManifest(tmpRoot)).toThrow(
            /Unsupported or malformed skill install manifest/,
        );
    });
});

describe("isSkillOwner — typeof guard, not just key membership", () => {
    it("rejects an array owner whose string coercion happens to match a client name", () => {
        // hasOwnProperty.call(CLIENT_SKILL_ROOTS, key) coerces `key` via
        // ToPropertyKey; a single-element array's ToString is its sole
        // element, so `["claude"]` coerces to the property key "claude" and
        // WOULD pass `hasOwnProperty` even though it is not the string
        // "claude". Only the `typeof value === "string"` guard rejects it.
        const relPath = join(".claude", "skills", "enforce", "SKILL.md");
        write(
            join(tmpRoot, SKILL_INSTALL_MANIFEST),
            JSON.stringify({
                version: 1,
                files: {
                    [relPath]: {
                        sha256: "a".repeat(64),
                        skill: "enforce",
                        // SAFETY: deliberately violating the declared `owner:
                        // SkillOwner` (string) type via a JSON array to prove
                        // the typeof guard, not just key membership, matters.
                        owner: ["claude"],
                        kind: "skill",
                    },
                },
            }),
        );
        expect(() => loadSkillInstallManifest(tmpRoot)).toThrow(
            /Malformed skill install manifest entry/,
        );
    });
});

describe("validatedManifestEntry — null entry value (typeof-null quirk)", () => {
    it("rejects a null entry value with the documented Malformed message, not a raw property-access crash", () => {
        // `typeof null === "object"` in JS, so `null` is the one falsy value
        // where `!value` and `typeof value !== "object"` disagree. This
        // isolates: (a) the `||` vs `&&` choice between them, and (b) whether
        // the guard's block actually runs at all. If either is broken, the
        // code falls through to `(null as Partial<...>).owner`, which throws
        // an uncaught "Cannot read properties of null" TypeError instead of
        // the documented, caught-and-wrapped Malformed message — a crash the
        // caller could not have been coded to expect from this API.
        write(
            join(tmpRoot, SKILL_INSTALL_MANIFEST),
            JSON.stringify({ version: 1, files: { "a.md": null } }),
        );
        expect(() => loadSkillInstallManifest(tmpRoot)).toThrow(
            /Cannot read .*: Malformed skill install manifest entry: a\.md/,
        );
    });
});

describe("validatedManifestEntry — sha256 must actually be typeof string, not merely coerce to one", () => {
    it("rejects a one-element array sha256 whose string coercion happens to look like a valid hash", () => {
        // The regex test coerces its argument via ToString; a single-element
        // array's ToString is its element, so `["<64 lowercase hex chars>"]`
        // coerces to exactly the valid-looking hash and would pass the regex
        // disjunct. Only `typeof entry.sha256 !== "string"` catches that the
        // stored value is not actually a string.
        const relPath = join(".interlinked", "skills", "enforce", "SKILL.md");
        write(
            join(tmpRoot, SKILL_INSTALL_MANIFEST),
            JSON.stringify({
                version: 1,
                files: {
                    [relPath]: {
                        sha256: ["a".repeat(64)],
                        skill: "enforce",
                        owner: "canonical",
                        kind: "skill",
                    },
                },
            }),
        );
        expect(() => loadSkillInstallManifest(tmpRoot)).toThrow(
            /Malformed skill install manifest entry/,
        );
    });
});

describe("validatedManifestEntry — skill must actually be typeof string", () => {
    it("rejects a numeric skill field instead of silently coercing it downstream", () => {
        // A number `skill` value would coerce to a digit-only string that
        // actually PASSES the skill-name regex (`[a-z0-9]` allows digits) —
        // so without the typeof guard the entry reaches
        // `join(ownerRoot, entry.skill)` with a non-string argument, which
        // Node's path.join rejects with a TypeError. Either way (silently
        // accepted, or a raw TypeError) diverges from the documented,
        // caught-and-wrapped Malformed message.
        const relPath = join(".interlinked", "skills", "42", "SKILL.md");
        write(
            join(tmpRoot, SKILL_INSTALL_MANIFEST),
            JSON.stringify({
                version: 1,
                files: {
                    [relPath]: {
                        sha256: "a".repeat(64),
                        skill: 42,
                        owner: "canonical",
                        kind: "skill",
                    },
                },
            }),
        );
        expect(() => loadSkillInstallManifest(tmpRoot)).toThrow(
            /Cannot read .*: Malformed skill install manifest entry: /,
        );
    });
});

describe("loadSkillInstallManifest — error cause preservation", () => {
    it("attaches the underlying JSON.parse failure as `cause` on the wrapped error", () => {
        write(join(tmpRoot, SKILL_INSTALL_MANIFEST), "{not valid json");
        const caught = captureThrown(() => loadSkillInstallManifest(tmpRoot));
        expect(caught).toBeInstanceOf(Error);
        // SAFETY: just asserted `caught` is an Error above; narrowing here
        // only to reach the `.cause` field the wrapper is required to set.
        const outer = caught as Error;
        expect(outer.cause).toBeInstanceOf(Error);
        // SAFETY: just asserted `outer.cause` is an Error above.
        const cause = outer.cause as Error;
        expect(cause.message).toMatch(/JSON|token|Unexpected/i);
    });
});

describe("writeManagedSkillFiles — mixed batch changed-detection (some vs every)", () => {
    it("reports changed=true when only one of several specs actually changed", () => {
        const manifest: SkillInstallManifest = { version: 1, files: {} };
        const unchangedSpec: ManagedSkillFile = {
            relPath: join("mixed", "stable", "SKILL.md"),
            content: Buffer.from("stable"),
            skill: "stable",
            owner: "canonical",
            kind: "skill",
        };
        writeManagedSkillFiles(tmpRoot, manifest, [unchangedSpec]);

        const changedSpec: ManagedSkillFile = {
            relPath: join("mixed", "fresh", "SKILL.md"),
            content: Buffer.from("fresh"),
            skill: "fresh",
            owner: "canonical",
            kind: "skill",
        };
        // unchangedSpec is rewritten with IDENTICAL content alongside a
        // brand-new file: `some` correctly reports changed=true (>= 1
        // changed); `every` would wrongly require ALL specs to have changed
        // and report false, since unchangedSpec did not.
        const result = writeManagedSkillFiles(tmpRoot, manifest, [unchangedSpec, changedSpec]);
        expect(result).toEqual({ changed: true });
    });
});

describe("writeManagedSkillFiles — rollback re-throws the original failure, not a corrupted-bookkeeping crash", () => {
    it("propagates the underlying EACCES failure verbatim after rolling back an earlier write", () => {
        const manifest: SkillInstallManifest = { version: 1, files: {} };
        const specA: ManagedSkillFile = {
            relPath: join("array-decl", "a", "SKILL.md"),
            content: Buffer.from("a"),
            skill: "a",
            owner: "canonical",
            kind: "skill",
        };
        const lockedDir = join(tmpRoot, "array-decl", "locked");
        mkdirSync(lockedDir, { recursive: true });
        chmodSync(lockedDir, 0o555);
        const specB: ManagedSkillFile = {
            relPath: join("array-decl", "locked", "SKILL.md"),
            content: Buffer.from("b"),
            skill: "b",
            owner: "canonical",
            kind: "skill",
        };

        const caught = captureThrown(() =>
            writeManagedSkillFiles(tmpRoot, manifest, [specA, specB]),
        );
        chmodSync(lockedDir, 0o755);

        expect(caught).toBeInstanceOf(Error);
        // SAFETY: just asserted `caught` is an Error above.
        const err = caught as Error;
        // Must be the real filesystem failure (permission denied on the
        // locked directory) surviving rollback intact — not a TypeError from
        // reading `.spec`/`.relPath` off a corrupted `applied` bookkeeping
        // array (e.g. a stray non-PlannedWrite entry seeded into it).
        expect(err.message).toMatch(/EACCES|permission denied/i);
        expect(err.message).not.toContain("Cannot read properties of undefined");
    });
});

describe("writeManagedSkillFiles — rollback manifest bookkeeping removes the key, not just its value", () => {
    it("deletes the manifest key entirely for a rolled-back new file, rather than leaving it set to undefined", () => {
        const manifest: SkillInstallManifest = { version: 1, files: {} };
        const specA: ManagedSkillFile = {
            relPath: join("rollback-key", "a", "SKILL.md"),
            content: Buffer.from("a"),
            skill: "a",
            owner: "canonical",
            kind: "skill",
        };
        const lockedDir = join(tmpRoot, "rollback-key", "locked");
        mkdirSync(lockedDir, { recursive: true });
        chmodSync(lockedDir, 0o555);
        const specB: ManagedSkillFile = {
            relPath: join("rollback-key", "locked", "SKILL.md"),
            content: Buffer.from("b"),
            skill: "b",
            owner: "canonical",
            kind: "skill",
        };

        expect(() => writeManagedSkillFiles(tmpRoot, manifest, [specA, specB])).toThrow();
        chmodSync(lockedDir, 0o755);

        // `manifest.files[key] === undefined` is true whether the key is
        // absent or present-with-value-undefined; hasOwnProperty is the only
        // check that distinguishes them. `if (plan.previousEntry)` (true
        // branch) must NOT run for a brand-new file's rollback (its
        // previousEntry is genuinely undefined) — only the `else delete`
        // branch may.
        expect(
            Object.prototype.hasOwnProperty.call(manifest.files, specA.relPath),
        ).toBe(false);
    });
});

describe("writeManagedSkillFiles — skips the write entirely when content is unchanged", () => {
    it("does not attempt to rewrite a read-only file whose content already matches", () => {
        const manifest: SkillInstallManifest = { version: 1, files: {} };
        const spec: ManagedSkillFile = {
            relPath: join("readonly-unchanged", "SKILL.md"),
            content: Buffer.from("frozen content"),
            skill: "a",
            owner: "canonical",
            kind: "skill",
        };
        writeManagedSkillFiles(tmpRoot, manifest, [spec]);
        const target = join(tmpRoot, spec.relPath);
        chmodSync(target, 0o444);
        // Same content again: if the write were unconditional, this would
        // attempt to overwrite a read-only file and throw EACCES/EPERM. Only
        // skipping the actual writeFileSync call lets this succeed. (No
        // try/finally needed: removing a read-only file only requires write
        // permission on its writable parent directory, so afterEach's forced
        // rmSync cleans it up regardless of how this assertion resolves.)
        const result = writeManagedSkillFiles(tmpRoot, manifest, [spec]);
        expect(result).toEqual({ changed: false });
        chmodSync(target, 0o644);
    });
});

describe("removeOne — legacy-recognition never overrides an existing manifest entry", () => {
    it("refuses to delete a digest-mismatched but manifest-owned file even when isRecognizedLegacy would say yes", () => {
        // recognizedLegacy must require `entry === undefined` (unmanifested).
        // With a manifest entry present but a wrong sha256 (simulating user
        // modification), the file must be preserved regardless of what
        // isRecognizedLegacy returns — that hook exists only for files with
        // NO manifest entry at all.
        const relPath = join("has-entry-wrong-digest", "SKILL.md");
        const target = join(tmpRoot, relPath);
        write(target, "current content\n");
        const manifest: SkillInstallManifest = {
            version: 1,
            files: {
                [relPath]: {
                    sha256: "0".repeat(64),
                    skill: "a",
                    owner: "canonical",
                    kind: "skill",
                },
            },
        };

        const changed = removeManagedSkillFiles(tmpRoot, manifest, [
            { relPath, isRecognizedLegacy: () => true },
        ]);

        expect(changed).toBe(false);
        expect(existsSync(target)).toBe(true);
        expect(readFileSync(target, "utf-8")).toBe("current content\n");
    });
});

describe("removeOwnedFilesForClients — canonical exclusion is a runtime guard, not just a type constraint", () => {
    it("never removes a canonical-owned file even if 'canonical' is (incorrectly) present in the clients set", () => {
        const relPath = join("canonical-defense", "SKILL.md");
        const target = join(tmpRoot, relPath);
        write(target, "canonical content\n");
        const manifest: SkillInstallManifest = {
            version: 1,
            files: {
                [relPath]: {
                    sha256: contentDigest(Buffer.from("canonical content\n")),
                    skill: "a",
                    owner: "canonical",
                    kind: "skill",
                },
            },
        };

        // Deliberately violating the `ReadonlySet<ClientName>` contract
        // (which excludes "canonical") to prove the function's own
        // `entry.owner !== "canonical"` runtime check — not just TypeScript
        // — is what protects canonical-owned files.
        // SAFETY: "canonical" is cast to ClientName only to satisfy the Set's
        // element type; the resulting set is intentionally out-of-contract.
        const clients: ReadonlySet<ClientName> = new Set(["canonical" as ClientName]);
        const changed = removeOwnedFilesForClients(tmpRoot, manifest, clients);

        expect(changed).toBe(false);
        expect(existsSync(target)).toBe(true);
        expect(manifest.files[relPath]).toBeDefined();
    });
});

describe("loadSkillInstallManifest — per-client skill-root string literals", () => {
    it.each([
        ["opencode", join(".opencode", "skills", "enforce", "SKILL.md")],
        ["pi", join(".pi", "skills", "enforce", "SKILL.md")],
    ] as const)("validates a %s-owned entry under its native skill root", (owner, relPath) => {
        write(
            join(tmpRoot, SKILL_INSTALL_MANIFEST),
            JSON.stringify({
                version: 1,
                files: {
                    [relPath]: {
                        sha256: "a".repeat(64),
                        skill: "enforce",
                        owner,
                        kind: "skill",
                    },
                },
            }),
        );
        expect(loadSkillInstallManifest(tmpRoot).files[relPath]?.owner).toBe(owner);
    });

    it("validates a gemini-owned entry under .gemini/skills/<skill>/", () => {
        const relPath = join(".gemini", "skills", "enforce", "SKILL.md");
        write(
            join(tmpRoot, SKILL_INSTALL_MANIFEST),
            JSON.stringify({
                version: 1,
                files: {
                    [relPath]: {
                        sha256: "a".repeat(64),
                        skill: "enforce",
                        owner: "gemini",
                        kind: "skill",
                    },
                },
            }),
        );
        expect(loadSkillInstallManifest(tmpRoot).files[relPath]?.owner).toBe("gemini");
    });

    it("validates a cursor-owned entry under .cursor/skills/<skill>/", () => {
        const relPath = join(".cursor", "skills", "enforce", "SKILL.md");
        write(
            join(tmpRoot, SKILL_INSTALL_MANIFEST),
            JSON.stringify({
                version: 1,
                files: {
                    [relPath]: {
                        sha256: "a".repeat(64),
                        skill: "enforce",
                        owner: "cursor",
                        kind: "skill",
                    },
                },
            }),
        );
        expect(loadSkillInstallManifest(tmpRoot).files[relPath]?.owner).toBe("cursor");
    });

    it("validates a codex-owned entry under .agents/skills/<skill>/", () => {
        const relPath = join(".agents", "skills", "enforce", "SKILL.md");
        write(
            join(tmpRoot, SKILL_INSTALL_MANIFEST),
            JSON.stringify({
                version: 1,
                files: {
                    [relPath]: {
                        sha256: "a".repeat(64),
                        skill: "enforce",
                        owner: "codex",
                        kind: "skill",
                    },
                },
            }),
        );
        expect(loadSkillInstallManifest(tmpRoot).files[relPath]?.owner).toBe("codex");
    });

    it("rejects a gemini path missing the /skills/ segment (pins the literal, not just the directory shape)", () => {
        const relPath = join(".gemini", "enforce", "SKILL.md");
        write(
            join(tmpRoot, SKILL_INSTALL_MANIFEST),
            JSON.stringify({
                version: 1,
                files: {
                    [relPath]: {
                        sha256: "a".repeat(64),
                        skill: "enforce",
                        owner: "gemini",
                        kind: "skill",
                    },
                },
            }),
        );
        expect(() => loadSkillInstallManifest(tmpRoot)).toThrow(
            /Unsafe skill install manifest entry/,
        );
    });
});
