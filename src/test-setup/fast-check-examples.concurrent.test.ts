import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { readExampleStore } from "./fast-check-examples.js";
it("serializes real worker updates without losing entries or failure history", async () => {
    const root = mkdtempSync(join(tmpdir(), "fc-concurrent-"));
    const file = join(root, "examples.json");
    const module = new URL("./fast-check-examples.ts", import.meta.url).href;
    const script = `import { recordExample } from ${JSON.stringify(module)};
        for (let i = 0; i < 10; i++) recordExample(process.argv[1], process.argv[2] + i,
            {seed:i,path:"0",counterexample:"[]",ts:"2026-10-04T00:00:00Z"});`;
    try {
        await Promise.all(["a", "b"].map(id => promisify(execFile)(process.execPath,
            ["--import", "tsx", "--input-type=module", "-e", script, file, id], { timeout: 15_000 })));
        expect(Object.keys(readExampleStore(file).entries)).toHaveLength(20);
        expect(readFileSync(file + ".history.jsonl", "utf8").trim().split("\n")).toHaveLength(20);
    } finally { rmSync(root, { recursive: true, force: true }); }
}, 20_000);
