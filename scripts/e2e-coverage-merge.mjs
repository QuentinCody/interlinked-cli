import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Use the converter shipped with our exactly pinned Vitest V8 provider.
// Resolve relative to that provider so npm's hoisting layout is irrelevant.
const provider = createRequire(import.meta.resolve("@vitest/coverage-v8/package.json"));
const { mergeProcessCovs } = provider("@bcoe/v8-coverage");
const { createCoverageMap } = provider("istanbul-lib-coverage");
const { convert } = await import(provider.resolve("ast-v8-to-istanbul"));
const { parseAstAsync } = await import("vite");

export function verifyCoverageProofs(summary, models = {}) {
    for (const [path, name] of [["src/harness/server/pre-tool-pipeline.ts", "runPreToolPipeline"], ["src/hook-entry-cold-gates.ts", "coldDestructiveCommandBlockReason"]]) {
        assert(summary[path]?.lines.covered > 0, `Child coverage proof missing: ${path}`);
        const model = models[path];
        const id = Object.keys(model?.fnMap ?? {}).find((key) => model.fnMap[key].name === name);
        assert(id !== undefined && model.f[id] > 0, `Child coverage proof never called ${name}: module initialization is insufficient`);
    }
    const uncalled = summary["src/harness/break-glass.ts"];
    assert(uncalled?.functions.total > 0 && uncalled.functions.covered === 0 && uncalled.lines.total > uncalled.lines.covered,
        "Uncalled-function proof missing: zero hits must remain in the executable model");
}

function childReportFiles(v8Directory, children) {
    const files = readdirSync(v8Directory).filter((file) => file.endsWith(".json"));
    for (const child of children) {
        assert(child.clean, `Child ${child.pid} did not exit cleanly`);
        assert(files.some((file) => file.startsWith(`coverage-${child.pid}-`)), `Child ${child.pid} did not flush V8 coverage`);
    }
    // NODE_V8_COVERAGE is absent from Vitest itself. Additional files here
    // belong to product grandchildren (sidecars/background work), not workers.
    return files;
}

function isDistScript(root, script) {
    return script.url.startsWith("file:") && fileURLToPath(script.url).startsWith(join(root, "dist/"));
}

/** Read one raw report at a time, retaining only product coverage for one lossless bulk merge. */
export function mergeChildReports({ root, v8Directory, children }) {
    assert(children.length > 0, "No child process coverage evidence");
    const files = childReportFiles(v8Directory, children);
    const timings = { read_ms: 0, read_files: files.length, read_scripts: 0, retained_scripts: 0, merge_ms: 0 };
    const reports = [];
    for (const file of files) {
        const started = performance.now();
        const report = JSON.parse(readFileSync(join(v8Directory, file), "utf8"));
        timings.read_scripts += report.result.length;
        const result = report.result.filter((script) => isDistScript(root, script));
        timings.retained_scripts += result.length;
        if (result.length > 0) reports.push({ result });
        timings.read_ms += performance.now() - started;
    }
    // V8 function/block granularity precedence is not associative: merging an
    // already merged report again can change both ranges and hit counts.
    const started = performance.now();
    const merged = mergeProcessCovs(reports);
    timings.merge_ms = elapsed(started);
    timings.read_ms = Math.round(timings.read_ms);
    timings.merged_scripts = merged.result.length;
    return { merged, timings };
}

/**
 * The ONE ledger row for a merge: `post_ms` is the whole operation, and the per-phase profile travels in `detail`
 * so the phases are never a second row that `query stages --sum post_ms` would add to the total again.
 */
export function mergeStageRow(status, postMs, timings) {
    return { check: "e2e-merge", status, post_ms: postMs, detail: { ...timings } };
}

/** Milliseconds since `started`, rounded: the merger's own profile, one number per phase. */
function elapsed(started) {
    return Math.round(performance.now() - started);
}

/** Source-maps every merged dist script into one Istanbul map; returns the map and the sources the maps name. */
async function convertDistScripts(root, scripts) {
    const coverage = createCoverageMap({});
    const loadedSources = new Set();
    let converted = 0;
    for (const script of scripts) {
        if (!isDistScript(root, script)) continue;
        const file = fileURLToPath(script.url);
        const code = readFileSync(file, "utf8");
        const sourceMap = JSON.parse(readFileSync(`${file}.map`, "utf8"));
        for (const source of sourceMap.sources) loadedSources.add(relative(root, resolve(file, "..", source)).replaceAll("\\", "/"));
        coverage.merge(await convert({ ast: parseAstAsync(code), code, coverage: script, sourceMap, wrapperLength: 0 }));
        converted += 1;
    }
    return { coverage, loadedSources, converted };
}

/** Per-inventory-file summaries and executable models from the merged map; a boundary file without a model is a failure. */
function summarizeInventory(root, inventory, { coverage, loadedSources }) {
    const summary = {};
    const models = {};
    const byPath = new Map(coverage.files().map((file) => [relative(root, file).replaceAll("\\", "/"), file]));
    for (const path of inventory) {
        assert(loadedSources.has(path), `Boundary source is absent from loaded bundle maps: ${path}`);
        const measured = byPath.get(path);
        assert(measured, `Source-mapped coverage has no executable model for ${path}`);
        const fileCoverage = coverage.fileCoverageFor(measured);
        models[path] = fileCoverage.toJSON();
        const counts = fileCoverage.toSummary().toJSON();
        // Zero executable lines carry an obligation but no coverage denominator.
        if (counts.lines.total > 0) summary[path] = counts;
    }
    return { summary, models };
}

/**
 * Merges every child's raw V8 output into one Istanbul map over the boundary inventory. `timings` (ms per phase
 * plus the counts that explain them) is returned beside the result so the runner can ledger each phase: the
 * numbers come first, and a fix is applied only to the phase the numbers blame.
 */
export async function mergeChildCoverage({ root, v8Directory, inventory, children }) {
    const { merged, timings } = mergeChildReports({ root, v8Directory, children });
    let started = performance.now();
    const conversion = await convertDistScripts(root, merged.result);
    timings.convert_ms = elapsed(started);
    timings.converted_scripts = conversion.converted;
    started = performance.now();
    const { summary, models } = summarizeInventory(root, inventory, conversion);
    verifyCoverageProofs(summary, models);
    const result = { summary, coverage: conversion.coverage.toJSON(), inventory: Object.keys(summary).sort() };
    timings.summary_ms = elapsed(started);
    return { ...result, timings };
}
