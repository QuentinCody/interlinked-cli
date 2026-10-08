import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { adapterIdentity } from "./adapter-identity.js";

it("invalidates the adapter identity when a same-named executable changes", () => {
    const root = mkdtempSync(join(tmpdir(), "decision-adapter-"));
    try {
        const file = join(root, "engine");
        writeFileSync(file, "first", { mode: 0o700 });
        const before = adapterIdentity(file);
        writeFileSync(file, "second");
        expect(adapterIdentity(file)).not.toBe(before);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
