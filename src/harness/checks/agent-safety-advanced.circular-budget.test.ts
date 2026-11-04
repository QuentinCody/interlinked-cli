import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { checkCircularImports } from "./agent-safety-advanced.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "circular-budget-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

it("skips oversized imported source while retaining ordinary cycle detection", () => {
    const entry = join(dir, "entry.ts");
    const imported = join(dir, "imported.ts");
    writeFileSync(entry, "export const entry = 1;");
    writeFileSync(imported, "import './entry';\n//" + "x".repeat(256 * 1024));
    expect(checkCircularImports("import './imported';", entry, dir)).toEqual([]);
    writeFileSync(imported, "import './entry';");
    expect(checkCircularImports("import './imported';", entry, dir)).toHaveLength(1);
});

it("bounds traversal of a highly connected acyclic prefix before later imports", () => {
    const entry = join(dir, "entry.ts");
    writeFileSync(entry, "export const entry = 1;");
    writeFileSync(join(dir, "cycle.ts"), "import './entry';");
    const leaves = Array.from({ length: 32 }, (_, i) => `leaf-${i}`);
    for (const leaf of leaves) writeFileSync(join(dir, `${leaf}.ts`), "export const value = 1;");
    const hubs = Array.from({ length: 32 }, (_, i) => `hub-${i}`);
    for (const hub of hubs) writeFileSync(join(dir, `${hub}.ts`), leaves.map(leaf => `import './${leaf}';`).join("\n"));
    const broadSource = [...hubs, "cycle"].map(name => `import './${name}';`).join("\n");
    expect(checkCircularImports(broadSource, entry, dir)).toEqual([]);
    expect(checkCircularImports("import './cycle';", entry, dir)).toHaveLength(1);
});
