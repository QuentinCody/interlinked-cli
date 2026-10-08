import { describe, expect, it } from "vitest";
import { CompactTrigrams } from "./compact-trigrams.js";
import { extractTrigrams } from "./trigram-primitives.js";
import { updateFileInState, type MutableIndexView } from "./trigram-index-mutation.js";

describe("compact dirty-file trigrams", () => {
    it("uses compact storage for both base-file overrides and newly observed files", () => {
        const view: MutableIndexView = { fileToId: new Map([["base.ts", 0]]), dirtyOverrides: new Map(),
            dirtyNewFiles: new Map(), allocFileId: () => 1 };
        const content = "export const distinctValue = 123;";
        expect(updateFileInState(view, "base.ts", content)).toBe(true);
        expect(updateFileInState(view, "new.ts", content)).toBe(true);
        for (const entry of [view.dirtyOverrides.get(0), view.dirtyNewFiles.get("new.ts")?.trigrams]) {
            expect(entry).toBeInstanceOf(CompactTrigrams);
            expect(new Set(entry)).toEqual(extractTrigrams(content));
        }
    });

    it("preserves exact membership, iteration and size while using four bytes per unique trigram", () => {
        const reference = extractTrigrams("A varied source file: exported values, identifiers, punctuation.\n日本語 🐈");
        const compact = new CompactTrigrams(reference);
        expect(new Set(compact)).toEqual(reference);
        expect(compact.size).toBe(reference.size);
        expect(compact.byteLength).toBe(reference.size * 4);
        for (const value of reference) expect(compact.has(value)).toBe(true);
        for (const value of [0, 1, 0xffffff]) expect(compact.has(value)).toBe(reference.has(value));
    });

    it("keeps empty and high unsigned trigrams exact without retaining the mutable input set", () => {
        const source = new Set([0, 0xffffff, 0xabcdef, 12]);
        const compact = new CompactTrigrams(source);
        source.clear();
        expect([...compact]).toEqual([0, 12, 0xabcdef, 0xffffff]);
        expect(compact.has(13)).toBe(false);
        expect(new CompactTrigrams(new Set()).has(0)).toBe(false);
        expect(new CompactTrigrams(new Set()).byteLength).toBe(0);
    });
});
