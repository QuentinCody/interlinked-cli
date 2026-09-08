import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { lintCheckCommand } from "../../commands/lint.js";
import { tightenLintBaseline } from "./baseline.js";
import { LINT_BASELINE_PATH, LINT_POLICY_PATH, lintObject, writeLintJson } from "./policy.js";
import { measureImportedLint } from "./runner.js";
import { prepareLintImport } from "./selection.js";

const roots: string[] = [];
const originalExitCode = process.exitCode;
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    process.exitCode = originalExitCode;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "lint-clippy-output-")));
    roots.push(root);
    for (const directory of ["bin", "src", "target", ".cargo", ".interlinked"]) mkdirSync(join(root, directory));
    writeFileSync(join(root, "Cargo.toml"), '[package]\nname="fixture"\nversion="0.1.0"\n[lints.clippy]\nunwrap_used="warn"\n');
    writeFileSync(join(root, ".cargo/config.toml"), '[build]\ntarget-dir="target"\nbuild-dir="configured-build"\n');
    writeFileSync(join(root, "src/lib.rs"), '#[path = "../target/generated.rs"] mod generated;\n');
    writeFileSync(join(root, "target/generated.rs"), "pub fn value() -> u8 { 1 }\n");
    const command = join(root, "bin/cargo");
    // Exercise the actual subprocess boundary. This fixture models only Cargo's
    // documented output-dir precedence, writes fingerprints, and reports source
    // read before a controlled edit. It is not a replacement Cargo parser.
    writeFileSync(command, `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const separator = args.indexOf("--");
const cargoArgs = separator < 0 ? args : args.slice(0, separator);
const option = (key) => { const at = cargoArgs.indexOf(key); return at < 0 ? undefined : cargoArgs[at + 1]; };
const config = fs.readFileSync(".cargo/config.toml", "utf8");
const configured = (key, fallback) => {
    const row = config.split("\\n").find((line) => line.startsWith(key + "="));
    return row ? JSON.parse(row.slice(key.length + 1)) : fallback;
};
const target = option("--target-dir") ?? process.env.CARGO_TARGET_DIR ?? process.env.CARGO_BUILD_TARGET_DIR ?? configured("target-dir", "target");
const override = option("--config");
const build = override?.startsWith("build.build-dir=") ? JSON.parse(override.slice("build.build-dir=".length)) : process.env.CARGO_BUILD_BUILD_DIR ?? configured("build-dir", target);
const env = { CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR, CARGO_BUILD_TARGET_DIR: process.env.CARGO_BUILD_TARGET_DIR, CARGO_BUILD_BUILD_DIR: process.env.CARGO_BUILD_BUILD_DIR };
fs.writeFileSync(".interlinked/cargo-run.json", JSON.stringify({ args, target, build, env }));
for (const directory of new Set([target, build])) {
    fs.mkdirSync(directory, { recursive: true });
    fs.appendFileSync(path.join(directory, "fingerprint"), "compiled\\n");
}
const mode = fs.existsSync(".interlinked/mode") ? fs.readFileSync(".interlinked/mode", "utf8") : "clean";
const analyzed = fs.readFileSync("target/generated.rs", "utf8");
if (mode === "change-source") fs.appendFileSync("target/generated.rs", "// concurrent source edit\\n");
if (mode === "fail") process.exit(101);
if (mode === "hang") setInterval(() => {}, 1000);
else {
    if (analyzed.includes("unwrap")) fs.writeSync(1, JSON.stringify({ reason: "compiler-message", message: { level: "warning", code: { code: "clippy::unwrap_used" }, message: "used unwrap", spans: [{ is_primary: true, file_name: "target/generated.rs", line_start: 1 }] } }) + "\\n");
    fs.writeSync(1, JSON.stringify({ reason: "build-finished", success: true }) + "\\n");
}
`);
    chmodSync(command, 0o700);
    return root;
}

function receipt(root: string) {
    const record = lintObject(JSON.parse(readFileSync(join(root, ".interlinked/cargo-run.json"), "utf8")));
    assert(typeof record.target === "string");
    assert(typeof record.build === "string");
    return { ...record, target: record.target, build: record.build };
}

it("keeps Clippy measured while directing configured and environment-selected compiler output outside the source tree", async () => {
    const root = project();
    for (const variable of ["CARGO_TARGET_DIR", "CARGO_BUILD_TARGET_DIR", "CARGO_BUILD_BUILD_DIR"]) vi.stubEnv(variable, join(root, "environment-build"));
    const { policy } = prepareLintImport(root, {});
    const entry = policy.entries[0];
    assert(entry);
    entry.flags = ["--workspace", "--all-targets", "--features", "strict", "--target", "wasm32-unknown-unknown", "--manifest-path", "Cargo.toml", "--locked", "--offline"];
    expect(await measureImportedLint(root, policy)).toMatchObject([{ status: "measured", findings: [] }]);
    const result = receipt(root);
    const rel = relative(root, result.target);
    expect(isAbsolute(rel) || /^\.\.(?:[\\/]|$)/.test(rel)).toBe(true);
    expect(result).toMatchObject({
        build: result.target,
        args: ["clippy", "--target-dir", result.target, "--config", `build.build-dir=${JSON.stringify(result.target)}`, ...entry.flags, "--message-format=json", "--", "--cap-lints=warn"],
        env: { CARGO_TARGET_DIR: result.target, CARGO_BUILD_TARGET_DIR: result.target, CARGO_BUILD_BUILD_DIR: result.target },
    });
    expect(existsSync(result.target)).toBe(false);
    expect(existsSync(join(root, "target/fingerprint"))).toBe(false);
    expect(existsSync(join(root, "configured-build"))).toBe(false);
    expect(existsSync(join(root, "environment-build"))).toBe(false);
    expect(readFileSync(join(root, "target/generated.rs"), "utf8")).toBe("pub fn value() -> u8 { 1 }\n");
});

it("retains existing target-directory source in the freshness closure and preserves baseline debt after its concurrent edit", async () => {
    const root = project();
    writeFileSync(join(root, "target/generated.rs"), "pub fn value() -> u8 { Some(1).unwrap() }\n");
    const { policy } = prepareLintImport(root, {});
    writeLintJson(root, LINT_POLICY_PATH, policy);
    const initial = await measureImportedLint(root, policy);
    expect(initial).toMatchObject([{ status: "measured", findings: [{ file: "target/generated.rs", rule: "clippy::unwrap_used" }] }]);
    tightenLintBaseline(root, initial);
    const baseline = readFileSync(join(root, LINT_BASELINE_PATH), "utf8");
    writeFileSync(join(root, "target/generated.rs"), "pub fn value() -> u8 { 1 }\n");
    writeFileSync(join(root, ".interlinked/mode"), "change-source");
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    await lintCheckCommand(root, { json: true });
    expect(process.exitCode).toBe(2);
    const report: unknown = JSON.parse(String(output.mock.calls[0]?.[0]));
    expect(report).toMatchObject({ complete: false, baseline_updated: false, measurements: [{ status: "unavailable", reason: expect.stringContaining("target/generated.rs") }] });
    expect(readFileSync(join(root, LINT_BASELINE_PATH), "utf8")).toBe(baseline);
    expect(existsSync(receipt(root).target)).toBe(false);
});

it.each(["fail", "hang"])("removes compiler output after an unavailable %s run", async (mode) => {
    const root = project();
    writeFileSync(join(root, ".interlinked/mode"), mode);
    const { policy } = prepareLintImport(root, {});
    const result = await measureImportedLint(root, policy, { timeoutMs: 1500 });
    expect(result).toMatchObject([{ status: "unavailable", findings: [] }]);
    expect(result[0]?.reason).toContain(mode === "fail" ? "exited 101" : "timed out");
    expect(existsSync(receipt(root).target)).toBe(false);
});

it("refuses an OS temporary directory inside the project before launching Cargo", async () => {
    const root = project();
    const { policy } = prepareLintImport(root, {});
    for (const variable of ["TMPDIR", "TEMP", "TMP"]) vi.stubEnv(variable, root);
    expect(await measureImportedLint(root, policy)).toMatchObject([{ status: "unavailable", reason: "Clippy requires a temporary directory outside the project; no verdict" }]);
    expect(existsSync(join(root, ".interlinked/cargo-run.json"))).toBe(false);
});
