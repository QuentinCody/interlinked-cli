import { spawn } from "node:child_process";
import { corpusPath, readCorpus } from "./corpus.js";

async function countRawLines(files: string[], pattern: string): Promise<number> {
    if (!files.length) return 0;
    return new Promise((resolve, reject) => {
        const child = spawn("rg", ["--no-config", "--text", "--fixed-strings", "--ignore-case", "--count", "--no-filename", "--", pattern, ...files], { stdio: ["ignore", "pipe", "pipe"] });
        let output = "";
        let errors = "";
        const timeout = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("raw grep exceeded five minutes")); }, 300_000);
        child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
        child.stderr.on("data", (chunk: Buffer) => { errors = (errors + chunk.toString()).slice(-4096); });
        child.on("error", (error) => { clearTimeout(timeout); reject(error); });
        child.on("close", (code) => {
            clearTimeout(timeout);
            if (code !== 0 && code !== 1) { reject(new Error(`raw grep exit ${code}: ${errors}`)); return; }
            const counts = output.trim().split(/\s+/).filter(Boolean).map(Number);
            if (counts.some((count) => !Number.isSafeInteger(count))) { reject(new Error("invalid raw grep count")); return; }
            resolve(counts.reduce((sum, count) => sum + count, 0));
        });
    });
}
export async function benchmarkRawGrep(root: string, repetitions: number): Promise<unknown> {
    const corpus = readCorpus(root);
    if (corpus.files.some((file) => file.path.endsWith(".gz"))) return { measured: false, reason: "raw rg lane requires a plain JSONL corpus" };
    const files = corpus.files.map((file) => corpusPath(root, file.path));
    try {
        const queries = [];
        for (const text of ["needle-auth-failure", "typescript", "error"]) {
            const milliseconds: number[] = [];
            let matchingLines = 0;
            for (let i = 0; i < repetitions; i++) {
                const start = performance.now();
                matchingLines = await countRawLines(files, text);
                milliseconds.push(performance.now() - start);
            }
            queries.push({ text, matchingLines, milliseconds });
        }
        return { measured: true, queries, semantics: "Native rg literal search over serialized JSONL, including field names and escaped strings; counts matching lines, not normalized/deduplicated evidence IDs. Includes process launch. Claude UI search is unmeasured." };
    } catch (error) { return { measured: false, error: String(error) }; }
}
