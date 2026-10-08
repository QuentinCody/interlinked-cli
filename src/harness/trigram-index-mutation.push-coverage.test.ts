import { expect, it } from "vitest";
import { type MutableIndexView, updateFileInState } from "./trigram-index-mutation.js";
import { extractTrigrams, MAX_DIRTY_NEW_FILES } from "./trigram-primitives.js";

it("replaces stale searchable text with empty membership when a file becomes binary, then recovers on text", () => {
    const view: MutableIndexView = { fileToId: new Map([["base.ts", 0]]), dirtyOverrides: new Map(),
        dirtyNewFiles: new Map(), allocFileId: () => 1 };
    for (const path of ["base.ts", "new.ts"]) {
        expect(updateFileInState(view, path, "previous searchable content")).toBe(true);
        expect(updateFileInState(view, path, "binary\0payload")).toBe(true);
        const membership = path === "base.ts" ? view.dirtyOverrides.get(0) : view.dirtyNewFiles.get(path)?.trigrams;
        expect(membership?.size).toBe(0);
        expect(updateFileInState(view, path, "restored text")).toBe(true);
        const restored = path === "base.ts" ? view.dirtyOverrides.get(0) : view.dirtyNewFiles.get(path)?.trigrams;
        expect(new Set(restored)).toEqual(extractTrigrams("restored text"));
    }
});

it("caps new-file growth while allowing edits and deletions of files already in the dirty layer", () => {
    const view: MutableIndexView = { fileToId: new Map(), dirtyOverrides: new Map(),
        dirtyNewFiles: new Map(Array.from({ length: MAX_DIRTY_NEW_FILES }, (_, id) => [
            `file-${id}.ts`, { id, trigrams: new Set<number>() },
        ])), allocFileId: () => { throw new Error("a full dirty layer must not allocate another id"); } };
    expect(updateFileInState(view, "overflow.ts", "searchable content")).toBe(false);
    expect(view.dirtyNewFiles.has("overflow.ts")).toBe(false);
    expect(view.dirtyNewFiles.size).toBe(MAX_DIRTY_NEW_FILES);
    expect(updateFileInState(view, "file-0.ts", "updated content")).toBe(true);
    expect(new Set(view.dirtyNewFiles.get("file-0.ts")?.trigrams)).toEqual(extractTrigrams("updated content"));
    expect(updateFileInState(view, "file-0.ts", null)).toBe(true);
    expect(view.dirtyNewFiles.size).toBe(MAX_DIRTY_NEW_FILES - 1);
});

