import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CHECK_IDENTITY_VERSION, checkIdentity, identityEnvironmentHash, policyDigest, reporterBinding, reporterBindingChanged, toolchainIdentity, type CheckIdentityInput } from "./check-identity.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(): string {
    // Real path: Node's resolver reports real paths and the binder starts from them, so expectations must match.
    const root = realpathSync(mkdtempSync(join(tmpdir(), "check-identity-")));
    roots.push(root);
    return root;
}
const base: CheckIdentityInput = {
    inputs: { snapshot: "snap", runtimeHash: "rt" },
    command: ["vitest", "full", "--workers", "2"],
    toolchain: { node: "22.0.0", vitest: "4.1.0", typescript: "5.9.0" },
    environmentHash: "env",
    platform: "darwin-arm64-25.0.0",
    policy: "policy",
};

describe("checkIdentity — positive (must fire)", () => {
    // test-contract: public-api — the identity is a stable sha256 of every dimension; the same input always yields the same digest
    it("P1: is deterministic and version-tagged", () => {
        const first = checkIdentity(base), second = checkIdentity({ ...base });
        expect(first).toBe(second);
        expect(first).toMatch(/^[0-9a-f]{64}$/);
        expect(CHECK_IDENTITY_VERSION).toBe("check-identity-v4");
    });

    // test-contract: public-api — the toolchain identity carries the installed vitest and typescript versions from the project's node_modules
    it("P2: reads toolchain versions from the project's installed packages", () => {
        const root = fixture();
        for (const [name, version] of [["vitest", "4.1.11"], ["typescript", "5.9.3"]] as const) {
            mkdirSync(join(root, "node_modules", name), { recursive: true });
            writeFileSync(join(root, "node_modules", name, "package.json"), JSON.stringify({ name, version }));
        }
        expect(toolchainIdentity(root)).toEqual({ node: process.versions.node, vitest: "4.1.11", typescript: "5.9.3" });
    });

    // test-contract: public-api — the policy digest covers the water-line files that decide a verdict and ignores their absence deterministically
    it("P3: digests the present policy files and changes when one changes", () => {
        const root = fixture();
        const empty = policyDigest(root);
        writeFileSync(join(root, "vitest.config.ts"), "export default {};");
        mkdirSync(join(root, ".interlinked"), { recursive: true });
        writeFileSync(join(root, ".interlinked", "coverage-baseline.json"), '{"version":1,"files":{}}');
        const withPolicy = policyDigest(root);
        expect(withPolicy).not.toBe(empty);
        writeFileSync(join(root, ".interlinked", "coverage-baseline.json"), '{"version":1,"files":{"a.ts":{"lines":90}}}');
        expect(policyDigest(root)).not.toBe(withPolicy);
        expect(policyDigest(root)).toMatch(/^[0-9a-f]{64}$/);
    });
});

describe("checkIdentity — negative (must not fire): every dimension separates identities", () => {
    // test-contract: invariant — a change in any single dimension (inputs, command, toolchain, environment, platform, policy) yields a different identity
    it.each<[string, Partial<CheckIdentityInput>]>([
        ["inputs", { inputs: { snapshot: "snap2", runtimeHash: "rt" } }],
        ["runtime", { inputs: { snapshot: "snap", runtimeHash: "rt2" } }],
        ["command", { command: ["vitest", "full", "--workers", "2", "--coverage"] }],
        ["toolchain", { toolchain: { node: "22.0.0", vitest: "4.2.0", typescript: "5.9.0" } }],
        ["environment", { environmentHash: "env2" }],
        ["platform", { platform: "linux-x64-6.1.0" }],
        ["policy", { policy: "policy2" }],
    ])("N: a different %s is a different identity", (_dimension, change) => {
        expect(checkIdentity({ ...base, ...change })).not.toBe(checkIdentity(base));
    });

    // test-contract: invariant — only variables proven not to reach a verdict are ignored: shell cwd bookkeeping, git's hook-only variables and this route's own bookkeeping; everything a test could read still separates
    it("N: ignores only shell, git-hook and route bookkeeping variables; anything a test could read still separates", () => {
        const base = { HOME: "/Users/dev", LANG: "en_US.UTF-8", NODE_ENV: "test", PATH: "/usr/bin:/bin", TERM: "xterm-256color", INTERLINKED_REVIEW_FLAG: "pass" };
        const terminal = { ...base, PWD: "/repo", SHLVL: "1", OLDPWD: "/" };
        const hookBookkeeping = { ...base, PWD: "/tmp/prepush-export/tree", SHLVL: "2", GIT_EXEC_PATH: "/usr/libexec/git-core", GIT_PREFIX: "", GIT_CONFIG_PARAMETERS: "'core.hooksPath=x'",
            INTERLINKED_STAGE: "push", INTERLINKED_STAGES_LEDGER: "/repo/.interlinked/x.jsonl", INTERLINKED_BOUNDED_OUTCOME: "/tmp/o.json", INTERLINKED_LEASE_ANCESTORS: "1,2" };
        expect(identityEnvironmentHash(hookBookkeeping)).toBe(identityEnvironmentHash(terminal));
        for (const change of [{ NODE_ENV: "production" }, { CI: "1" }, { NODE_OPTIONS: "--max-old-space-size=512" }, { PATH: "/opt/other/bin:/usr/bin:/bin" },
            { INTERLINKED_REVIEW_FLAG: "fail" }, { SDKROOT: "/sdk" }, { TMPDIR: "/elsewhere" }, { TERM: "dumb" }]) {
            expect(identityEnvironmentHash({ ...terminal, ...change }), JSON.stringify(change)).not.toBe(identityEnvironmentHash(terminal));
        }
    });

    // test-contract: invariant — code executed from outside the checkout (a reporter module) is bound by its bytes and every statically loadable dependency, resolved from the importing module's location: a bare package beside the reporter is bound too; builtins are not inputs
    it("N: binds a reporter, its relative imports and a bare package resolved beside it", () => {
        const root = fixture();
        mkdirSync(join(root, "lib"), { recursive: true });
        mkdirSync(join(root, "node_modules", "beside"), { recursive: true });
        writeFileSync(join(root, "node_modules", "beside", "package.json"), JSON.stringify({ name: "beside", main: "index.js" }));
        writeFileSync(join(root, "node_modules", "beside", "index.js"), "module.exports = { beside() {} };\n");
        writeFileSync(join(root, "reporter.mjs"), 'import { basename } from "node:path";\nimport { helper } from "./lib/helper.mjs";\nimport { beside } from "beside";\nexport default class R { onInit() { helper(); beside(); basename; } }\n');
        writeFileSync(join(root, "lib", "helper.mjs"), "export function helper() {}\n");
        const first = reporterBinding([join(root, "reporter.mjs")]);
        expect(first.unresolved).toEqual([]);
        expect(first.opaque).toEqual([]);
        // A dependency is bound by its complete installed contents (here: its entry file and its manifest).
        expect(first.entries.map(([path]) => path).sort()).toEqual([join(root, "lib", "helper.mjs"), join(root, "node_modules", "beside", "index.js"), join(root, "node_modules", "beside", "package.json"), join(root, "reporter.mjs")].sort());
        // A changed bare dependency beside the reporter is a different identity.
        writeFileSync(join(root, "node_modules", "beside", "index.js"), "module.exports = { beside() { throw new Error('boom'); } };\n");
        const changed = reporterBinding([join(root, "reporter.mjs")]);
        expect(reporterBindingChanged(first, changed)).toBe(true);
        const command = (binding: typeof first) => ["vitest", "full", ...binding.entries.map(([path, sha]) => `--reporter=${path}#${sha}`)];
        expect(checkIdentity({ ...base, command: command(changed) })).not.toBe(checkIdentity({ ...base, command: command(first) }));
    });

    /** A package under `root/node_modules` with the given manifest fields and files. */
    function installPackage(root: string, name: string, pkg: { manifest?: Record<string, unknown>; files: Record<string, string> }): string {
        const dir = join(root, "node_modules", name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", ...pkg.manifest }));
        for (const [file, text] of Object.entries(pkg.files)) writeFileSync(join(dir, file), text);
        return dir;
    }

    // test-contract: invariant — a dependency's version binds nothing: an edited internal file the entry re-exports (never named by the reporter) is a different identity, and so is a file in a package the dependency itself declares
    it("N: binds a dependency's complete installed contents and its declared dependencies' contents", () => {
        const root = fixture();
        const dependency = installPackage(root, "review-reporter-package", { manifest: { type: "module", exports: "./index.js", dependencies: { "review-inner": "1.0.0" } },
            files: { "index.js": 'export { default } from "./helper.mjs";\n', "helper.mjs": "export default function helper() {}\n" } });
        const inner = installPackage(root, "review-inner", { manifest: { main: "index.js" }, files: { "index.js": "module.exports = 1;\n", "deep.js": "module.exports = 2;\n" } });
        writeFileSync(join(root, "reporter.mjs"), 'import helper from "review-reporter-package";\nexport default class R { onInit() { helper(); } }\n');
        const first = reporterBinding([join(root, "reporter.mjs")]);
        expect(first.unresolved).toEqual([]);
        const bound = first.entries.map(([path]) => path);
        expect(bound).toContain(join(dependency, "helper.mjs"));
        expect(bound).toContain(join(inner, "deep.js"));
        writeFileSync(join(dependency, "helper.mjs"), "export default function helper() { throw new Error('changed'); }\n");
        expect(reporterBindingChanged(first, reporterBinding([join(root, "reporter.mjs")]))).toBe(true);
        writeFileSync(join(dependency, "helper.mjs"), "export default function helper() {}\n");
        writeFileSync(join(inner, "deep.js"), "module.exports = 3;\n");
        expect(reporterBindingChanged(first, reporterBinding([join(root, "reporter.mjs")]))).toBe(true);
    });

    // test-contract: invariant — a load is resolved by its own loading mode: `from` reads a conditional `exports` under `import`, `require()` under `require`; a subpath map, a missing subpath and an exports pattern behave as Node does or are unresolved
    it("N: resolves a conditional exports map by the load's actual mode", () => {
        const root = fixture();
        const dependency = installPackage(root, "conditional", { manifest: { type: "module", exports: { import: "./esm.mjs", require: "./cjs.cjs" } },
            files: { "esm.mjs": "export default function helper() {}\n", "cjs.cjs": "module.exports = function helper() {};\n" } });
        writeFileSync(join(root, "esm-reporter.mjs"), 'import helper from "conditional";\nexport default class R { onInit() { helper(); } }\n');
        writeFileSync(join(root, "cjs-reporter.cjs"), 'const helper = require("conditional");\nmodule.exports = class R { onInit() { helper(); } };\n');
        for (const reporter of ["esm-reporter.mjs", "cjs-reporter.cjs"]) {
            const binding = reporterBinding([join(root, reporter)]);
            expect(binding.unresolved, reporter).toEqual([]);
            expect(binding.entries.map(([path]) => path), reporter).toContain(join(dependency, "esm.mjs"));
        }
        installPackage(root, "mapped", { manifest: { exports: { ".": { default: "./main.js" }, "./sub": "./sub.js" } }, files: { "main.js": "", "sub.js": "" } });
        installPackage(root, "patterned", { manifest: { exports: { "./*": "./lib/*.js" } }, files: { "x.js": "" } });
        writeFileSync(join(root, "sub.mjs"), 'import "mapped/sub";\nimport "mapped";\n');
        expect(reporterBinding([join(root, "sub.mjs")]).unresolved).toEqual([]);
        writeFileSync(join(root, "missing-sub.mjs"), 'import "mapped/other";\n');
        expect(reporterBinding([join(root, "missing-sub.mjs")]).unresolved).toEqual([`${join(root, "missing-sub.mjs")} -> mapped/other (import)`]);
        writeFileSync(join(root, "pattern.mjs"), 'import "patterned/x";\n');
        expect(reporterBinding([join(root, "pattern.mjs")]).unresolved).toEqual([`${join(root, "pattern.mjs")} -> patterned/x (import)`]);
    });

    // test-contract: boundary — an ESM relative import names an exact file (no extension probing); a declared dependency that is not installed, and a dependency closure over the file bound, are unresolved
    it("N: an extensionless ESM import, a missing declared dependency and an over-bound package are unresolved", () => {
        const root = fixture();
        writeFileSync(join(root, "helper.mjs"), "export default 1;\n");
        writeFileSync(join(root, "bare.mjs"), 'import "./helper";\n');
        expect(reporterBinding([join(root, "bare.mjs")]).unresolved).toEqual([`${join(root, "bare.mjs")} -> ./helper (import)`]);
        const orphan = installPackage(root, "orphan", { manifest: { main: "index.js", dependencies: { "never-installed": "1.0.0" }, peerDependencies: { "absent-peer": "1.0.0" } }, files: { "index.js": "" } });
        writeFileSync(join(root, "orphan.mjs"), 'import "orphan";\n');
        expect(reporterBinding([join(root, "orphan.mjs")]).unresolved).toEqual([`${orphan} -> never-installed (declared dependency not installed)`]);
        const files = Object.fromEntries(Array.from({ length: 401 }, (_, index) => [`f${index}.js`, ""]));
        installPackage(root, "huge", { manifest: { main: "f0.js" }, files });
        writeFileSync(join(root, "huge.mjs"), 'import "huge";\n');
        expect(reporterBinding([join(root, "huge.mjs")]).unresolved.some(entry => entry.includes("closure exceeds 400 files"))).toBe(true);
    });

    // test-contract: invariant — a load nothing can hash statically (missing file, unresolvable specifier, computed import, createRequire) is unresolved and forbids reuse
    it.each([
        ["a missing relative import", 'import "./lib/missing.mjs";\n', "/lib/missing.mjs"],
        ["an unresolvable bare specifier", 'import "no-such-package-anywhere";\n', "-> no-such-package-anywhere"],
        ["a computed dynamic import", 'const name = "./x.mjs";\nexport default class R { async onInit() { await import(name); } }\n', "(computed load)"],
        ["a computed require", 'const name = "typescript";\nexport default class R { onInit() { require(name); } }\n', "(computed load)"],
        ["a string-prefixed computed import (parsed, never prefix-matched)", 'const extension = ".mjs";\nexport default class R { async onInit() { const m = await import("./helper" + extension); m.default(); } }\n', ":2 (computed load)"],
        ["a template computed import", 'const name = "helper";\nexport default class R { async onInit() { await import(`./${name}.mjs`); } }\n', "(computed load)"],
        ["a module that does not parse", "export default class R { onInit( {\n", "(does not parse)"],
    ])("N: %s is unresolved", (_title, source, marker) => {
        const root = fixture();
        writeFileSync(join(root, "helper"), "export default function helper() {}\n");
        writeFileSync(join(root, "helper.mjs"), "export default function helper() {}\n");
        writeFileSync(join(root, "reporter.mjs"), source);
        const binding = reporterBinding([join(root, "reporter.mjs")]);
        expect(binding.unresolved.length).toBeGreaterThan(0);
        expect(binding.unresolved.some(entry => entry.includes(marker))).toBe(true);
        // A prefix file that happens to exist is never bound as the computed load's target.
        expect(binding.entries.map(([path]) => path)).not.toContain(join(root, "helper"));
    });

    // test-contract: invariant — the input-eligibility rule tests obey applies to reporters and their dependencies: a runtime read the bytes cannot pin (the file system, the process, the clock, createRequire) or an impure builtin import is OPAQUE and forbids reuse, while pure builtins are not
    it.each([
        ["a node:fs read", 'import { readFileSync } from "node:fs";\nexport default class R { onInit() { readFileSync("/etc/hosts"); } }\n', "(imports readFileSync from node:fs)"],
        ["an unprefixed impure builtin", 'import { readFileSync } from "fs";\nexport default class R { onInit() { readFileSync("/etc/hosts"); } }\n', "(imports readFileSync from fs)"],
        ["process.env", 'export default class R { onInit() { if (process.env.MODE) throw new Error("x"); } }\n', "(reads `process`)"],
        ["the clock", 'export default class R { onInit() { Date.now(); } }\n', "(reads `Date`)"],
        ["createRequire", 'import { createRequire } from "node:module";\nexport default class R { onInit() { createRequire("/x")("typescript"); } }\n', "(reads `createRequire`)"],
        ["require", 'const helper = require("./helper.cjs");\nmodule.exports = class R { onInit() { helper(); } };\n', "(reads `require`)"],
    ])("N: %s makes the reporter opaque", (_title, source, marker) => {
        const root = fixture();
        writeFileSync(join(root, "helper.cjs"), "module.exports = function helper() {};\n");
        writeFileSync(join(root, "reporter.mjs"), source);
        const binding = reporterBinding([join(root, "reporter.mjs")]);
        expect(binding.opaque.some(entry => entry.includes(marker)), binding.opaque.join("; ")).toBe(true);
    });

    it("N: a dependency whose installed code reads the runtime makes the reporter opaque; pure builtins do not", () => {
        const root = fixture();
        const impure = installPackage(root, "impure", { manifest: { main: "index.js" }, files: { "index.js": "module.exports = () => process.cwd();\n" } });
        writeFileSync(join(root, "pure.mjs"), 'import { join } from "node:path";\nimport { format } from "node:util";\nimport { strict } from "node:assert";\nexport default class R { onInit() { join("a", format("%s", "b")); strict; } }\n');
        expect(reporterBinding([join(root, "pure.mjs")]).opaque).toEqual([]);
        writeFileSync(join(root, "impure.mjs"), 'import cwd from "impure";\nexport default class R { onInit() { cwd(); } }\n');
        expect(reporterBinding([join(root, "impure.mjs")]).opaque).toEqual([`${join(impure, "index.js")} (reads \`process\`)`]);
    });

    // test-contract: invariant — installed package code gets the SAME parsed checks as the reporter: an impure builtin import or a computed load inside a dependency is opaque / unresolved, not hidden behind the package boundary
    it("N: a dependency's installed code importing node:fs is opaque and one with a computed load is unresolved", () => {
        const root = fixture();
        const reader = installPackage(root, "reader", { manifest: { type: "module", exports: "./index.js" }, files: { "index.js": 'import { readFileSync } from "node:fs";\nexport default () => readFileSync("/etc/hosts", "utf8");\n' } });
        writeFileSync(join(root, "reader.mjs"), 'import read from "reader";\nexport default class R { onInit() { read(); } }\n');
        expect(reporterBinding([join(root, "reader.mjs")]).opaque).toEqual([`${join(reader, "index.js")} (imports readFileSync from node:fs)`]);
        const loader = installPackage(root, "loader", { manifest: { type: "module", exports: "./index.js" }, files: { "index.js": "export default async (name) => (await import(name)).default;\n" } });
        writeFileSync(join(root, "loader.mjs"), 'import load from "loader";\nexport default class R { onInit() { load("x"); } }\n');
        expect(reporterBinding([join(root, "loader.mjs")]).unresolved).toEqual([`${join(loader, "index.js")}:1 (computed load)`]);
        // A declaration file never runs: its imports are not loads.
        installPackage(root, "typed", { manifest: { main: "index.js" }, files: { "index.js": "module.exports = 1;\n", "index.d.ts": 'import { PathLike } from "node:fs";\nexport declare const x: PathLike;\n' } });
        writeFileSync(join(root, "typed.mjs"), 'import "typed";\n');
        expect(reporterBinding([join(root, "typed.mjs")]).opaque).toEqual([]);
    });

    // test-contract: invariant — builtin purity is per OPERATION, never module-wide: `path.resolve` / `path.relative` read the working directory and a namespace import of `node:path` reaches them, while `join` / `basename` do not
    it.each([
        ["a named import of path.resolve", 'import { resolve } from "node:path";\nexport default class R { onInit() { resolve("."); } }\n', "(imports resolve from node:path)"],
        ["a named import of path.relative", 'import { join, relative } from "node:path";\nexport default class R { onInit() { relative(join("a"), "b"); } }\n', "(imports join, relative from node:path)"],
        ["a namespace import of node:path", 'import * as path from "node:path";\nexport default class R { onInit() { path.resolve("."); } }\n', "(imports * from node:path)"],
        ["a default import of node:path", 'import path from "path";\nexport default class R { onInit() { path.join("a"); } }\n', "(imports * from path)"],
        ["url.pathToFileURL", 'import { pathToFileURL } from "node:url";\nexport default class R { onInit() { pathToFileURL("x"); } }\n', "(imports pathToFileURL from node:url)"],
        ["buffer.File's default timestamp", 'import { File } from "node:buffer";\nexport default class R { onInit() { return new File([], "x").lastModified; } }\n', "(imports File from node:buffer)"],
        ["events async context", 'import { EventEmitterAsyncResource } from "node:events";\nexport default class R { onInit() { return new EventEmitterAsyncResource({name: "reporter"}).asyncId; } }\n', "(imports EventEmitterAsyncResource from node:events)"],
        ["global Buffer unsafe allocation", 'export default class R { onInit() { return Buffer.allocUnsafe(32)[0]; } }\n', "(reads `Buffer`)"],
    ])("N: %s is opaque", (_title, source, marker) => {
        const root = fixture();
        writeFileSync(join(root, "reporter.mjs"), source);
        expect(reporterBinding([join(root, "reporter.mjs")]).opaque.some(entry => entry.includes(marker))).toBe(true);
    });

    // test-contract: boundary — a missing toolchain package is recorded as absent, never as a guessed version
    it("N: reports an absent package as null", () => {
        const root = fixture();
        expect(toolchainIdentity(root)).toEqual({ node: process.versions.node, vitest: null, typescript: null });
    });
});
