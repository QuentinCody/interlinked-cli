import { existsSync, readFileSync, readdirSync, type Dirent } from "node:fs";
import type { NonSharedBuffer } from "node:buffer";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { nonNull } from "./non-null.js";

// `existsSync` and `readdirSync` are partially mocked (delegate to the real
// implementation by default via `vi.fn(actual.fn)`) so the "no bundled
// skills root found on disk" and "a skill resource is a symlink" edges can
// be staged without creating anything inside the real `skills/` tree. Plain
// `vi.spyOn(fs, ...)` throws "Module namespace is not configurable in ESM"
// for node:fs; every other test in this file drives the real filesystem.
vi.mock("node:fs", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs")>();
    return {
        ...actual,
        existsSync: vi.fn(actual.existsSync),
        readdirSync: vi.fn(actual.readdirSync),
    };
});

import {
    ENFORCE_SKILL,
    findSkillSource,
    listInstallableSkills,
    readSkillSourceFiles,
} from "./skill-source-files.js";

function yamlString(content: string, key: string): string | null {
    const match = content.match(new RegExp(`^\\s*${key}:\\s*"([^"]+)"\\s*$`, "m"));
    return match?.[1] ?? null;
}

describe("bundled runner metadata", () => {
    it.each(listInstallableSkills())("%s has discoverable OpenAI metadata", (name) => {
        const skillPath = nonNull(findSkillSource(name));
        const metadataPath = join(dirname(skillPath), "agents", "openai.yaml");
        const metadata = readFileSync(metadataPath, "utf-8");
        const shortDescription = yamlString(metadata, "short_description");
        const defaultPrompt = yamlString(metadata, "default_prompt");

        expect(yamlString(metadata, "display_name")).not.toBeNull();
        expect(shortDescription?.length).toBeGreaterThanOrEqual(25);
        expect(shortDescription?.length).toBeLessThanOrEqual(64);
        expect(defaultPrompt).toContain(`$${name}`);
    });

    it("keeps enforce manual-only", () => {
        const skillPath = nonNull(findSkillSource("enforce"));
        const metadata = readFileSync(
            join(dirname(skillPath), "agents", "openai.yaml"),
            "utf-8",
        );
        expect(metadata).toContain("allow_implicit_invocation: false");
    });

    it("finds no installable skills when no candidate directory holds the marker file", () => {
        vi.mocked(existsSync)
            .mockReturnValueOnce(false)
            .mockReturnValueOnce(false)
            .mockReturnValueOnce(false);
        expect(listInstallableSkills()).toEqual([]);
    });

    it("refuses to bundle a skill resource that is a symlink", () => {
        // SAFETY: walkSkillFiles only calls entry.isSymbolicLink(),
        // entry.isDirectory(), and entry.isFile() on each readdirSync
        // result; this fixture supplies exactly those three methods.
        const fakeEntries = [
            {
                name: "sneaky-link",
                isSymbolicLink: () => true,
                isDirectory: () => false,
                isFile: () => false,
            },
        ] as unknown as Dirent<NonSharedBuffer>[];
        vi.mocked(readdirSync).mockReturnValueOnce(fakeEntries);
        expect(() => readSkillSourceFiles(ENFORCE_SKILL)).toThrow(
            "Bundled skill resources must not be symlinks: sneaky-link",
        );
    });
});
