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

function childReports(v8Directory, children) {
    const files = readdirSync(v8Directory).filter((file) => file.endsWith(".json"));
    for (const child of children) {
        assert(child.clean, `Child ${child.pid} did not exit cleanly`);
        assert(files.some((file) => file.startsWith(`coverage-${child.pid}-`)), `Child ${child.pid} did not flush V8 coverage`);
    }
    // NODE_V8_COVERAGE is absent from Vitest itself. Additional files here
    // belong to product grandchildren (sidecars/background work), not workers.
    return files.map((file) => JSON.parse(readFileSync(join(v8Directory, file), "utf8")));
}

export async function mergeChildCoverage({ root, v8Directory, inventory, children }) {
    assert(children.length > 0, "No child process coverage evidence");
    const merged = mergeProcessCovs(childReports(v8Directory, children));
    const coverage = createCoverageMap({});
    const loadedSources = new Set();
    for (const script of merged.result) {
        if (!script.url.startsWith("file:")) continue;
        const file = fileURLToPath(script.url);
        if (!file.startsWith(join(root, "dist/"))) continue;
        const code = readFileSync(file, "utf8");
        const sourceMap = JSON.parse(readFileSync(`${file}.map`, "utf8"));
        for (const source of sourceMap.sources) loadedSources.add(relative(root, resolve(file, "..", source)).replaceAll("\\", "/"));
        const converted = await convert({ ast: parseAstAsync(code), code, coverage: script, sourceMap, wrapperLength: 0 });
        coverage.merge(converted);
    }
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
    verifyCoverageProofs(summary, models);
    return { summary, coverage: coverage.toJSON(), inventory: Object.keys(summary).sort() };
}
