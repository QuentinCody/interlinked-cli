import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ContractCase } from "../contracts/types.js";
import { artifactConflictsOf, contractPaths, discoverProjects, formatDiscovery, prepareEvidenceText, pythonEntryPoints, type DiscoveredProject } from "./discover.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
/** Builds a temp tree: a key ending in "/" is an empty directory, any other key is a file with that text. */
function tree(files: Record<string, string>): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "e2e-disc-mut-")));
    roots.push(root);
    for (const [path, text] of Object.entries(files)) {
        if (path.endsWith("/")) { mkdirSync(join(root, path), { recursive: true }); continue; }
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), text);
    }
    return root;
}
const MANIFEST = ".interlinked/behavioral-contracts.json";
const SOURCE = { kind: "requirement", path: "REQ.md", sha256: "a".repeat(64), quote: "q" };
function proc(id: string, argv: string[], inputs: string[] = []): Record<string, unknown> {
    return { id, description: `${id} description`, source: SOURCE, inputs, runner: { kind: "process", argv }, expect: { exitCode: 0 } };
}
function manifest(cases: Array<Record<string, unknown>>): string { return JSON.stringify({ version: 1, cases }); }
function only(root: string): DiscoveredProject { const found = discoverProjects(root).projects; expect(found).toHaveLength(1); return found[0]!; }
function pkg(extra: Record<string, unknown> = {}, name = "app"): string { return JSON.stringify({ name, ...extra }); }

describe("manifest scan — scope and bounds", () => {
    it("P1: ignored directories (node_modules, dist, dot-directories) are never scanned for projects", () => {
        const root = tree({ "package.json": pkg(), "node_modules/dep/package.json": pkg({}, "dep"), "dist/package.json": pkg({}, "d"), ".hidden/package.json": pkg({}, "h"), "real/package.json": pkg({}, "real") });
        expect(discoverProjects(root).projects.map(row => row.root).sort()).toEqual([".", "real"]);
    });
    it("P2: a project four levels deep is found and the level below it is recorded as an omitted subtree", () => {
        const root = tree({ "a/b/c/d/package.json": pkg({}, "deep"), "a/b/c/d/e/package.json": pkg({}, "too-deep") });
        const report = discoverProjects(root);
        expect(report.projects.map(row => row.root)).toEqual(["a/b/c/d"]);
        expect(report.limits.omittedSubtrees).toEqual(["a/b/c/d/e"]);
        expect(report.gaps.join("\n")).toContain("depth bound (4 levels) reached: a/b/c/d/e not inspected (1 subtree(s))");
    });
    it("P3: a project at depth 3 is not an omission and a subtree in a skipped directory is not recorded", () => {
        const root = tree({ "a/b/c/package.json": pkg(), "a/b/c/d/node_modules/x/": "", "a/b/c/d/.git/": "" });
        const report = discoverProjects(root);
        expect(report.limits.omittedSubtrees).toEqual([]);
        expect(report.gaps.join("\n")).not.toContain("depth bound");
    });
    it("P4: the omitted-subtree record is capped at 100 but the gap lists only 8 names and counts the rest", () => {
        const files: Record<string, string> = { "package.json": pkg() };
        for (let i = 0; i < 105; i += 1) files[`a/b/c/d/x${String(i).padStart(3, "0")}/`] = "";
        const report = discoverProjects(tree(files));
        expect(report.limits.omittedSubtrees).toHaveLength(100);
        const gap = report.gaps.find(row => row.startsWith("depth bound"))!;
        expect(gap).toContain("a/b/c/d/x000, a/b/c/d/x001, a/b/c/d/x002, a/b/c/d/x003, a/b/c/d/x004, a/b/c/d/x005, a/b/c/d/x006, a/b/c/d/x007 and 92 more not inspected (100 subtree(s))");
        expect(gap).not.toContain("x008");
    });
    it("P5: exactly eight omitted subtrees list all names with no 'and N more' tail", () => {
        const files: Record<string, string> = {};
        for (let i = 0; i < 8; i += 1) files[`a/b/c/d/x${i}/`] = "";
        const gap = discoverProjects(tree(files)).gaps.find(row => row.startsWith("depth bound"))!;
        expect(gap).toContain("x7 not inspected (8 subtree(s))");
        expect(gap).not.toContain("more");
    });
    it("P6: a tree of exactly 2000 directories is fully scanned and not capped; 2001 stops at 2000 with a gap", () => {
        const files: Record<string, string> = {};
        for (let i = 0; i < 1999; i += 1) files[`d${i}/`] = "";
        const exact = discoverProjects(tree(files));
        expect(exact.limits).toMatchObject({ directoriesScanned: 2000, capped: false });
        expect(exact.gaps.join("\n")).not.toContain("scan stopped");
        files["d1999/"] = "";
        const over = discoverProjects(tree(files));
        expect(over.limits).toMatchObject({ directoriesScanned: 2000, capped: true });
        expect(over.gaps.join("\n")).toContain("scan stopped after 2000 directories");
    });
    it("P7: a directory with only a __main__-guarded .py is a python project; an unguarded .py and a guarded test-directory runner are not", () => {
        const root = tree({ "tool/run.py": "if __name__ == '__main__':\n    pass\n", "lib/helper.py": "x = 1\n", "tests/runner.py": "if __name__ == \"__main__\":\n    pass\n" });
        const report = discoverProjects(root);
        expect(report.projects.map(row => [row.root, row.manifests])).toEqual([["tool", ["*.py"]]]);
        expect(report.projects[0]!.languages).toEqual(["python"]);
    });
    it("P8: a real manifest takes precedence over the python pseudo-manifest", () => {
        const found = only(tree({ "requirements.txt": "pytest\n", "main.py": "if __name__ == '__main__': pass\n" }));
        expect(found.manifests).toEqual(["requirements.txt"]);
    });
    it("P9: a directory that merely has a manifest's name is not a manifest", () => {
        expect(discoverProjects(tree({ "package.json/": "" })).projects).toEqual([]);
    });
    it("P10: omitted subtrees across several depth-bound directories are reported in sorted order", () => {
        const report = discoverProjects(tree({ "a/b/c/d/x/": "", "a/b/c/e/y/": "", "a/b/c/c/z/": "" }));
        expect(report.limits.omittedSubtrees).toEqual(["a/b/c/c/z", "a/b/c/d/x", "a/b/c/e/y"]);
    });
    it("N1: the empty-tree gap names the manifests, the root and the depth", () => {
        const root = tree({});
        expect(discoverProjects(root).gaps).toEqual([`no project manifest (package.json, pyproject.toml, setup.py, requirements.txt, Cargo.toml, go.mod) found under ${root} within 4 levels; declare the project explicitly in .interlinked/e2e-policy.json`]);
    });
});

describe("workspace ambiguity", () => {
    function ambiguous(workspaces: unknown, child: string): string[] {
        return discoverProjects(tree({ "package.json": pkg({ workspaces }), [`${child}/package.json`]: pkg({}, "kid") })).ambiguities;
    }
    it("P1: an exact workspace path, a 'dir/*' direct child, 'dir/**' descendants and the object form all declare the child", () => {
        expect(ambiguous(["pkgs/a"], "pkgs/a")).toEqual([]);
        expect(ambiguous(["pkgs/*"], "pkgs/a")).toEqual([]);
        expect(ambiguous(["pkgs/**"], "pkgs/a/b")).toEqual([]);
        expect(ambiguous({ packages: ["pkgs/*"] }, "pkgs/a")).toEqual([]);
    });
    it("N1: 'dir/*' does not declare a grandchild, and an unrelated glob declares nothing", () => {
        expect(ambiguous(["pkgs/*"], "pkgs/a/b")).toHaveLength(1);
        expect(ambiguous(["other/*"], "pkgs/a")).toHaveLength(1);
        expect(ambiguous(["pkgs/a"], "pkgs/ab")).toHaveLength(1);
        expect(ambiguous([42, null], "pkgs/a")).toHaveLength(1);
        expect(ambiguous({ packages: "pkgs/*" }, "pkgs/a")).toHaveLength(1);
    });
    it("N2: a non-package.json project nested under a package is never an ambiguity", () => {
        const root = tree({ "package.json": pkg(), "sub/requirements.txt": "x\n" });
        expect(discoverProjects(root).ambiguities).toEqual([]);
    });
    it("N3: a nested package names its own path and its parent in the ambiguity note", () => {
        const root = tree({ "a/package.json": pkg({}, "a"), "a/b/package.json": pkg({}, "b") });
        expect(discoverProjects(root).ambiguities).toEqual([expect.stringContaining("a/b/package.json is nested under a/package.json without a declared workspace; select the project")]);
    });
    it("N4: a sibling whose directory name merely starts with another project's name is not nested under it", () => {
        const root = tree({ "app/package.json": pkg({}, "app"), "app2/package.json": pkg({}, "app2") });
        expect(discoverProjects(root).ambiguities).toEqual([]);
    });
});

describe("languages, ids and basic project facts", () => {
    it("P1: tsconfig.json or a .ts file in src marks typescript; otherwise a package is javascript", () => {
        expect(only(tree({ "package.json": pkg(), "tsconfig.json": "{}" })).languages).toEqual(["typescript"]);
        expect(only(tree({ "package.json": pkg(), "src/a.ts": "" })).languages).toEqual(["typescript"]);
        expect(only(tree({ "package.json": pkg(), "src/a.js": "" })).languages).toEqual(["javascript"]);
        expect(only(tree({ "package.json": pkg() })).languages).toEqual(["javascript"]);
    });
    it("P2: Cargo.toml adds rust, go.mod adds go, a python manifest adds python, in that fixed order", () => {
        const found = only(tree({ "package.json": pkg(), "pyproject.toml": "", "Cargo.toml": "", "go.mod": "" }));
        expect(found.languages).toEqual(["javascript", "python", "rust", "go"]);
        expect(only(tree({ "setup.py": "" })).languages).toEqual(["python"]);
        expect(only(tree({ "go.mod": "" })).languages).toEqual(["go"]);
    });
    it("P3: the root project takes its manifest name with the scope stripped; a nested project takes its directory name", () => {
        expect(only(tree({ "package.json": pkg({}, "@scope/thing") })).id).toBe("thing");
        const ids = discoverProjects(tree({ "package.json": pkg({}, "root"), "pkgs/inner/package.json": pkg({}, "renamed") })).projects.map(row => row.id).sort();
        expect(ids).toEqual(["inner", "root"]);
    });
    it("P4: ids are sanitized to [A-Za-z0-9_.-], truncated to 100 characters and made unique with numeric suffixes", () => {
        expect(only(tree({ "package.json": pkg({}, "my app!") })).id).toBe("my-app-");
        expect(only(tree({ "package.json": pkg({}, "my.app_v-1") })).id).toBe("my.app_v-1");
        expect(only(tree({ "package.json": pkg({}, "x".repeat(150)) })).id).toBe("x".repeat(100));
        expect(only(tree({ "package.json": pkg({}, "") })).id).toBe("project");
        const ids = discoverProjects(tree({ "a/x/package.json": pkg(), "b/x/package.json": pkg(), "c/x/package.json": pkg() })).projects.map(row => row.id).sort();
        expect(ids).toEqual(["x", "x-2", "x-3"]);
    });
    it("P5: a root without a package name falls back to its directory name; a non-string name is ignored", () => {
        const root = tree({ "package.json": JSON.stringify({ name: 7 }) });
        expect(only(root).id).toBe(root.split("/").pop()!.replace(/[^a-zA-Z0-9_.-]/g, "-"));
    });
    it("P6: the project root is '.' at the top and a forward-slash relative path below it", () => {
        const report = discoverProjects(tree({ "package.json": pkg(), "p/q/package.json": pkg({}, "q") }));
        expect(report.projects.map(row => row.root).sort()).toEqual([".", "p/q"]);
    });
    it("N1: a package.json that is not an object (array, invalid JSON) yields a project without a name or build", () => {
        const found = only(tree({ "package.json": "[1,2]" }));
        expect(found.build).toBeNull();
        expect(found.executables).toEqual([]);
        expect(only(tree({ "package.json": "{oops" })).build).toBeNull();
    });
    it("N2: an oversized manifest (over 256 KiB) is treated as unreadable", () => {
        const big = JSON.stringify({ name: "big", scripts: { build: "node b.mjs" }, pad: "x".repeat(300 * 1024) });
        expect(only(tree({ "package.json": big })).build).toBeNull();
        const ok = JSON.stringify({ name: "ok", scripts: { build: "node b.mjs" }, pad: "x".repeat(200 * 1024) });
        expect(only(tree({ "package.json": ok })).build).not.toBeNull();
    });
    it("P7: shared inputs list the existing shared candidates in canonical order, then the build's script files", () => {
        const root = tree({ "package.json": pkg({ scripts: { build: "node build.mjs" } }), "build.mjs": "", "tsconfig.json": "{}", "package-lock.json": "{}", "Cargo.lock": "" });
        expect(only(root).proposal.sharedInputs).toEqual(["package.json", "package-lock.json", "tsconfig.json", "Cargo.lock", "build.mjs"]);
    });
});

describe("build proposal", () => {
    it("P1: a package build script yields 'npm run build', its script file as input and the source label", () => {
        const found = only(tree({ "package.json": pkg({ scripts: { build: "node build.mjs --fast" } }), "build.mjs": "" }));
        expect(found.build).toMatchObject({ prepare: [{ argv: ["npm", "run", "build"] }], inputs: ["build.mjs"], unresolved: [], source: "package.json scripts.build: node build.mjs --fast" });
    });
    it("P2: a non-string build script is ignored and Cargo.toml / go.mod give their fixed builds", () => {
        expect(only(tree({ "package.json": pkg({ scripts: { build: 3 } }) })).build).toBeNull();
        expect(only(tree({ "package.json": pkg({ scripts: "x" }) })).build).toBeNull();
        expect(only(tree({ "Cargo.toml": "" })).build).toEqual({ prepare: [{ argv: ["cargo", "build", "--release"] }], artifacts: ["target/**"], inputs: [], unresolved: [], conflicts: [], source: "Cargo.toml" });
        expect(only(tree({ "go.mod": "" })).build).toMatchObject({ prepare: [{ argv: ["go", "build", "./..."] }], artifacts: [], source: "go.mod" });
    });
    it("P3: a package build script wins over Cargo.toml in the same directory", () => {
        expect(only(tree({ "package.json": pkg({ scripts: { build: "node b.mjs" } }), "Cargo.toml": "" })).build?.source).toMatch(/^package\.json scripts\.build/);
    });
    it("P4: go.mod build infers output directories from contract paths that do not exist yet", () => {
        const root = tree({ "go.mod": "", [MANIFEST]: manifest([proc("c", ["./bin/tool"], [])]) });
        expect(only(root).build?.artifacts).toEqual(["bin/**"]);
    });
    it("P5: script words are split with quotes, escapes and operators; flags, variables and unknown files are classified", () => {
        const build = "node 'my dir/a.mjs' \"b c.mjs\" d\\ e.mjs && node f.mjs;node -x.mjs $G.mjs missing.mjs plain";
        const found = only(tree({ "package.json": pkg({ scripts: { build } }), "my dir/a.mjs": "", "b c.mjs": "", "d e.mjs": "", "f.mjs": "" }));
        expect(found.build?.inputs).toEqual(["my dir/a.mjs", "b c.mjs", "d e.mjs", "f.mjs"]);
        expect(found.build?.unresolved).toEqual(["$G.mjs", "missing.mjs"]);
    });
    it("P6: a word with a slash but no extension that is not a file is unresolved; a directory is not a script file", () => {
        const found = only(tree({ "package.json": pkg({ scripts: { build: "node tools/run ./sub.d" } }), "sub.d/": "" }));
        expect(found.build?.unresolved).toEqual(["tools/run", "./sub.d"]);
        expect(found.build?.inputs).toEqual([]);
    });
    it("P7: an escaped character inside double quotes keeps the escaped character and a backtick word is unresolved", () => {
        const found = only(tree({ "package.json": pkg({ scripts: { build: "node \"q\\\"z.mjs\" `gen.sh`" } }) }));
        expect(found.build?.unresolved).toEqual(["q\"z.mjs", "`gen.sh`"]);
    });
    it("P8: single quotes keep a backslash literal and a double-quoted word keeps a single quote", () => {
        const found = only(tree({ "package.json": pkg({ scripts: { build: "node 'a\\b.mjs' \"c'd.mjs\"" } }) }));
        expect(found.build?.unresolved).toEqual(["a\\b.mjs", "c'd.mjs"]);
    });
    it("P9: parentheses and pipes separate words like whitespace", () => {
        const found = only(tree({ "package.json": pkg({ scripts: { build: "(node a.mjs)|node b.mjs" } }), "a.mjs": "", "b.mjs": "" }));
        expect(found.build?.inputs).toEqual(["a.mjs", "b.mjs"]);
    });
    it("P10: an empty quoted word is kept as an empty word (not a file) and does not merge neighbours", () => {
        const found = only(tree({ "package.json": pkg({ scripts: { build: "node '' a.mjs" } }), "a.mjs": "" }));
        expect(found.build?.inputs).toEqual(["a.mjs"]);
        expect(found.build?.unresolved).toEqual([]);
    });
    it("P11: a trailing backslash at the end of the command is a literal character", () => {
        const found = only(tree({ "package.json": pkg({ scripts: { build: "node dir/x\\" } }) }));
        expect(found.build?.unresolved).toEqual(["dir/x\\"]);
    });
});

describe("artifact inference and conflicts", () => {
    function build(script: string, files: Record<string, string>, contract?: Array<Record<string, unknown>>): NonNullable<DiscoveredProject["build"]> {
        const all: Record<string, string> = { "package.json": pkg({ scripts: { build: "node b.mjs" } }), "b.mjs": script, ...files };
        if (contract) all[MANIFEST] = manifest(contract);
        return only(tree(all)).build!;
    }
    it("P1: each written output directory is an artifact glob, sorted; a directory only read is not", () => {
        const found = build("fs.mkdirSync('out'); fs.rmSync('build'); fs.readdirSync('lib'); fs.readFileSync('dist/x')", {});
        expect(found.artifacts).toEqual(["build/**", "out/**"]);
    });
    it("P2: output options in the build command itself count as write evidence", () => {
        const root = tree({ "package.json": pkg({ scripts: { build: "tsc --outDir dist && bundler --out=bin" } }) });
        expect(only(root).build?.artifacts).toEqual(["bin/**", "dist/**"]);
    });
    it("P3: every write API names a directory and a longer directory name sharing the prefix does not match", () => {
        for (const api of ["mkdir", "mkdirSync", "writeFile", "writeFileSync", "createWriteStream", "rm", "rmSync", "emptyDir", "emptyDirSync"]) {
            expect(build(`${api}("dist/x")`, {}).artifacts, api).toEqual(["dist/**"]);
        }
        expect(build("mkdir('distant')", {}).artifacts).toEqual([]);
        expect(build("mkdir('dist')", {}).artifacts).toEqual(["dist/**"]);
        expect(build("mkdir(`out`)", {}).artifacts).toEqual(["out/**"]);
        expect(build("mkdir(\"out\"  ", {}).artifacts).toEqual(["out/**"]);
    });
    it("P4: option-style evidence names (outdir, outfile, out-dir, outFile) are recognized", () => {
        for (const text of ["outdir 'lib'", "outfile = 'lib/x.js'", "out-dir lib", "outFile \"lib/x\"", "-o lib"]) expect(build(text, {}).artifacts, text).toEqual(["lib/**"]);
    });
    it("P5: a contract path under an absent output directory adds that directory even when it is not in the usual list", () => {
        const found = build("", {}, [proc("c", ["node", "gen/tool.js"])]);
        expect(found.artifacts).toEqual(["gen/**"]);
    });
    it("N1: contract paths that exist, have no slash, or sit under an existing non-output directory add nothing", () => {
        const present = build("", { "gen/keep.txt": "" }, [proc("c", ["node", "gen/tool.js"])]);
        expect(present.artifacts).toEqual([]);
        const existingFile = build("", { "dist/tool.js": "" }, [proc("c", ["node", "dist/tool.js"])]);
        expect(existingFile.artifacts).toEqual([]);
        expect(build("", {}, [proc("c", ["node", "tool.js"], ["data"])]).artifacts).toEqual([]);
    });
    it("P6: an output directory is inferred for an absent path under dist even when dist itself exists", () => {
        const found = build("", { "dist/other.txt": "" }, [proc("c", ["node", "dist/new.js"])]);
        expect(found.artifacts).toEqual(["dist/**"]);
        expect(found.conflicts).toEqual([]);
    });
    it("P7: a glob covering an existing declared input with no write evidence is a conflict, dropped from artifacts and named in a gap", () => {
        const root = tree({ "package.json": pkg({ scripts: { build: "node b.mjs" } }), "b.mjs": "mkdir('dist')", "dist/cli.js": "x", [MANIFEST]: manifest([proc("c", ["node", "dist/cli.js"], ["dist/cli.js"])]) });
        const found = only(root);
        expect(found.build?.artifacts).toEqual([]);
        expect(found.build?.conflicts).toEqual([{ glob: "dist/**", inputs: ["dist/cli.js"] }]);
        expect(found.gaps).toContain("dist/cli.js exist(s) and is a declared input, yet dist/** looked like build output; the glob is NOT proposed and the input is kept in freshness tracking — if it really is generated, declare dist/** in suites[].artifacts yourself");
    });
    it("P8: write evidence for the exact path keeps the artifact: first-argument writers, second-argument copy destinations and output options", () => {
        const cases: Array<[string, boolean]> = [
            ["writeFileSync('dist/cli.js', data); mkdir('dist')", true],
            ["writeFile(\"./dist/cli.js\", data); mkdir('dist')", true],
            ["createWriteStream(`dist/cli.js`); mkdir('dist')", true],
            ["appendFile('dist/cli.js', d); mkdir('dist')", true],
            ["copyFileSync('src/a.js', 'dist/cli.js'); mkdir('dist')", true],
            ["cpSync(\"src/a.js\",\"dist/cli.js\"); mkdir('dist')", true],
            ["rename('tmp/a', 'dist/cli.js'); mkdir('dist')", true],
            ["esbuild({ outfile: 'dist/cli.js' }); mkdir('dist')", true],
            ["tool --out dist/cli.js ; mkdir('dist')", true],
            ["tool -o dist/cli.js ; mkdir('dist')", true],
            ["tool --outfile=./dist/cli.js\nmkdir('dist')", true],
            ["copyFile('dist/cli.js', 'elsewhere/x'); mkdir('dist')", false],
            ["writeFile('dist/cli.js.bak', d); mkdir('dist')", false],
            ["writeFile('dist/cli.js' + '.bak', d); mkdir('dist')", false],
            ["writeFile(path.join('dist/cli.js'), d); mkdir('dist')", false],
            ["// writeFile('dist/cli.js', d)\nmkdir('dist')", false],
            ["/* writeFile('dist/cli.js', d) */ mkdir('dist')", false],
            ["# writeFile('dist/cli.js', d)\nmkdir('dist')", false],
            ["writeFile('dist/cli.jsx', d); mkdir('dist')", false],
            ["writeFile('distXcli.js', d); mkdir('dist')", false],
        ];
        for (const [script, keeps] of cases) {
            const found = build(script, { "dist/cli.js": "x" }, [proc("c", ["node", "dist/cli.js"], ["dist/cli.js"])]);
            expect(found.artifacts, script).toEqual(keeps ? ["dist/**"] : []);
            expect(found.conflicts.length, script).toBe(keeps ? 0 : 1);
        }
    });
    it("P9: a URL-like string with // is not treated as a line comment when it precedes write evidence", () => {
        const found = build("const u = 'http://x'; writeFile('dist/cli.js', d); mkdir('dist')", { "dist/cli.js": "x" }, [proc("c", ["node", "dist/cli.js"], ["dist/cli.js"])]);
        expect(found.artifacts).toEqual(["dist/**"]);
    });
    it("P10: a glob is a conflict only for contract paths that exist on disk and match the glob", () => {
        const found = build("mkdir('dist')", { "other/f.txt": "" }, [proc("c", ["node", "x"], ["other/f.txt", "dist/absent.txt"])]);
        expect(found.conflicts).toEqual([]);
        expect(found.artifacts).toEqual(["dist/**"]);
    });
    it("P11: several covered inputs are all listed in the conflict", () => {
        const found = build("mkdir('dist')", { "dist/a": "", "dist/b": "" }, [proc("c", ["node", "x"], ["dist/a", "dist/b"])]);
        expect(found.conflicts).toEqual([{ glob: "dist/**", inputs: ["dist/a", "dist/b"] }]);
    });
    it("P12: with no inferable output the missing-artifact gap names the project and the build source", () => {
        const root = tree({ "package.json": pkg({ scripts: { build: "node b.mjs" } }), "b.mjs": "" });
        expect(only(root).gaps).toContain('build outputs for app could not be inferred from "package.json scripts.build: node b.mjs"; declare suites[].artifacts (the globs prepare produces) before adopting required mode');
    });
});

describe("exported evidence helpers", () => {
    it("P1: prepareEvidenceText resolves npm/pnpm/bun 'run <name>' and yarn '<name>' one level into package.json and appends script files", () => {
        const dir = tree({ "package.json": pkg({ scripts: { build: "node tools/mk.mjs --flag", other: "echo hi" } }), "tools/mk.mjs": "SCRIPT-BODY" });
        for (const argv of [["npm", "run", "build"], ["pnpm", "run", "build"], ["bun", "run", "build"], ["yarn", "build"]]) {
            expect(prepareEvidenceText(dir, [{ argv }]), argv.join(" ")).toBe("node tools/mk.mjs --flag\nSCRIPT-BODY");
        }
    });
    it("P2: a direct command or an alias that is not a string script contributes its own words only", () => {
        const dir = tree({ "package.json": pkg({ scripts: { build: 5 } }), "run.mjs": "BODY" });
        expect(prepareEvidenceText(dir, [{ argv: ["node", "run.mjs"] }])).toBe("node run.mjs\nBODY");
        expect(prepareEvidenceText(dir, [{ argv: ["npm", "run", "build"] }])).toBe("npm run build");
        expect(prepareEvidenceText(dir, [{ argv: ["npm", "run", "absent"] }])).toBe("npm run absent");
        expect(prepareEvidenceText(dir, [{ argv: ["npm", "test"] }])).toBe("npm test");
        expect(prepareEvidenceText(dir, [{ argv: ["cargo", "run", "build"] }])).toBe("cargo run build");
        expect(prepareEvidenceText(dir, [])).toBe("");
    });
    it("P3: several steps are joined by newlines in order", () => {
        const dir = tree({ "a.mjs": "A", "b.mjs": "B" });
        expect(prepareEvidenceText(dir, [{ argv: ["node", "a.mjs"] }, { argv: ["node", "b.mjs"] }])).toBe("node a.mjs\nA\nnode b.mjs\nB");
    });
    it("P4: artifactConflictsOf reports globs that cover an existing contract path unless the prepare steps write it", () => {
        const dir = tree({ "dist/cli.js": "x", "w.mjs": "writeFile('dist/cli.js', d)", "n.mjs": "noop" });
        expect(artifactConflictsOf(dir, ["dist/**"], ["dist/cli.js"], [{ argv: ["node", "n.mjs"] }])).toEqual([{ glob: "dist/**", inputs: ["dist/cli.js"] }]);
        expect(artifactConflictsOf(dir, ["dist/**"], ["dist/cli.js"], [{ argv: ["node", "w.mjs"] }])).toEqual([]);
        expect(artifactConflictsOf(dir, ["lib/**"], ["dist/cli.js"], [])).toEqual([]);
    });
    it("P5: pythonEntryPoints parses name, module and optional callable only inside [project.scripts]", () => {
        const dir = tree({ "pyproject.toml": "[project]\nname = \"x\"\n[project.scripts]\ntool = \"pkg.mod:main\"\nbare-mod = \"pkg.other\"\n  spaced_1 = \"a.b:c.d\"\n[tool.x]\nnot = \"pkg.skip:run\"\n" });
        expect(pythonEntryPoints(dir)).toEqual([
            { name: "tool", module: "pkg.mod", callable: "main" },
            { name: "bare-mod", module: "pkg.other", callable: null },
            { name: "spaced_1", module: "a.b", callable: "c.d" },
        ]);
        expect(pythonEntryPoints(tree({ "pyproject.toml": "[project]\nname = \"x\"\n" }))).toEqual([]);
        expect(pythonEntryPoints(tree({}))).toEqual([]);
    });
    it("P6: contractPaths returns inputs plus path-shaped process tokens, strips './', sorts, dedupes and skips non-process runners", () => {
        const cases = [
            { ...proc("a", ["node", "./dist/cli.js", "plain", "-x/y", "with space/z", "a/b c"], ["z/in", "dist/cli.js"]) },
            { ...proc("b", ["tool", "no-slash", "/abs/path", "trailing/"], []) },
            { id: "h", description: "h", source: SOURCE, inputs: ["http/input"], runner: { kind: "http", service: "s", path: "/x/y", method: "GET" }, expect: { status: 200 } },
        ] as unknown as ContractCase[];
        expect(contractPaths(cases)).toEqual(["-x/y", "/abs/path", "dist/cli.js", "http/input", "z/in"]);
    });
});

describe("tests, executables and protected scope", () => {
    it("P1: known JS runners are read from dependencies and devDependencies; unknown packages are ignored", () => {
        const found = only(tree({ "package.json": pkg({ dependencies: { jest: "1", left: "1" }, devDependencies: { vitest: "1", tap: "1" } }) }));
        expect(found.tests.runners).toEqual(["vitest", "jest", "tap"]);
    });
    it("P2: pytest in python metadata wins; otherwise unittest needs a python manifest and a .py file in a test layout", () => {
        expect(only(tree({ "requirements.txt": "pytest>=7\n", "tests/test_a.py": "" })).tests.runners).toEqual(["pytest"]);
        expect(only(tree({ "pyproject.toml": "[tool.pytest]\n" })).tests.runners).toEqual(["pytest"]);
        expect(only(tree({ "setup.py": "# uses pytest\n" })).tests.runners).toEqual(["pytest"]);
        expect(only(tree({ "requirements.txt": "x\n", "tests/test_a.py": "" })).tests.runners).toEqual(["unittest"]);
        expect(only(tree({ "requirements.txt": "x\n", "tests/test_a.txt": "" })).tests.runners).toEqual([]);
        expect(only(tree({ "requirements.txt": "mypytestx\n" })).tests.runners).toEqual([]);
        expect(only(tree({ "package.json": pkg(), "tests/test_a.py": "" })).tests.runners).toEqual([]);
    });
    it("P3: cargo-test and go-test come from their manifests; layouts only count directories", () => {
        expect(only(tree({ "Cargo.toml": "", "tests/": "" })).tests).toEqual({ layouts: ["tests"], runners: ["cargo-test"] });
        expect(only(tree({ "go.mod": "", "test": "not a dir", "spec/": "", "e2e/": "", "__tests__/": "" })).tests).toEqual({ layouts: ["__tests__", "spec", "e2e"], runners: ["go-test"] });
        expect(only(tree({ "go.mod": "", "test/": "" })).tests.layouts).toEqual(["test"]);
    });
    it("P4: a string bin uses the unscoped package name; an object bin keeps only string targets; a bin-less package has none", () => {
        expect(only(tree({ "package.json": pkg({ bin: "cli.js" }, "@s/tool") })).executables).toEqual([{ id: "tool", kind: "package-bin", argv: ["node", "cli.js"], source: "package.json bin" }]);
        expect(only(tree({ "package.json": pkg({ bin: { a: "a.js", b: 3, c: "c.js" } }) })).executables.map(row => [row.id, row.argv])).toEqual([["a", ["node", "a.js"]], ["c", ["node", "c.js"]]]);
        expect(only(tree({ "package.json": pkg({ bin: null }) })).executables).toEqual([]);
        expect(only(tree({ "package.json": pkg({ bin: 5 }) })).executables).toEqual([]);
    });
    it("P5: a string bin without a package name falls back to the directory name", () => {
        const root = tree({ "package.json": JSON.stringify({ bin: "cli.js" }) });
        expect(only(root).executables[0]!.id).toBe(root.split("/").pop());
    });
    it("P6: a cargo bin needs src/main.rs and uses only the first name found", () => {
        const toml = "[package]\nname = \"first\"\n[[bin]]\nname = \"second\"\n";
        expect(only(tree({ "Cargo.toml": toml, "src/main.rs": "" })).executables).toEqual([{ id: "first", kind: "cargo-bin", argv: ["./target/release/first"], source: "Cargo.toml [package].name + src/main.rs" }]);
        expect(only(tree({ "Cargo.toml": toml })).executables).toEqual([]);
        expect(only(tree({ "Cargo.toml": "[package]\n", "src/main.rs": "" })).executables).toEqual([]);
    });
    it("P7: python console entries run their callable with console-script exit semantics, or -m for a bare module; a missing module is a gap", () => {
        const root = tree({ "pyproject.toml": "[project.scripts]\ntool = \"pkg.mod:main\"\nbare = \"pkg2\"\nghost = \"nowhere:run\"\n", "pkg/mod.py": "", "pkg2/__init__.py": "" });
        const found = only(root);
        expect(found.executables.map(row => [row.id, row.kind, row.argv])).toEqual([
            ["tool", "python-entry", ["python3", "-c", "import sys, pkg.mod as _entry; sys.exit(_entry.main())"]],
            ["bare", "python-entry", ["python3", "-m", "pkg2"]],
        ]);
        expect(found.executables[0]!.source).toBe("pyproject.toml [project.scripts] tool = pkg.mod:main (callable invoked with console-script exit semantics; the installed console script needs pip install)");
        expect(found.gaps).toContain("console script ghost = nowhere:run names a module with no file in this project; declare its argv explicitly (an installed environment is required to run it)");
    });
    it("P8: python scripts with a __main__ guard are executables in sorted order; unguarded or non-.py files are not", () => {
        const guarded = "if __name__ == '__main__':\n    pass\n";
        const found = only(tree({ "requirements.txt": "x\n", "b.py": guarded, "a.py": guarded, "c.py": "x = 1\n", "d.txt": guarded }));
        expect(found.executables.map(row => [row.id, row.kind, row.argv, row.source])).toEqual([
            ["a.py", "python-script", ["python3", "a.py"], "a.py __main__ guard"],
            ["b.py", "python-script", ["python3", "b.py"], "b.py __main__ guard"],
        ]);
    });
    it("P9: python executables are only collected for python projects", () => {
        const guarded = "if __name__ == '__main__':\n    pass\n";
        expect(only(tree({ "package.json": pkg(), "run.py": guarded })).executables).toEqual([]);
    });
    it("P10: protected scope covers src/**, python package directories, top-level source files and executable files, sorted and deduplicated", () => {
        const root = tree({
            "package.json": pkg({ bin: "cli.js", scripts: { build: "node build.mjs" } }),
            "build.mjs": "", "cli.js": "", "src/a.ts": "", "mypkg/__init__.py": "", "tests/__init__.py": "", "node_modules/__init__.py": "",
            "top.ts": "", "vite.config.ts": "", "types.d.ts": "", "README.md": "", "go.rs": "", "dirfile.ts/": "", "plain/x.py": "",
        });
        expect(only(root).proposal.protectedInputs).toEqual(["cli.js", "go.rs", "mypkg/**", "src/**", "top.ts"]);
    });
    it("P11: a src file (not directory) adds no src glob; build inputs are excluded from top-level sources and executable sources", () => {
        const root = tree({ "package.json": pkg({ bin: "build.mjs", scripts: { build: "node build.mjs" } }), "src": "x", "build.mjs": "", "lone.js": "" });
        expect(only(root).proposal.protectedInputs).toEqual(["lone.js"]);
    });
    it("P12: an executable under a build artifact directory is not a protected source", () => {
        const root = tree({ "package.json": pkg({ bin: "dist/cli.js", scripts: { build: "node b.mjs" } }), "b.mjs": "mkdir('dist')", "dist/cli.js": "x" });
        expect(only(root).proposal.protectedInputs).toEqual([]);
    });
    it("P13: a python-entry executable protects the module file it imports, whether run by -m or by import", () => {
        const root = tree({ "pyproject.toml": "[project.scripts]\ntool = \"mod:main\"\nbare = \"mod2\"\n", "mod.py": "", "mod2/__init__.py": "" });
        expect(only(root).proposal.protectedInputs).toEqual(["mod.py", "mod2/**", "mod2/__init__.py"]);
    });
    it("P14: a python entry whose module has no file contributes no executable and no source file", () => {
        const root = tree({ "pyproject.toml": "[project.scripts]\ntool = \"mod:main\"\nother = \"zzz:run\"\n", "mod.py": "" });
        expect(only(root).executables.map(row => row.id)).toEqual(["tool"]);
        expect(only(root).proposal.protectedInputs).toEqual(["mod.py"]);
    });
    it("P15: a non-source top-level file and a non-existent executable path add nothing, and the missing scope gap is reported", () => {
        const found = only(tree({ "package.json": pkg({ bin: "ghost.js" }), "notes.txt": "" }));
        expect(found.proposal.protectedInputs).toEqual([]);
        expect(found.gaps).toContain("no source scope could be inferred for app (no src/, package directory, executable file or top-level source file); declare protectedInputs explicitly before adopting");
    });
    it("P16: each source suffix is a top-level source file", () => {
        const names = ["a.cjs", "a.go", "a.js", "a.mjs", "a.mts", "a.py", "a.rs", "a.ts", "a.tsx"];
        const root = tree({ "package.json": pkg(), ...Object.fromEntries(names.map(name => [name, ""])), "a.json": "", "a.config.js": "" });
        expect(only(root).proposal.protectedInputs).toEqual(names);
    });
});

describe("contracts, scenarios, gaps and policy validity", () => {
    it("P1: each process case becomes an advisory, non-required scenario with the project scope as affects and the process boundary", () => {
        const root = tree({ "package.json": pkg(), "src/a.ts": "", "tests/": "", [MANIFEST]: manifest([proc("one", ["node", "x"]), proc("two", ["node", "y"])]) });
        const found = only(root);
        expect(found.contracts).toEqual({ manifest: MANIFEST, cases: ["one", "two"], paths: [] });
        expect(found.proposal.scenarios).toEqual([
            { id: "one", suite: "cli", description: "one description", affects: ["src/**"], contractIds: ["one"], required: false, boundary: { entry: "process", real: ["application"] } },
            { id: "two", suite: "cli", description: "two description", affects: ["src/**"], contractIds: ["two"], required: false, boundary: { entry: "process", real: ["application"] } },
        ]);
        expect(found.proposal.scenarios[0]!.affects).not.toBe(found.proposal.protectedInputs);
        expect(found.proposal).toMatchObject({ mode: "advisory", gates: { stop: "warn" }, suites: [{ id: "cli", adapter: "managed-contracts" }] });
        expect(found.proposal.suites[0]).not.toHaveProperty("prepare");
    });
    it("P2: an http-runner case gets no scenario and a gap naming the runner kind", () => {
        const http = { id: "web", description: "w", source: SOURCE, inputs: [], runner: { kind: "http", service: "app", path: "/x", method: "GET" }, expect: { status: 200 } };
        const found = only(tree({ "package.json": pkg(), "src/a.ts": "", [MANIFEST]: manifest([http, proc("ok", ["node", "x"])]) }));
        expect(found.proposal.scenarios.map(row => row.id)).toEqual(["ok"]);
        expect(found.gaps).toContain("contract case web uses an http runner; unsupported until a managed service adapter ships, so no scenario is proposed for it");
    });
    it("P3: a build adds prepare and artifacts to the suite", () => {
        const found = only(tree({ "package.json": pkg({ scripts: { build: "node b.mjs" } }), "b.mjs": "mkdir('dist')" }));
        expect(found.proposal.suites[0]).toEqual({ id: "cli", adapter: "managed-contracts", prepare: [{ argv: ["npm", "run", "build"] }], artifacts: ["dist/**"] });
    });
    it("N1: an invalid manifest produces no scenarios, no cases, no paths and a gap carrying the parse error", () => {
        const found = only(tree({ "package.json": pkg(), "src/a.ts": "", [MANIFEST]: "not json" }));
        expect(found.contracts.manifest).toBe(MANIFEST);
        expect(found.contracts.cases).toEqual([]);
        expect(found.contracts.paths).toEqual([]);
        expect(found.contracts.invalid).toEqual(expect.any(String));
        expect(found.proposal.scenarios).toEqual([]);
        expect(found.gaps).toContain(`existing ${MANIFEST} is invalid: ${found.contracts.invalid}`);
    });
    it("N2: a project without a manifest reports manifest null and the 'none found' executables gap", () => {
        const found = only(tree({ "package.json": pkg(), "src/a.ts": "" }));
        expect(found.contracts).toEqual({ manifest: null, cases: [], paths: [] });
        expect(found.gaps).toContain(`no contract cases declared for app; executables found: none found. Write cases with \`interlinked tests contracts import <doc>\` or author ${MANIFEST}, then re-run discover`);
    });
    it("N3: a manifest with cases does not produce the no-cases gap", () => {
        const found = only(tree({ "package.json": pkg(), "src/a.ts": "", "tests/": "", [MANIFEST]: manifest([proc("one", ["node", "x"])]) }));
        expect(found.gaps).toEqual([]);
    });
    it("P4: absent contract and executable paths with no covering artifact are one deduplicated gap; covered ones are not", () => {
        const root = tree({ "package.json": pkg({ bin: "./bin/tool.js" }), "src/a.ts": "", "tests/": "", "here/f": "", [MANIFEST]: manifest([proc("c", ["node", "./miss/a.js", "miss/a.js", "here/f"], ["miss/a.js"])]) });
        const gap = only(root).gaps.find(row => row.startsWith("these contract/executable paths"))!;
        expect(gap).toBe("these contract/executable paths are absent and no build artifact covers them: miss/a.js, bin/tool.js; declare suites[].artifacts or fix the paths");
        const covered = tree({ "package.json": pkg({ scripts: { build: "node b.mjs" } }), "b.mjs": "mkdir('bin')", "src/a.ts": "", "tests/": "", [MANIFEST]: manifest([proc("c", ["node", "bin/x.js"], [])]) });
        expect(only(covered).gaps.join("\n")).not.toContain("absent");
    });
    it("P5: executable argv tokens that contain a slash and do not exist are absent paths; tokens without slash are ignored", () => {
        const root = tree({ "package.json": pkg({ bin: { a: "sub/a.js", b: "b.js" } }), "src/a.ts": "", "tests/": "" });
        const gap = only(root).gaps.find(row => row.startsWith("these contract/executable paths"))!;
        expect(gap).toContain("absent and no build artifact covers them: sub/a.js;");
    });
    it("P6: build input words that resolve to no file produce the unresolved-input gap with the source", () => {
        const found = only(tree({ "package.json": pkg({ scripts: { build: "node gone.mjs $X" } }), "src/a.ts": "", "tests/": "" }));
        expect(found.gaps).toContain('build input(s) gone.mjs, $X in "package.json scripts.build: node gone.mjs $X" resolve to no file in the project; editing the real script would not invalidate receipts — declare it in sharedInputs');
    });
    it("P7: runners with no native integration are named once each; native runners are not", () => {
        const found = only(tree({ "package.json": pkg({ devDependencies: { vitest: "1", jest: "1", mocha: "1" } }), "src/a.ts": "", "tests/": "", [MANIFEST]: manifest([proc("c", ["node", "x"])]) }));
        const runnerGaps = found.gaps.filter(row => row.startsWith("test runner"));
        expect(runnerGaps).toHaveLength(2);
        expect(runnerGaps[0]).toContain('"jest"');
        expect(runnerGaps[1]).toContain('"mocha"');
    });
    it("P8: the missing-layout gap uses the project's first language for the readiness command", () => {
        const py = only(tree({ "requirements.txt": "x\n", [MANIFEST]: manifest([proc("c", ["python3", "x"])]) }));
        expect(py.gaps).toContain(`No test layout was detected for ${py.id}; run \`interlinked tests readiness python --json\``);
        const js = only(tree({ "package.json": pkg(), "src/a.js": "", [MANIFEST]: manifest([proc("c", ["node", "x"])]) }));
        expect(js.gaps).toContain(`No test layout was detected for ${js.id}; run \`interlinked tests readiness javascript --json\``);
    });
    it("P9: gaps from console entries precede the project's other gaps", () => {
        const found = only(tree({ "pyproject.toml": "[project.scripts]\nghost = \"nowhere:run\"\n" }));
        expect(found.gaps[0]).toMatch(/^console script ghost/);
    });
    it("P10: a bare console entry without a callable is labelled without a colon", () => {
        const found = only(tree({ "pyproject.toml": "[project.scripts]\nghost = \"nowhere\"\n" }));
        expect(found.gaps[0]).toMatch(/^console script ghost = nowhere names a module/);
    });
    it("P11: the proposal policy is version 1 with every project's proposal and no expectations; an empty scan has no projects", () => {
        const report = discoverProjects(tree({ "package.json": pkg(), "src/a.ts": "" }));
        expect(report.proposal).toEqual({ version: 1, projects: [report.projects[0]!.proposal], expectations: [] });
        expect(report.version).toBe(1);
        expect(discoverProjects(tree({})).proposal).toEqual({ version: 1, projects: [], expectations: [] });
        expect(report.gaps.filter(row => row.startsWith("proposal does not validate"))).toEqual([]);
    });
    it("P12: the report records the scanned root, an ISO timestamp and the scan limits", () => {
        const root = tree({ "package.json": pkg() });
        const report = discoverProjects(root);
        expect(report.root).toBe(root);
        expect(new Date(report.scannedAt).toISOString()).toBe(report.scannedAt);
        expect(Math.abs(Date.now() - Date.parse(report.scannedAt))).toBeLessThan(60_000);
        expect(report.limits).toEqual({ directoriesScanned: 1, capped: false, omittedSubtrees: [] });
    });
    it("P13: candidates are processed in sorted directory order so ids are assigned deterministically", () => {
        const report = discoverProjects(tree({ "b/x/package.json": pkg(), "a/x/package.json": pkg() }));
        expect(report.projects.map(row => [row.root, row.id])).toEqual([["a/x", "x"], ["b/x", "x-2"]]);
    });
});

describe("formatDiscovery", () => {
    it("P1: a project renders its header, build, tests, executables, contracts and gap lines in order", () => {
        const root = tree({
            "package.json": pkg({ bin: "cli.js", scripts: { build: "node b.mjs" }, devDependencies: { vitest: "1" } }, "fmt"),
            "b.mjs": "mkdir('dist')", "cli.js": "", "tests/": "", [MANIFEST]: manifest([proc("one", ["node", "cli.js"]), proc("two", ["node", "cli.js"])]),
        });
        const lines = formatDiscovery(discoverProjects(root));
        expect(lines.slice(0, 5)).toEqual([
            "fmt (.): javascript; manifests package.json",
            "  build: npm run build → artifacts dist/** (package.json scripts.build: node b.mjs)",
            "  tests: layouts tests; runners vitest",
            "  executables: fmt = node cli.js",
            "  contracts: 2 case(s); proposed scenarios one, two (advisory)",
        ]);
        expect(lines.at(-1)).toBe("scanned 2 directories; nothing was executed or written. Adopt with: interlinked tests e2e adopt --from <report.json> [--project <id>] [--scenario <id>] [--mode required]");
    });
    it("P2: absent facts render their fallbacks; a build with no artifacts says none and an interpreted project says so", () => {
        const lines = formatDiscovery(discoverProjects(tree({ "package.json": pkg({ scripts: { build: "node b.mjs" } }, "fb"), "b.mjs": "" })));
        expect(lines[0]).toBe("fb (.): javascript; manifests package.json");
        expect(lines[1]).toBe("  build: npm run build → artifacts none (package.json scripts.build: node b.mjs)");
        expect(lines[2]).toBe("  tests: layouts none; runners none");
        expect(lines[3]).toBe("  executables: none");
        expect(lines[4]).toBe("  contracts: no manifest; proposed scenarios none (advisory)");
        const plain = formatDiscovery(discoverProjects(tree({ "setup.py": "" })));
        expect(plain[1]).toBe("  build: none (interpreted or undeclared)");
    });
    it("P3: gap lines of a project are indented and top-level gaps and ambiguities are prefixed, after the project lines", () => {
        const root = tree({ "package.json": pkg(), "inner/package.json": pkg({}, "in"), "a/b/c/d/e/": "" });
        const lines = formatDiscovery(discoverProjects(root));
        const ambiguity = lines.findIndex(row => row.startsWith("ambiguity: inner/package.json is nested under"));
        const gap = lines.findIndex(row => row.startsWith("gap: depth bound"));
        const lastProject = lines.map((row, index) => (row.startsWith("  gap: ") ? index : -1)).reduce((a, b) => Math.max(a, b), -1);
        expect(lastProject).toBeGreaterThan(-1);
        expect(ambiguity).toBeGreaterThan(lastProject);
        expect(gap).toBeGreaterThan(ambiguity);
    });
    it("P4: the summary uses 'directory' for one, 'directories' for more, and notes omitted subtrees", () => {
        const one = formatDiscovery(discoverProjects(tree({})));
        expect(one.at(-1)).toMatch(/^scanned 1 directory; nothing was executed/);
        const many = formatDiscovery(discoverProjects(tree({ "a/b/": "" })));
        expect(many.at(-1)).toMatch(/^scanned 3 directories; nothing was executed/);
        const omitted = formatDiscovery(discoverProjects(tree({ "a/b/c/d/e/": "", "a/b/c/d/f/": "" })));
        expect(omitted.at(-1)).toMatch(/^scanned 5 directories; 2 subtree\(s\) omitted at the depth bound; nothing was executed/);
    });
    it("P5: a capped scan is marked '(capped)' in the summary", () => {
        const files: Record<string, string> = {};
        for (let i = 0; i < 2000; i += 1) files[`d${i}/`] = "";
        expect(formatDiscovery(discoverProjects(tree(files))).at(-1)).toMatch(/^scanned 2000 directories \(capped\); nothing was executed/);
    });
});

describe("boundary behaviors pinned after survivor review", () => {
    it("P1: a `dir/**` workspace glob declares only children under `dir/`, not a sibling that merely shares the prefix", () => {
        const root = tree({ "package.json": JSON.stringify({ name: "mono", workspaces: ["packages/**"] }), "packages/a/package.json": pkg({}, "a"), "packages-legacy/app/package.json": pkg({}, "legacy") });
        const notes = discoverProjects(root).ambiguities;
        expect(notes).toHaveLength(1);
        expect(notes[0]).toContain("packages-legacy/app/package.json is nested under package.json without a declared workspace");
    });
    it("P2: a package bin written by the build into an existing output directory is not protected source, even when declared with a `./` prefix", () => {
        const root = tree({ "package.json": pkg({ scripts: { build: "mkdir bin && tsc" }, bin: { cli: "./bin/cli.js" } }), "bin/cli.js": "#!/usr/bin/env node\n" });
        const found = only(root);
        expect(found.build?.artifacts).toEqual(["bin/**"]);
        expect(found.proposal.protectedInputs).toEqual([]);
    });
    it("P3: a path named by both the contract cases and an executable is listed once in the absent-path gap", () => {
        const root = tree({ "package.json": pkg({ bin: { cli: "bin/cli.js" } }), [MANIFEST]: manifest([proc("c1", ["node", "bin/cli.js"])]) });
        const gap = only(root).gaps.find(row => row.startsWith("these contract/executable paths are absent"))!;
        expect(gap).toContain("covers them: bin/cli.js; declare suites[].artifacts");
    });
    it("P4: a package.json of exactly the size limit is still read, so its name becomes the project id", () => {
        const limit = 256 * 1024;
        const head = JSON.stringify({ name: "bigpkg", pad: "" });
        const text = JSON.stringify({ name: "bigpkg", pad: "x".repeat(limit - head.length) });
        expect(Buffer.byteLength(text)).toBe(limit);
        expect(only(tree({ "package.json": text })).id).toBe("bigpkg");
    });
    it("N1: a package.json one byte over the size limit is ignored as unreadable, so the directory name is not replaced by its name", () => {
        const limit = 256 * 1024;
        const head = JSON.stringify({ name: "bigpkg", pad: "" });
        const text = JSON.stringify({ name: "bigpkg", pad: "x".repeat(limit - head.length + 1) });
        expect(only(tree({ "package.json": text })).id).not.toBe("bigpkg");
    });
});
