import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { collectStaticMeasurements } from "./static-measurements.js";
import { collectCompositeScoreReport } from "./composite-report.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "metrics-calibration-")); roots.push(root);
    for (const [path, content] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); }
    return root;
}
it("resolves TypeScript path aliases and type-only imports without declaring their modules disconnected", () => {
    const root = fixture({ "tsconfig.json": '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]},"moduleResolution":"bundler","module":"esnext"}}',
        "src/index.ts": 'import { value } from "@/value"; import { type Value } from "./types"; export const result: Value = value;',
        "src/value.ts": 'export const value = { count: 1 };', "src/types.ts": "export interface Value { count: number; }" });
    const result = collectStaticMeasurements(root);
    expect(result.graph.unresolved).toEqual([]);
    expect(result.graph.edges.map(edge => edge.to).sort()).toEqual(["src/types.ts", "src/value.ts"]);
    expect(result.graph.edges.find(edge => edge.to === "src/types.ts")?.typeOnly).toBe(true);
    expect(result.metrics.find(row => row.id === "redundancy.disconnected")?.numerator).toBe(0);
});
it("marks an unresolvable alias inconclusive instead of silently ignoring its edge", () => {
    const result = collectStaticMeasurements(fixture({ "src/index.ts": 'import { missing } from "@/missing"; export const value = missing;' }));
    expect(result.graph.unresolved).toHaveLength(1);
    expect(result.metrics.find(row => row.id === "architecture.cycles")?.state).toBe("inconclusive");
});
it("recognizes declared Next routes as public entry points", () => {
    const result = collectStaticMeasurements(fixture({ "package.json": '{"dependencies":{"next":"15.0.0"}}',
        "app/page.tsx": 'export default function Page() { return <p>Hello</p>; }',
        "app/api/route.ts": 'export function GET() { return "ok"; }' }));
    expect(result.graph.publicEntries.sort()).toEqual(["app/api/route.ts", "app/page.tsx"]);
    expect(result.findings.filter(row => row.metric.startsWith("redundancy."))).toEqual([]);
});
it("does not exempt unused private declarations just because a public barrel imports the file", () => {
    const result = collectStaticMeasurements(fixture({ "package.json": '{"exports":"./index.js"}', "index.js": 'export * from "./value.js";',
        "value.js": "const abandoned = 1; export const value = 2;" }));
    expect(result.findings.some(row => row.metric === "redundancy.unused" && row.message.includes("abandoned"))).toBe(true);
});
it("retains saturation as missing evidence when a detector stops after ten findings", () => {
    const tests = Array.from({ length: 25 }, (_, index) => `it("case ${index}", () => { const unused = ${index}; });`).join("\n");
    const result = collectStaticMeasurements(fixture({ "index.js": "export const value = 1;", "value.test.js": tests }));
    const reading = result.metrics.find(row => row.id === "tests.integrity");
    expect(reading?.denominator).toBe(25);
    expect(reading?.state).toBe("inconclusive");
    expect(reading?.limitations.join()).toContain("lower bound");
});
it("keeps comments out of function size while retaining physical file-length burden", () => {
    const source = "export function identity(value) { return value; }", root = fixture({ "index.js": source });
    const before = collectStaticMeasurements(root);
    writeFileSync(join(root, "index.js"), `${"// comment\n".repeat(800)}${source}`);
    const after = collectStaticMeasurements(root);
    expect(after.metrics.find(row => row.id === "tokens")?.score).toBe(before.metrics.find(row => row.id === "tokens")?.score);
    expect(after.metrics.find(row => row.id === "file.lines")?.score).toBeGreaterThan(0);
});
it("counts direct any propagation but accepts narrowing and sound type widening", () => {
    const result = collectStaticMeasurements(fixture({ "index.ts": [
        "export function identity(value: number): number { return value; }",
        "export function bad(value: any) { const typed: number = value; return identity(value) + typed; }",
        "export function safe(value: unknown) { return typeof value === 'number' ? identity(value) : 0; }",
        "export const literal = { value: 1 } as const; export const wide = literal as unknown;",
    ].join("\n") }));
    const findings = result.findings.filter(row => row.metric === "types.unsafe");
    expect(findings.some(row => row.line === 2 && row.message.includes("boundary"))).toBe(true);
    expect(findings.every(row => row.line === 2)).toBe(true);
    expect(result.metrics.find(row => row.id === "types.unsafe")?.details).toMatchObject({ explicitAnyTypes: 1, explicitUnknownTypes: 2 });
});
it("does not turn unsupported source into a precise whole-repository interval", () => {
    const report = collectCompositeScoreReport(fixture({ "index.js": "export const value = 1;", "component.astro": "<h1>Hello</h1>" }));
    expect(report.rankingEligible).toBe(false);
    expect(report.range).toEqual({ lower: 0, upper: 100 });
    expect(report.scope.notMeasured.some(row => row.path === "component.astro")).toBe(true);
});
it("does not score missing runtime globals as measured any usage", () => {
    const result = collectStaticMeasurements(fixture({ "index.ts": "export const value = missingRuntime.read();" }));
    const reading = result.metrics.find(row => row.id === "types.unsafe");
    expect(reading?.state).toBe("inconclusive");
    expect(reading?.limitations.join()).toContain("unresolved type dependencies or bindings");
});
