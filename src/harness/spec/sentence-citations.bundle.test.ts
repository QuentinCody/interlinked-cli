import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { expect, it } from "vitest";
it("loads the optional compiler in an ESM bundle and extracts a real source-comment citation", async () => {
    const root = mkdtempSync(join(tmpdir(), "spec-citations-bundle-"));
    try {
        const result = await build({ stdin: { contents: `
            import { parseSpecSentences } from ${JSON.stringify(resolve("src/harness/spec/sentences.ts"))};
            import { attachSentenceCitations } from ${JSON.stringify(resolve("src/harness/spec/sentence-citations.ts"))};
            const rows = parseSpecSentences("docs/plan.md", "REQ-1: The command must save the file.");
            const unavailable = attachSentenceCitations(rows, [{file:"src/save.ts", content:"// REQ-1"}]);
            process.stdout.write(JSON.stringify({unavailable, citations:rows[0].citations}));`, resolveDir: process.cwd(), sourcefile: "probe.ts", loader: "ts" },
            bundle: true, platform: "node", format: "esm", write: false });
        const file = join(root, "bundle.mjs"); writeFileSync(file, result.outputFiles[0]!.text);
        const output = JSON.parse(execFileSync(process.execPath, [file], { encoding: "utf8", timeout: 5000 }));
        expect(output).toMatchObject({ unavailable: [], citations: [{ file: "src/save.ts", line: 1, scope: "sentence", reference: "REQ-1" }] });
    } finally { rmSync(root, { recursive: true, force: true }); }
});
