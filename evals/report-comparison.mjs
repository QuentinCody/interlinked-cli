#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nativeHookMetrics } from "./lib/native-hook-metrics.mjs";

function mean(values) { return values.reduce((sum, value) => sum + value, 0) / values.length; }
function percentile(values, fraction) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

export function bootstrapMeanInterval(values) {
    if (!values.length) return null;
    let seed = 937;
    const samples = [];
    for (let repetition = 0; repetition < 2000; repetition++) {
        let sum = 0;
        for (let index = 0; index < values.length; index++) {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            sum += values[seed % values.length];
        }
        samples.push(sum / values.length);
    }
    return [percentile(samples, 0.025), percentile(samples, 0.975)];
}

function readCells(directories) {
    return directories.flatMap(directory => {
        const data = JSON.parse(fs.readFileSync(path.join(directory, "results.json"), "utf8"));
        return data.cells.map(cell => {
            const transcript = path.join(directory, `${cell.task}-${cell.rep}-${cell.arm}`, "native-transcript.jsonl");
            const rendered = fs.existsSync(transcript) ? nativeHookMetrics(fs.readFileSync(transcript, "utf8").trim().split("\n").map(JSON.parse)) : null;
            return { ...cell, evidence_directory: directory, rendered };
        });
    });
}

function sum(cells, selector) { return cells.reduce((total, cell) => total + (selector(cell) ?? 0), 0); }
function aggregate(cells) {
    const durations = cells.flatMap(cell => cell.rendered?.hook_durations_ms ?? []);
    return { sessions: cells.length, correct: cells.filter(cell => cell.success).length,
        infrastructure_failures: cells.filter(cell => cell.infrastructure_error).length,
        seconds: sum(cells, cell => cell.seconds), edits: sum(cells, cell => cell.metrics?.edits),
        attempts: sum(cells, cell => cell.metrics?.turns), blocks: sum(cells, cell => cell.metrics?.blocks_total),
        recorded_warnings: sum(cells, cell => cell.metrics?.warnings),
        transcripts: cells.filter(cell => cell.rendered).length,
        rendered_hook_bytes: sum(cells, cell => cell.rendered?.rendered_hook_bytes),
        repeated_rendered_bytes: sum(cells, cell => cell.rendered?.repeated_rendered_bytes),
        hook_p50_ms: percentile(durations, 0.5), hook_p95_ms: percentile(durations, 0.95),
        native_input_tokens: sum(cells, cell => cell.native?.usage?.input_tokens),
        native_cache_creation_tokens: sum(cells, cell => cell.native?.usage?.cache_creation_input_tokens),
        native_cache_read_tokens: sum(cells, cell => cell.native?.usage?.cache_read_input_tokens),
        native_output_tokens: sum(cells, cell => cell.native?.usage?.output_tokens),
        native_list_cost_usd: sum(cells, cell => cell.native?.reported_cost_usd) };
}

export function pairedDifferences(cells, selector) {
    return cells.filter(cell => cell.arm === "baseline").flatMap(left => {
        const right = cells.find(cell => cell.arm === "candidate" && cell.task === left.task && cell.rep === left.rep
            && cell.evidence_directory === left.evidence_directory);
        const a = selector(left), b = right ? selector(right) : null;
        return left.success && right?.success && a !== null && b !== null ? [b - a] : [];
    });
}

function comparison(cells) {
    const baseline = aggregate(cells.filter(cell => cell.arm === "baseline"));
    const candidate = aggregate(cells.filter(cell => cell.arm === "candidate"));
    const metrics = { seconds: cell => cell.seconds, edits: cell => cell.metrics?.edits ?? null, rendered_hook_bytes: cell => cell.rendered?.rendered_hook_bytes ?? null };
    const paired = Object.fromEntries(Object.entries(metrics).map(([name, selector]) => {
        const differences = pairedDifferences(cells, selector);
        return [name, { pairs: differences.length, mean_candidate_minus_baseline: differences.length ? mean(differences) : null, bootstrap_95_percent_interval: bootstrapMeanInterval(differences) }];
    }));
    return { baseline, candidate, paired };
}

function scorecard(result) {
    const lines = ["# Hook feedback comparison", "", "Frozen whole-build comparison; repeated Claude Fable 5 sessions with independent functional assertions. The builds also contain concurrent unrelated development, so this is not a causal estimate for an individual patch.", "",
        "| Task | Baseline correct | Candidate correct | Mean seconds B → C | Edits B → C | Rendered hook bytes B → C |", "|---|---:|---:|---:|---:|---:|"];
    for (const [task, data] of Object.entries(result.tasks)) {
        const a = data.baseline, b = data.candidate;
        lines.push(`| ${task} | ${a.correct}/${a.sessions} | ${b.correct}/${b.sessions} | ${(a.seconds / a.sessions).toFixed(1)} → ${(b.seconds / b.sessions).toFixed(1)} | ${a.edits} → ${b.edits} | ${a.rendered_hook_bytes} → ${b.rendered_hook_bytes} |`);
    }
    lines.push("", "Aggregate metrics and paired exploratory bootstrap intervals:", "", "```json", JSON.stringify(result.total, null, 2), "```", "",
        "Rendered bytes count native Interlinked hook attachments that precede a later assistant response, including provider wrappers and deduplicating transcript UUIDs. Terminal-only success records and the unconsumed tail are excluded. These are not tokenizer counts or invoices. Native usage categories and client-reported list-price estimates are recorded separately.", "",
        "Paired intervals use only pairs with two correct completions; failures remain in the success totals. Five repetitions per task are a pilot and cannot establish small correctness differences. Missing transcripts are reported, not assumed zero.");
    for (const failure of result.cells.filter(cell => !cell.success)) lines.push("", `Failure: ${failure.task}/${failure.arm}/${failure.rep}: ${failure.infrastructure_error ?? JSON.stringify(failure.oracle)}`);
    return lines.join("\n") + "\n";
}

function main() {
    const [output, ...directories] = process.argv.slice(2);
    if (!output || !directories.length) throw new Error("Usage: node evals/report-comparison.mjs <output-directory> <run-directory>...");
    const cells = readCells(directories), tasks = [...new Set(cells.map(cell => cell.task))];
    const result = { total: comparison(cells), tasks: Object.fromEntries(tasks.map(task => [task, comparison(cells.filter(cell => cell.task === task))])), cells };
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, "comparison.json"), JSON.stringify(result, null, 2));
    fs.writeFileSync(path.join(output, "scorecard.md"), scorecard(result));
    process.stdout.write(JSON.stringify(result.total, null, 2) + "\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
