// Unit B review (2026-09-24, scratch/review-project-e2e-unit-b/REVIEW.md):
// six false-pass / silent-loss paths in discovery, adoption and surfaces.
// Each case below reproduces the reviewer's probe and pins the correction.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acceptAllContracts, fixtureProject, injectPersistenceDefect, type FixtureProject } from "./__tests__/fixture-projects.js";
import { adoptPolicy } from "./adopt.js";
import { discoverProjects, formatDiscovery } from "./discover.js";
import { evaluateE2e } from "./evaluate.js";
import { E2E_POLICY_PATH, loadE2ePolicy, parseE2ePolicy, type E2ePolicy } from "./policy.js";
import { runProjectE2e } from "./run.js";
import { discoverSurfaces, mapSurfaces } from "./surfaces.js";

const projects: FixtureProject[] = [];
const roots: string[] = [];
afterEach(() => { for (const project of projects.splice(0)) rmSync(project.root, { recursive: true, force: true }); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function temp(): string { const root = realpathSync(mkdtempSync(join(tmpdir(), "e2e-unit-b-"))); roots.push(root); return root; }
function save(path: string, value: unknown): void { writeFileSync(path, JSON.stringify(value)); }
function policyOf(root: string): E2ePolicy { const loaded = loadE2ePolicy(root); if (loaded.status !== "configured") throw new Error(loaded.status); return loaded.policy; }
const TIMEOUT = 90_000;

describe("Unit B review — B1 flat layouts (positive: the real source is protected)", () => {
    it("P1: a flat TypeScript CLI at the repository root protects its discovered executable, never a nonexistent src/**", () => {
        const root = temp();
        save(join(root, "package.json"), { name: "flat-cli", bin: { flat: "cli.ts" } }); save(join(root, "tsconfig.json"), {});
        writeFileSync(join(root, "cli.ts"), "console.log('untested');\n");
        const found = discoverProjects(root).projects[0]!;
        expect(found.proposal.protectedInputs).toContain("cli.ts");
        expect(found.proposal.protectedInputs).not.toContain("src/**");
    });
    it("P2: a Python package directory (with __init__.py) is protected as a whole", () => {
        const root = temp();
        writeFileSync(join(root, "pyproject.toml"), '[project]\nname = "orders"\nversion = "1"\n[project.scripts]\norders = "orders.cli:main"\n');
        mkdirSync(join(root, "orders")); writeFileSync(join(root, "orders/__init__.py"), ""); writeFileSync(join(root, "orders/cli.py"), "def main():\n    print('ran')\n");
        expect(discoverProjects(root).projects[0]!.proposal.protectedInputs).toContain("orders/**");
    });
});
describe("Unit B review — B1 required adoption (negative: never an empty success)", () => {
    it("N1: adopting required mode with no scenarios is refused; an unprotected flat CLI can no longer pass check with an empty verdict list", () => {
        const root = temp();
        save(join(root, "package.json"), { name: "flat-cli", bin: { flat: "cli.ts" } }); save(join(root, "tsconfig.json"), {});
        writeFileSync(join(root, "cli.ts"), "console.log('untested');\n");
        const report = discoverProjects(root);
        expect(() => adoptPolicy({ root, proposal: report, mode: "required", atMs: 1 })).toThrow(/no scenarios.*certifies nothing/);
        // Advisory adoption still writes, and the protected executable is a visible mapping gap rather than silence.
        adoptPolicy({ root, proposal: report, atMs: 1 });
        const verdict = evaluateE2e({ root, atMs: 2 });
        expect(verdict.mappingGaps.map(gap => gap.path)).toContain("cli.ts");
    });
    it("N2: adopting required mode when the protected globs match no file on disk is refused before any write", () => {
        const project = fixtureProject("ts"); projects.push(project);
        const report = discoverProjects(project.root);
        report.proposal.projects[0]!.protectedInputs = ["nowhere/**"];
        expect(() => adoptPolicy({ root: project.root, proposal: report, mode: "required", replace: true, atMs: 1 })).toThrow(/protectedInputs.*match no file/);
        expect(readFileSync(join(project.root, E2E_POLICY_PATH), "utf8")).toContain("\"order-persists\""); // untouched
    });
});
describe("Unit B review — B2 build binding", () => {
    it("P1: on a clean TypeScript fixture discovery binds the build script as a shared input and the absent contract input's directory as an artifact", () => {
        const project = fixtureProject("ts"); projects.push(project);
        const found = discoverProjects(project.root).projects[0]!;
        expect(found.build?.artifacts).toEqual(["dist/**"]);
        expect(found.build?.inputs).toEqual(["build.mjs"]);
        expect(found.proposal.sharedInputs).toContain("build.mjs");
        expect(found.proposal.suites[0]?.artifacts).toEqual(["dist/**"]);
    });
    it("P2: discover → adopt required → supervised run passes on the clean fixture, and breaking build.mjs makes check stale until a fresh run fails", async () => {
        const project = fixtureProject("ts", { accept: true }); projects.push(project);
        const report = discoverProjects(project.root);
        adoptPolicy({ root: project.root, proposal: report, mode: "required", replace: true, atMs: 1 });
        const first = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        expect(first.exitCode, first.messages.join("\n")).toBe(0);
        expect(evaluateE2e({ root: project.root, atMs: 2 }).exitCode).toBe(0);
        writeFileSync(join(project.root, "build.mjs"), "process.exit(7);\n");
        const after = evaluateE2e({ root: project.root, atMs: 3 });
        expect(after.exitCode).toBe(1);
        expect(after.verdicts.map(row => row.status)).toContain("stale");
        expect((await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT })).exitCode).not.toBe(0);
    }, TIMEOUT);
    it("N1: a build whose outputs cannot be inferred is an explicit gap naming suites[].artifacts, not an empty artifact list", () => {
        const root = temp();
        save(join(root, "package.json"), { name: "opaque", scripts: { build: "make" }, bin: { opaque: "out/opaque.js" } });
        const found = discoverProjects(root).projects[0]!;
        expect(found.build?.artifacts).toEqual([]);
        expect(found.gaps.join("\n")).toMatch(/build outputs.*artifacts/);
    });
});
describe("Unit B review — B3 explicit surface declarations (the language-independent fallback)", () => {
    it("P1: a project-level surfaces list is validated, merged into the inventory with policy provenance, and binds through surfaceIds", () => {
        const project = fixtureProject("ts"); projects.push(project);
        const policy = policyOf(project.root);
        policy.projects[0]!.surfaces = [{ id: "cli:custom", kind: "other", address: "custom-command", description: "a Zig binary no extractor knows" }];
        policy.projects[0]!.scenarios[0]!.surfaceIds = ["cli:custom"];
        expect(() => parseE2ePolicy(JSON.stringify(policy))).not.toThrow();
        const inventory = discoverSurfaces(project.root, policy);
        const declared = inventory.projects[0]!.surfaces.find(row => row.id === "cli:custom");
        expect(declared).toMatchObject({ kind: "other", address: "custom-command", discovery: { method: "policy" }, source: { path: E2E_POLICY_PATH } });
        expect(mapSurfaces(inventory, policy).find(row => row.surface.id === "cli:custom")).toMatchObject({ state: "explicit", scenarioIds: ["order-persists"] });
    });
    it("N1: a malformed declaration (unknown kind, duplicate id, empty address) is refused by the parser", () => {
        const project = fixtureProject("ts"); projects.push(project);
        const base = policyOf(project.root);
        const attempt = (surfaces: unknown[]) => { const policy = JSON.parse(JSON.stringify(base)); policy.projects[0].surfaces = surfaces; return () => parseE2ePolicy(JSON.stringify(policy)); };
        expect(attempt([{ id: "x", kind: "grpc", address: "a" }])).toThrow(/kind/);
        expect(attempt([{ id: "x", kind: "cli", address: "a" }, { id: "x", kind: "cli", address: "b" }])).toThrow(/unique/);
        expect(attempt([{ id: "x", kind: "cli", address: "" }])).toThrow(/address/);
    });
});
describe("Unit B review — B4 OpenAPI references", () => {
    const REF_DOC = { openapi: "3.1.0", paths: { "/orders": { $ref: "#/components/pathItems/Orders" } }, components: { pathItems: { Orders: { get: { operationId: "listOrders" } } } } };
    it("P1: a local path-item $ref is resolved and its operations are extracted", () => {
        const project = fixtureProject("ts"); projects.push(project);
        save(join(project.root, "openapi.json"), REF_DOC);
        const found = discoverSurfaces(project.root, policyOf(project.root)).projects[0]!;
        expect(found.surfaces.map(row => row.id)).toEqual(["http:listOrders"]);
        expect(found.complete).toBe(true);
    });
    it("N1: an unresolvable or external $ref is an incomplete inventory naming the reference, never a complete empty one", () => {
        const project = fixtureProject("ts"); projects.push(project);
        save(join(project.root, "openapi.json"), { openapi: "3.1.0", paths: { "/orders": { $ref: "other.json#/x" }, "/ghost": { $ref: "#/components/pathItems/Missing" } } });
        const found = discoverSurfaces(project.root, policyOf(project.root)).projects[0]!;
        expect(found.surfaces).toEqual([]);
        expect(found.complete).toBe(false);
        expect(found.limits.join("\n")).toMatch(/other\.json#\/x/);
        expect(found.limits.join("\n")).toMatch(/#\/components\/pathItems\/Missing/);
    });
});
describe("Unit B review — B5 Python console entry points", () => {
    it("P1: [project.scripts] module:callable is invoked as that callable, and it becomes a CLI surface", () => {
        const root = temp();
        writeFileSync(join(root, "pyproject.toml"), '[project]\nname = "orders"\nversion = "1"\n[project.scripts]\norders = "orders_cli:main"\n');
        writeFileSync(join(root, "orders_cli.py"), 'def main():\n    print("ORDERS CLI RAN")\n');
        const report = discoverProjects(root);
        const executable = report.projects[0]!.executables.find(row => row.kind === "python-entry")!;
        expect(executable.argv).not.toEqual(["python3", "-m", "orders_cli"]);
        const ran = spawnSync(executable.argv[0]!, executable.argv.slice(1), { cwd: root, encoding: "utf8" });
        expect(ran.stdout).toContain("ORDERS CLI RAN");
        expect(executable.source).toMatch(/orders_cli:main/);
        expect(discoverSurfaces(root, report.proposal).projects[0]!.surfaces).toEqual([expect.objectContaining({ id: "cli:orders", address: "orders_cli:main", discovery: { method: "python-entry", version: 1 } })]);
    });
    it("N1: a console entry whose module file cannot be found is reported as a gap and not proposed as an executable", () => {
        const root = temp();
        writeFileSync(join(root, "pyproject.toml"), '[project]\nname = "orders"\nversion = "1"\n[project.scripts]\norders = "vendor.ghost:main"\n');
        writeFileSync(join(root, "keep.py"), "if __name__ == '__main__':\n    pass\n");
        const found = discoverProjects(root).projects[0]!;
        expect(found.executables.map(row => row.id)).not.toContain("orders");
        expect(found.gaps.join("\n")).toMatch(/vendor\.ghost:main/);
    });
});
describe("Unit B review — B6 depth bound", () => {
    it("N1: a package below the depth limit is recorded as an omitted subtree in limits, gaps and text output", () => {
        const root = temp();
        save(join(root, "package.json"), { name: "root" });
        mkdirSync(join(root, "a/b/c/d/e"), { recursive: true }); save(join(root, "a/b/c/d/e/package.json"), { name: "deep" });
        const report = discoverProjects(root);
        expect(report.projects.map(row => row.root)).toEqual(["."]);
        expect(report.limits.omittedSubtrees).toEqual(["a/b/c/d/e"]);
        expect(report.gaps.join("\n")).toMatch(/a\/b\/c\/d\/e.*not inspected/);
        expect(formatDiscovery(report).join("\n")).toMatch(/omitted/);
    });
    it("P1: a fully inspected tree records no omitted subtrees", () => {
        const project = fixtureProject("py"); projects.push(project);
        expect(discoverProjects(project.root).limits.omittedSubtrees).toEqual([]);
    });
});
// Round 2 (REVIEW-round2.md, C1–C3): quoting, read-vs-write evidence, exit status.
describe("Unit B review round 2 — C1 quoted build scripts", () => {
    function quotedFixture(): FixtureProject {
        const project = fixtureProject("ts", { accept: true }); projects.push(project);
        mkdirSync(join(project.root, "scripts")); renameSync(join(project.root, "build.mjs"), join(project.root, "scripts/build.mjs"));
        const pkg = JSON.parse(readFileSync(join(project.root, "package.json"), "utf8")); pkg.scripts.build = 'node "scripts/build.mjs"'; save(join(project.root, "package.json"), pkg);
        return project;
    }
    it("P1: a quoted script path (double, single, escaped space) is bound as a build input", () => {
        const project = quotedFixture();
        expect(discoverProjects(project.root).projects[0]!.build?.inputs).toEqual(["scripts/build.mjs"]);
        const pkg = JSON.parse(readFileSync(join(project.root, "package.json"), "utf8"));
        pkg.scripts.build = "node 'scripts/build.mjs'"; save(join(project.root, "package.json"), pkg);
        expect(discoverProjects(project.root).projects[0]!.build?.inputs).toEqual(["scripts/build.mjs"]);
        mkdirSync(join(project.root, "my scripts")); writeFileSync(join(project.root, "my scripts/b.mjs"), "");
        pkg.scripts.build = "node my\\ scripts/b.mjs"; save(join(project.root, "package.json"), pkg);
        expect(discoverProjects(project.root).projects[0]!.build?.inputs).toEqual(["my scripts/b.mjs"]);
    });
    it("P2: breaking the quoted build script after a green run makes check stale (the script is a shared input)", async () => {
        const project = quotedFixture();
        adoptPolicy({ root: project.root, proposal: discoverProjects(project.root), mode: "required", replace: true, atMs: 1 });
        expect((await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT })).exitCode).toBe(0);
        writeFileSync(join(project.root, "scripts/build.mjs"), "process.exit(7);\n");
        expect(evaluateE2e({ root: project.root, atMs: 3 }).exitCode).toBe(1);
    }, TIMEOUT);
    it("N1: a build command whose script cannot be resolved (variable, missing file) is an unresolved build-input gap", () => {
        const project = fixtureProject("ts"); projects.push(project);
        const pkg = JSON.parse(readFileSync(join(project.root, "package.json"), "utf8"));
        pkg.scripts.build = "node $BUILD_SCRIPT"; save(join(project.root, "package.json"), pkg);
        expect(discoverProjects(project.root).projects[0]!.gaps.join("\n")).toMatch(/build input.*\$BUILD_SCRIPT.*sharedInputs/);
        pkg.scripts.build = "node scripts/missing.mjs"; save(join(project.root, "package.json"), pkg);
        expect(discoverProjects(project.root).projects[0]!.gaps.join("\n")).toMatch(/build input.*scripts\/missing\.mjs/);
    });
});
describe("Unit B review round 2 — C2 read-vs-write evidence", () => {
    it("N1: a directory the build script only READS is never an artifact, so a declared input under it keeps its freshness check", async () => {
        const project = fixtureProject("ts", { accept: true }); projects.push(project);
        mkdirSync(join(project.root, "lib")); writeFileSync(join(project.root, "lib/value.txt"), "original");
        const buildPath = join(project.root, "build.mjs"); writeFileSync(buildPath, `${readFileSync(buildPath, "utf8")}\nreadFileSync("lib/value.txt", "utf8");\n`);
        const manifestPath = join(project.root, ".interlinked/behavioral-contracts.json"), manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        manifest.cases[0].inputs.push("lib/value.txt"); manifest.cases[0].expect.files["lib/value.txt"] = "original"; save(manifestPath, manifest); acceptAllContracts(project.root);
        const report = discoverProjects(project.root);
        expect(report.projects[0]!.build?.artifacts).toEqual(["dist/**"]);
        adoptPolicy({ root: project.root, proposal: report, mode: "required", replace: true, atMs: 1 });
        expect((await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT })).exitCode).toBe(0);
        writeFileSync(join(project.root, "lib/value.txt"), "changed");
        expect(evaluateE2e({ root: project.root, atMs: 3 }).exitCode).toBe(1);
    }, TIMEOUT);
    it("P1: a directory the build script WRITES (mkdir/writeFile/outDir) is an artifact", () => {
        const project = fixtureProject("ts"); projects.push(project);
        writeFileSync(join(project.root, "build.mjs"), 'import { mkdirSync } from "node:fs";\nmkdirSync("out", { recursive: true });\n');
        expect(discoverProjects(project.root).projects[0]!.build?.artifacts).toContain("out/**");
        const pkg = JSON.parse(readFileSync(join(project.root, "package.json"), "utf8"));
        pkg.scripts.build = "tsc --outDir build"; save(join(project.root, "package.json"), pkg);
        expect(discoverProjects(project.root).projects[0]!.build?.artifacts).toContain("build/**");
    });
    it("N2: an inferred artifact glob covering an EXISTING declared contract input is a named conflict gap and the glob is NOT proposed", () => {
        const project = fixtureProject("ts"); projects.push(project);
        mkdirSync(join(project.root, "dist")); writeFileSync(join(project.root, "dist/seed.txt"), "x");
        const manifestPath = join(project.root, ".interlinked/behavioral-contracts.json"), manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        manifest.cases[0].inputs.push("dist/seed.txt"); save(manifestPath, manifest);
        const found = discoverProjects(project.root).projects[0]!;
        expect(found.gaps.join("\n")).toMatch(/dist\/seed\.txt.*declared input.*dist\/\*\*.*kept in freshness tracking/);
        expect(found.build?.conflicts).toEqual([{ glob: "dist/**", inputs: ["dist/seed.txt"] }]);
        expect(found.proposal.suites[0]?.artifacts).toEqual([]);
    });
});
// Round 3 (REVIEW-round3.md, D1): a conflict must survive adoption, not just print.
describe("Unit B review round 3 — D1 artifact/input conflicts survive adoption", () => {
    function conflictFixture(): FixtureProject {
        const project = fixtureProject("ts", { accept: true }); projects.push(project);
        mkdirSync(join(project.root, "lib")); writeFileSync(join(project.root, "lib/value.txt"), "original");
        const buildPath = join(project.root, "build.mjs");
        writeFileSync(buildPath, `${readFileSync(buildPath, "utf8")}\nmkdirSync("lib", { recursive: true });\nreadFileSync("lib/value.txt", "utf8");\n`);
        const manifestPath = join(project.root, ".interlinked/behavioral-contracts.json"), manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        manifest.cases[0].inputs.push("lib/value.txt"); manifest.cases[0].expect.files["lib/value.txt"] = "original"; save(manifestPath, manifest); acceptAllContracts(project.root);
        return project;
    }
    it("P1: an existing declared input under a directory the build only mkdirs stays tracked: discover → adopt required → run 0 → edit → check 1 → fresh run fails", async () => {
        const project = conflictFixture();
        const report = discoverProjects(project.root);
        expect(report.projects[0]!.build?.artifacts).toEqual(["dist/**"]);
        expect(report.projects[0]!.build?.conflicts).toEqual([{ glob: "lib/**", inputs: ["lib/value.txt"] }]);
        const adopted = adoptPolicy({ root: project.root, proposal: report, mode: "required", replace: true, atMs: 1 });
        expect(adopted.notes.join("\n")).toMatch(/lib\/value\.txt.*kept in freshness tracking/);
        expect((await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT })).exitCode).toBe(0);
        writeFileSync(join(project.root, "lib/value.txt"), "changed");
        const after = evaluateE2e({ root: project.root, atMs: 3 });
        expect(after.exitCode).toBe(1);
        expect(after.verdicts.map(row => row.status)).toContain("stale");
        expect((await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT })).exitCode).not.toBe(0);
    }, TIMEOUT);
    it("P2: an existing declared input the script WRITES by exact path (a pre-built dist/cli.js) is generated output, not a conflict", () => {
        const project = fixtureProject("ts"); projects.push(project);
        expect(spawnSync(process.execPath, ["build.mjs"], { cwd: project.root, encoding: "utf8" }).status).toBe(0);
        const found = discoverProjects(project.root).projects[0]!;
        expect(found.build?.artifacts).toEqual(["dist/**"]);
        expect(found.build?.conflicts).toEqual([]);
    });
    it("N1: a required adoption whose artifacts still cover a reported conflict is refused, and a hand-written policy with the same shape is refused too", () => {
        const project = conflictFixture();
        const report = discoverProjects(project.root);
        report.proposal.projects[0]!.suites[0]!.artifacts = ["dist/**", "lib/**"];
        expect(() => adoptPolicy({ root: project.root, proposal: report, mode: "required", replace: true, atMs: 1 })).toThrow(/lib\/\*\*.*lib\/value\.txt/);
        const policy: E2ePolicy = { ...report.proposal, projects: report.proposal.projects.map(row => ({ ...row, mode: "required" })) };
        expect(() => adoptPolicy({ root: project.root, proposal: policy, mode: "required", replace: true, atMs: 1 })).toThrow(/lib\/\*\*.*lib\/value\.txt/);
    });
});
// Round 4 (REVIEW-round4.md, E1–E2): write evidence is positional; evidence comes from the suite's prepare steps.
describe("Unit B review round 4 — E1 copy sources are not write targets", () => {
    function declareInput(root: string, path: string, content: string): void {
        const manifestPath = join(root, ".interlinked/behavioral-contracts.json"), manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        manifest.cases[0].inputs.push(path); manifest.cases[0].expect.files[path] = content; save(manifestPath, manifest); acceptAllContracts(root);
    }
    it("N1: a declared input that the build only COPIES FROM stays tracked: discover → adopt required → run 0 → edit → check 1 → fresh run fails", async () => {
        const project = fixtureProject("ts", { accept: true }); projects.push(project);
        mkdirSync(join(project.root, "lib")); writeFileSync(join(project.root, "lib/value.txt"), "original");
        const buildPath = join(project.root, "build.mjs");
        writeFileSync(buildPath, `${readFileSync(buildPath, "utf8")}\nimport { copyFileSync } from "node:fs";\nmkdirSync("lib", { recursive: true });\ncopyFileSync("lib/value.txt", "dist/value.txt");\n`);
        declareInput(project.root, "lib/value.txt", "original");
        const report = discoverProjects(project.root);
        expect(report.projects[0]!.build?.artifacts).toEqual(["dist/**"]);
        expect(report.projects[0]!.build?.conflicts).toEqual([{ glob: "lib/**", inputs: ["lib/value.txt"] }]);
        adoptPolicy({ root: project.root, proposal: report, mode: "required", replace: true, atMs: 1 });
        expect((await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT })).exitCode).toBe(0);
        writeFileSync(join(project.root, "lib/value.txt"), "changed");
        expect(evaluateE2e({ root: project.root, atMs: 3 }).exitCode).toBe(1);
        expect((await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT })).exitCode).not.toBe(0);
    }, TIMEOUT);
    it("P1: a declared input that IS a copy/rename destination or a first-argument write target is generated output, not a conflict", () => {
        const project = fixtureProject("ts"); projects.push(project);
        mkdirSync(join(project.root, "dist")); writeFileSync(join(project.root, "dist/seed.txt"), "x"); writeFileSync(join(project.root, "dist/moved.txt"), "y"); writeFileSync(join(project.root, "dist/written.txt"), "z");
        writeFileSync(join(project.root, "build.mjs"), 'import { copyFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";\nmkdirSync("dist", { recursive: true });\ncopyFileSync("seed.txt", "dist/seed.txt");\nrenameSync("tmp.txt", "dist/moved.txt");\nwriteFileSync("dist/written.txt", "z");\n');
        for (const path of ["dist/seed.txt", "dist/moved.txt", "dist/written.txt"]) declareInput(project.root, path, "");
        const found = discoverProjects(project.root).projects[0]!;
        expect(found.build?.artifacts).toEqual(["dist/**"]);
        expect(found.build?.conflicts).toEqual([]);
    });
    it("N2: a write call whose destination is a variable is not evidence for any existing input", () => {
        const project = fixtureProject("ts"); projects.push(project);
        mkdirSync(join(project.root, "dist")); writeFileSync(join(project.root, "dist/seed.txt"), "x");
        writeFileSync(join(project.root, "build.mjs"), 'import { writeFileSync, mkdirSync } from "node:fs";\nconst target = "dist/seed.txt";\nmkdirSync("dist", { recursive: true });\nwriteFileSync(target, "x");\n');
        declareInput(project.root, "dist/seed.txt", "x");
        const found = discoverProjects(project.root).projects[0]!;
        expect(found.build?.conflicts).toEqual([{ glob: "dist/**", inputs: ["dist/seed.txt"] }]);
    });
});
// SAFETY (tests below): the fixture policy is written by fixturePolicy() and re-parsed by adoptPolicy's strict parser before any write.
describe("Unit B review round 4 — E2 evidence follows the suite's declared prepare steps", () => {
    it("P1: a policy whose suite prepares with an explicit argv (no npm scripts.build) adopts in required mode on a pre-built tree", () => {
        const project = fixtureProject("ts", { accept: true }); projects.push(project);
        const pkgPath = join(project.root, "package.json"), pkg = JSON.parse(readFileSync(pkgPath, "utf8")); delete pkg.scripts; save(pkgPath, pkg);
        expect(spawnSync(process.execPath, ["build.mjs"], { cwd: project.root, encoding: "utf8" }).status).toBe(0);
        const policy = JSON.parse(readFileSync(join(project.root, E2E_POLICY_PATH), "utf8")) as E2ePolicy;
        expect(policy.projects[0]!.suites[0]!.prepare).toEqual([{ argv: ["node", "build.mjs"] }]);
        expect(adoptPolicy({ root: project.root, proposal: policy, mode: "required", replace: true, atMs: 1 }).written).toBe(true);
    });
    it("N1: the same pre-built tree with a prepare step that does not write dist/cli.js is refused in required mode", () => {
        const project = fixtureProject("ts", { accept: true }); projects.push(project);
        const pkgPath = join(project.root, "package.json"), pkg = JSON.parse(readFileSync(pkgPath, "utf8")); delete pkg.scripts; save(pkgPath, pkg);
        expect(spawnSync(process.execPath, ["build.mjs"], { cwd: project.root, encoding: "utf8" }).status).toBe(0);
        writeFileSync(join(project.root, "noop.mjs"), "console.log('nothing');\n");
        const policy = JSON.parse(readFileSync(join(project.root, E2E_POLICY_PATH), "utf8")) as E2ePolicy;
        policy.projects[0]!.suites[0]!.prepare = [{ argv: ["node", "noop.mjs"] }];
        expect(() => adoptPolicy({ root: project.root, proposal: policy, mode: "required", replace: true, atMs: 1 })).toThrow(/dist\/\*\*.*dist\/cli\.js/);
    });
    it("P2: an npm alias in prepare resolves through package.json scripts to its script file, so discovery and explicit policies agree", () => {
        const project = fixtureProject("ts", { accept: true }); projects.push(project);
        expect(spawnSync(process.execPath, ["build.mjs"], { cwd: project.root, encoding: "utf8" }).status).toBe(0);
        const policy = JSON.parse(readFileSync(join(project.root, E2E_POLICY_PATH), "utf8")) as E2ePolicy;
        policy.projects[0]!.suites[0]!.prepare = [{ argv: ["npm", "run", "build"] }];
        expect(adoptPolicy({ root: project.root, proposal: policy, mode: "required", replace: true, atMs: 1 }).written).toBe(true);
    });
});
// Round 5 (REVIEW-round5.md, F1–F2): freshness never depends on textual evidence; evidence is per suite.
describe("Unit B review round 5 — F1 an existing declared input never leaves the generation", () => {
    function inputFixture(): FixtureProject {
        const project = fixtureProject("ts", { accept: true }); projects.push(project);
        mkdirSync(join(project.root, "lib")); writeFileSync(join(project.root, "lib/value.txt"), "original");
        const manifestPath = join(project.root, ".interlinked/behavioral-contracts.json"), manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        manifest.cases[0].inputs.push("lib/value.txt"); manifest.cases[0].expect.files["lib/value.txt"] = "original"; save(manifestPath, manifest); acceptAllContracts(project.root);
        return project;
    }
    async function lifecycle(root: string): Promise<{ initial: number; checkAfterEdit: number; freshRun: number }> {
        const initial = (await runProjectE2e({ root, timeoutMs: TIMEOUT })).exitCode;
        writeFileSync(join(root, "lib/value.txt"), "changed");
        const checkAfterEdit = evaluateE2e({ root, atMs: 3 }).exitCode;
        const freshRun = (await runProjectE2e({ root, timeoutMs: TIMEOUT })).exitCode;
        return { initial, checkAfterEdit, freshRun };
    }
    for (const [name, code] of [
        ["a concatenated destination (`\"lib/value.txt\" + \".bak\"`)", 'writeFileSync("lib/value.txt" + ".bak", readFileSync("lib/value.txt"));'],
        ["a commented-out writer", '// writeFileSync("lib/value.txt", "original");\nreadFileSync("lib/value.txt");'],
    ] as const) {
        it(`N: ${name} is no write evidence — discovery keeps the input tracked and the lifecycle goes stale after an edit`, async () => {
            const project = inputFixture();
            const buildPath = join(project.root, "build.mjs");
            writeFileSync(buildPath, `${readFileSync(buildPath, "utf8")}\nmkdirSync("lib", { recursive: true });\n${code}\n`);
            const report = discoverProjects(project.root);
            expect(report.projects[0]!.build?.artifacts).toEqual(["dist/**"]);
            expect(report.projects[0]!.build?.conflicts).toEqual([{ glob: "lib/**", inputs: ["lib/value.txt"] }]);
            adoptPolicy({ root: project.root, proposal: report, mode: "required", replace: true, atMs: 1 });
            expect(await lifecycle(project.root)).toEqual({ initial: 0, checkAfterEdit: 1, freshRun: 1 });
        }, TIMEOUT);
    }
    it("N3: STRUCTURAL — even when a policy declares lib/** as an artifact (advisory adoption, no refusal), the existing input stays in the generation and an edit goes stale", async () => {
        const project = inputFixture();
        const policy = JSON.parse(readFileSync(join(project.root, E2E_POLICY_PATH), "utf8")) as E2ePolicy; // SAFETY: fixture-authored, re-parsed on load
        policy.projects[0]!.suites[0]!.artifacts = ["dist/**", "lib/**"];
        writeFileSync(join(project.root, E2E_POLICY_PATH), JSON.stringify(policy));
        expect(await lifecycle(project.root)).toEqual({ initial: 0, checkAfterEdit: 1, freshRun: 1 });
    }, TIMEOUT);
    it("P1: an existing build OUTPUT that preparation rewrites with different bytes is not preparation drift (the run still passes)", async () => {
        const project = fixtureProject("ts", { accept: true }); projects.push(project);
        const buildPath = join(project.root, "build.mjs");
        writeFileSync(buildPath, `${readFileSync(buildPath, "utf8")}\nwriteFileSync("dist/cli.js", readFileSync("dist/cli.js", "utf8") + "\\n// built " + Date.now() + "\\n");\n`);
        expect(spawnSync(process.execPath, ["build.mjs"], { cwd: project.root, encoding: "utf8" }).status).toBe(0);
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        expect(result.exitCode, result.messages.join("\n")).toBe(0);
        expect(evaluateE2e({ root: project.root, atMs: 3 }).exitCode).toBe(0);
    }, TIMEOUT);
});
describe("Unit B review round 5 — F2 evidence is per suite", () => {
    function repairFixture(): { project: FixtureProject; policy: E2ePolicy } {
        const project = fixtureProject("ts", { accept: true }); projects.push(project);
        mkdirSync(join(project.root, "lib")); writeFileSync(join(project.root, "lib/value.txt"), "original");
        const manifestPath = join(project.root, ".interlinked/behavioral-contracts.json"), manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        manifest.cases[0].inputs.push("lib/value.txt"); manifest.cases[0].expect.files["lib/value.txt"] = "original"; save(manifestPath, manifest); acceptAllContracts(project.root);
        writeFileSync(join(project.root, "repair.mjs"), 'import { writeFileSync } from "node:fs"; writeFileSync("lib/value.txt", "original");\n');
        const policy = JSON.parse(readFileSync(join(project.root, E2E_POLICY_PATH), "utf8")) as E2ePolicy; // SAFETY: fixture-authored, re-parsed by adoptPolicy
        policy.projects[0]!.suites[0]!.artifacts = ["dist/**", "lib/**"];
        policy.projects[0]!.suites.push({ id: "repair", adapter: "managed-contracts", prepare: [{ argv: ["node", "repair.mjs"] }], artifacts: ["lib/**"] });
        return { project, policy };
    }
    it("N1: a writer in an unused suite does not discharge the active suite's artifact conflict — required adoption is refused", () => {
        const { project, policy } = repairFixture();
        expect(() => adoptPolicy({ root: project.root, proposal: policy, mode: "required", replace: true, atMs: 1 })).toThrow(/suite cli.*lib\/\*\*.*lib\/value\.txt/);
    });
    it("N2: the refusal is per SELECTED suite — a scenario filter that binds only the repair suite is judged against the repair suite's own evidence", () => {
        const { project, policy } = repairFixture();
        policy.projects[0]!.scenarios.push({ id: "repaired", suite: "repair", affects: ["repair.mjs"], contractIds: ["orders.create"], required: true }); // affects must not overlap the suite's artifacts (round-6 G1)
        expect(() => adoptPolicy({ root: project.root, proposal: policy, mode: "required", replace: true, scenarioIds: ["repaired"], atMs: 1 })).not.toThrow();
        expect(() => adoptPolicy({ root: project.root, proposal: policy, mode: "required", replace: true, scenarioIds: ["order-persists"], atMs: 1 })).toThrow(/suite cli/);
    });
});
// Round 6 (REVIEW-round6.md, G1): an artifact exemption never overrides a SOURCE role.
describe("Unit B review round 6 — G1 protected source keeps its drift check even when an artifact glob covers it", () => {
    function rewritingFixture(): { project: FixtureProject; policy: E2ePolicy; broken: string } {
        const project = fixtureProject("py", { accept: true }); projects.push(project);
        const source = join(project.root, project.sourceFile), good = readFileSync(source, "utf8");
        injectPersistenceDefect(project);
        writeFileSync(join(project.root, "prepare.mjs"), `import { writeFileSync } from "node:fs";\nwriteFileSync("orders_cli.py", ${JSON.stringify(good)});\n`);
        const policy = JSON.parse(readFileSync(join(project.root, E2E_POLICY_PATH), "utf8")) as E2ePolicy; // SAFETY: fixture-authored, re-parsed on load
        policy.projects[0]!.suites[0]!.prepare = [{ argv: ["node", "prepare.mjs"] }];
        policy.projects[0]!.suites[0]!.artifacts = ["orders_cli.py"];
        return { project, policy, broken: readFileSync(source, "utf8") };
    }
    it("N1: required adoption refuses an artifact glob that covers a protected/affects source", () => {
        const { project, policy } = rewritingFixture();
        expect(() => adoptPolicy({ root: project.root, proposal: policy, mode: "required", replace: true, atMs: 1 })).toThrow(/orders_cli\.py.*protected source/);
    });
    it("N2: STRUCTURAL — with the policy written directly, preparation that replaces the broken source in the snapshot is still drift: no case runs, check stays open, live source stays broken", async () => {
        const { project, policy, broken } = rewritingFixture();
        writeFileSync(join(project.root, E2E_POLICY_PATH), JSON.stringify(policy));
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        expect(result.exitCode).not.toBe(0);
        const receipt = JSON.parse(readFileSync(join(project.root, result.receipts[0]!.path), "utf8"));
        expect(receipt.completion.reasons.join("\n")).toMatch(/preparation modified declared input orders_cli\.py/);
        expect(evaluateE2e({ root: project.root, atMs: 3 }).exitCode).not.toBe(0);
        expect(readFileSync(join(project.root, project.sourceFile), "utf8")).toBe(broken);
    }, TIMEOUT);
});
// Round 7 (REVIEW-round7.md, H1–H2): source wins across the whole suite execution; prepare scripts are always inputs.
describe("Unit B review round 7 — H1 a source obligation wins across scenarios", () => {
    it("N1: STRUCTURAL — a second scenario that only consumes the source as an artifact-covered case input cannot exempt it from drift when both scenarios run", async () => {
        const project = fixtureProject("py", { accept: true }); projects.push(project);
        const source = join(project.root, project.sourceFile), good = readFileSync(source, "utf8");
        injectPersistenceDefect(project);
        const broken = readFileSync(source, "utf8");
        writeFileSync(join(project.root, "prepare.mjs"), `import { writeFileSync } from "node:fs";\nwriteFileSync("orders_cli.py", ${JSON.stringify(good)});\n`);
        const policy = JSON.parse(readFileSync(join(project.root, E2E_POLICY_PATH), "utf8")) as E2ePolicy; // SAFETY: fixture-authored, re-parsed on load
        const target = policy.projects[0]!;
        target.suites[0]!.prepare = [{ argv: ["node", "prepare.mjs"] }];
        target.suites[0]!.artifacts = ["orders_cli.py"];
        target.scenarios[0]!.contractIds = ["orders.create"];
        target.scenarios.push({ ...target.scenarios[0]!, id: "invalid-input", affects: ["prepare.mjs"], contractIds: ["orders.invalid"] });
        writeFileSync(join(project.root, E2E_POLICY_PATH), JSON.stringify(policy));
        expect((await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT, scenarioIds: ["order-persists"] })).exitCode).not.toBe(0);
        const together = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        expect(together.exitCode).not.toBe(0);
        expect(readFileSync(join(project.root, together.receipts[0]!.path), "utf8")).toMatch(/preparation modified declared input orders_cli\.py/);
        expect(evaluateE2e({ root: project.root, atMs: 3 }).exitCode).not.toBe(0);
        expect(readFileSync(source, "utf8")).toBe(broken);
    }, TIMEOUT);
});
describe("Unit B review round 7 — H2 prepare scripts keep their input role under any artifact glob", () => {
    function prepareFixture(): { project: FixtureProject; policy: E2ePolicy } {
        const project = fixtureProject("py", { accept: true }); projects.push(project);
        writeFileSync(join(project.root, "prepare.mjs"), "// initial preparation\n");
        const policy = JSON.parse(readFileSync(join(project.root, E2E_POLICY_PATH), "utf8")) as E2ePolicy; // SAFETY: fixture-authored, re-parsed on load
        policy.projects[0]!.suites[0]!.prepare = [{ argv: ["node", "prepare.mjs"] }];
        policy.projects[0]!.suites[0]!.artifacts = ["prepare.mjs"];
        return { project, policy };
    }
    it("N1: required adoption refuses an artifact glob that covers a prepare script", () => {
        const { project, policy } = prepareFixture();
        expect(() => adoptPolicy({ root: project.root, proposal: policy, mode: "required", replace: true, atMs: 1 })).toThrow(/prepare\.mjs.*protected source/);
    });
    it("N2: STRUCTURAL — with the policy written directly, breaking the artifact-covered prepare script after a green run makes check stale and a fresh run fail", async () => {
        const { project, policy } = prepareFixture();
        writeFileSync(join(project.root, E2E_POLICY_PATH), JSON.stringify(policy));
        expect((await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT })).exitCode).toBe(0);
        writeFileSync(join(project.root, "prepare.mjs"), "process.exit(1);\n");
        expect(evaluateE2e({ root: project.root, atMs: 3 }).exitCode).toBe(1);
        expect((await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT })).exitCode).not.toBe(0);
    }, TIMEOUT);
});
describe("Unit B review round 2 — C3 console-script exit semantics", () => {
    function entryProject(body: string): string {
        const root = temp();
        writeFileSync(join(root, "pyproject.toml"), '[project]\nname = "orders"\nversion = "1"\n[project.scripts]\norders = "orders_cli:main"\n');
        writeFileSync(join(root, "orders_cli.py"), `def main():\n    ${body}\n`);
        return root;
    }
    function exitOf(root: string): { status: number | null; stderr: string } {
        const executable = discoverProjects(root).projects[0]!.executables.find(row => row.kind === "python-entry")!;
        const ran = spawnSync(executable.argv[0]!, executable.argv.slice(1), { cwd: root, encoding: "utf8" });
        return { status: ran.status, stderr: ran.stderr };
    }
    it("P1: the wrapper exits with the callable's integer return, 0 for None, and 1 with the message for a string (sys.exit semantics)", () => {
        expect(exitOf(entryProject("return 2")).status).toBe(2);
        expect(exitOf(entryProject("return None")).status).toBe(0);
        const text = exitOf(entryProject('return "boom"'));
        expect(text.status).toBe(1);
        expect(text.stderr).toContain("boom");
    });
    it("N1: the module file behind the wrapper is still the protected executable source", () => {
        const root = entryProject("return 0");
        expect(discoverProjects(root).projects[0]!.proposal.protectedInputs).toContain("orders_cli.py");
    });
});
