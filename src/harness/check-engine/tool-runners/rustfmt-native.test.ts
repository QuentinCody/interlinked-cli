import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { CheckEngine } from "../index.js";

// Direct installed toolchain binaries work with the suite's isolated HOME.
const toolchain = process.env.INTERLINKED_NATIVE_RUST_TOOLCHAIN_BIN;
if (toolchain) vi.stubEnv("PATH", `${toolchain}${delimiter}${process.env.PATH ?? ""}`);
afterAll(() => vi.unstubAllEnvs());
const native = ["cargo", "rustfmt"].every(bin => spawnSync(bin, ["--version"], {
	timeout: 10_000, stdio: "ignore", env: { ...process.env, RUSTUP_AUTO_INSTALL: "0", CARGO_NET_OFFLINE: "true" },
}).status === 0);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function project(): string { const root = mkdtempSync(join(tmpdir(), "rustfmt-native-")); roots.push(root); return root; }
function file(root: string, path: string, body: string): string {
	const target = join(root, path); mkdirSync(join(target, ".."), { recursive: true }); writeFileSync(target, body); return target;
}
function check(root: string) {
	return new CheckEngine(root, { discoveryTimeoutMs: 0 }).runChecksAsync({ projectRoot: root, mode: "project" }, {
		tools: ["rustfmt"], timeoutMs: 0, resourcePolicy: "foreground-verify",
	});
}

it.skipIf(!native)("native root crate retains formatting differences without executing its build script or writing sources", async () => {
	const root = project(), marker = join(root, "build-executed");
	file(root, "Cargo.toml", '[package]\nname="native_check"\nversion="0.1.0"\nedition="2024"\n');
	file(root, "build.rs", `fn main() {\n    std::fs::write(${JSON.stringify(marker)}, "executed").unwrap();\n}\n`);
	const source = file(root, "src/lib.rs", "pub async fn value()->u8{1}\n"), before = readFileSync(source, "utf8");
	const report = await check(root);
	expect(report.toolsRun.map(tool => tool.id)).toEqual(["rustfmt"]);
	expect(report.skipped).toEqual([]);
	expect(report.results).toContainEqual(expect.objectContaining({ tool: "rustfmt", file: "src/lib.rs" }));
	expect(readFileSync(source, "utf8")).toBe(before); expect(existsSync(marker)).toBe(false);
}, 30_000);

it.skipIf(!native)("native virtual workspace includes differently-editioned fixture/test-named declared members", async () => {
	const root = project();
	file(root, "Cargo.toml", '[workspace]\nmembers=["fixtures/a", "tests/b"]\nresolver="2"\n');
	for (const [member, edition] of [["fixtures/a", "2018"], ["tests/b", "2024"]] as const) {
		file(root, `${member}/Cargo.toml`, `[package]\nname="${member.endsWith("a") ? "member_a" : "member_b"}"\nversion="0.1.0"\nedition="${edition}"\n`);
		file(root, `${member}/src/lib.rs`, "pub async fn value()->u8{1}\n");
	}
	const report = await check(root);
	expect(report.skipped).toEqual([]);
	expect(new Set(report.results.map(row => row.file))).toEqual(new Set(["fixtures/a/src/lib.rs", "tests/b/src/lib.rs"]));
}, 30_000);

it.skipIf(!native)("native root scope leaves an external local dependency outside formatting selection", async () => {
	const base = project(), root = join(base, "app");
	file(root, "Cargo.toml", '[package]\nname="native_app"\nversion="0.1.0"\nedition="2021"\n[dependencies]\nexternal_dep={path="../dependency"}\n');
	file(root, "src/lib.rs", "pub fn value() -> u8 {\n    1\n}\n");
	file(base, "dependency/Cargo.toml", '[package]\nname="external_dep"\nversion="0.1.0"\nedition="2021"\n');
	const dependency = file(base, "dependency/src/lib.rs", "pub fn dependency()->u8{1}\n");
	const before = readFileSync(dependency, "utf8"), report = await check(root);
	expect(report.skipped).toEqual([]); expect(report.results).toEqual([]);
	expect(readFileSync(dependency, "utf8")).toBe(before);
}, 30_000);

it.skipIf(!native)("native standalone configuration parses a complete source above 1MiB and retains its end-of-file difference", async () => {
	const root = project(); file(root, "rustfmt.toml", 'edition="2024"\n');
	const source = file(root, "standalone.rs", `${`// ${"x".repeat(200)}\n`.repeat(6000)}pub async fn value()->u8{1}\n`);
	const before = readFileSync(source, "utf8"), report = await check(root);
	expect(Buffer.byteLength(before)).toBeGreaterThan(1024 * 1024);
	expect(report.skipped).toEqual([]);
	expect(report.results).toContainEqual(expect.objectContaining({ file: "standalone.rs", line: expect.any(Number) }));
	expect(report.results.some(row => row.line > 5990)).toBe(true);
	expect(readFileSync(source, "utf8")).toBe(before);
}, 30_000);
