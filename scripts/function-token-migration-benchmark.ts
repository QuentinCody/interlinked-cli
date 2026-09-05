/** Run each adapter in a separate process with --expose-gc for comparable heap/RSS. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { cpus } from "node:os";
import { performance } from "node:perf_hooks";
import { __resetTsCacheForTesting } from "../src/harness/checks/cyclomatic-ast.js";
import { computeTypeScriptFunctionTokens } from "../src/harness/function-tokens/typescript.js";
import { computeLegacyFunctionTokens } from "./function-token-migration-legacy.js";

const adapter = process.argv[2];
if (adapter !== "legacy" && adapter !== "current") throw new Error("Choose legacy or current");
const compute = adapter === "legacy" ? computeLegacyFunctionTokens : computeTypeScriptFunctionTokens;
const paths = process.argv.slice(3);
if (!paths.length) throw new Error("Supply representative source files");
const repetitions = 80;

function percentile(values: number[], fraction: number): number {
    const ordered = [...values].sort((a, b) => a - b);
    return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * fraction))] ?? 0;
}

function sample(file: string, content: string, mode: "cold-parse" | "warm-pair") {
    const after = content + "\n// edit benchmark\n";
    __resetTsCacheForTesting();
    compute(content, file);
    compute(after, file);
    global.gc?.();
    const baselineHeap = process.memoryUsage().heapUsed;
    let peakHeap = baselineHeap, peakRss = process.memoryUsage().rss;
    const durations: number[] = [];
    for (let index = 0; index < repetitions; index++) {
        if (mode === "cold-parse") __resetTsCacheForTesting();
        const started = performance.now();
        if (!compute(content, file) || !compute(after, file)) throw new Error(`${file}: unavailable measurement`);
        durations.push(performance.now() - started);
        const memory = process.memoryUsage();
        peakHeap = Math.max(peakHeap, memory.heapUsed);
        peakRss = Math.max(peakRss, memory.rss);
    }
    global.gc?.();
    return { mode, repetitions, medianMs: percentile(durations, .5), p95Ms: percentile(durations, .95),
        retainedHeapDeltaBytes: process.memoryUsage().heapUsed - baselineHeap,
        sampledHeapGrowthBytes: peakHeap - baselineHeap, sampledPeakRssBytes: peakRss };
}

const rows = paths.map(file => {
    const content = readFileSync(file, "utf8");
    return { file, bytes: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex"),
        samples: [sample(file, content, "cold-parse"), sample(file, content, "warm-pair")] };
});
process.stdout.write(JSON.stringify({ adapter, node: process.version, platform: process.platform,
    arch: process.arch, cpu: cpus()[0]?.model, gcExposed: typeof global.gc === "function",
    timing: "synchronous before+after adapter calls; cold resets AST cache, not Node module cache; warm reuses parsed trees",
    memory: "sampled process heap/RSS, not isolated allocator attribution; GC/JIT and other processes affect results", rows }, null, 2) + "\n");
