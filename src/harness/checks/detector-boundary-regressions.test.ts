import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkAccumulatingSpread, checkRequireAwait, checkThrowLiteral } from "./agent-safety-advanced-style.js";
import { checkFloatingPromises, checkMisusedPromises } from "./agent-safety-async.js";
import { checkExtraneousDependencies } from "./agent-safety-deps.js";
import { checkTlsVerifyDisabled } from "./agent-safety-crypto.js";
import { checkFocusedTests } from "./focused-tests.js";
import { checkImportFromOwnBarrel } from "./imports.js";
import { checkPlaceholderTests } from "./placeholder-tests.js";
import { checkPackageJsonPublishInvariants, checkPackageJsonScriptPaths } from "./package-json.js";
import { detectUnknownTypeAlias } from "./type-discipline-unknown-alias.js";
import { checkDirectDomAccess } from "./react.js";
import { checkMigrationOrdering, checkSqlSchemaConsistency } from "./sql-migrations.js";
import { detectUnawaitedAsyncAssertions } from "./test-async-assertions.js";
import { checkHardcodedTimeoutInTests, checkTestSubprocessDefaultTimeout } from "./test-hygiene-isolation.js";
import { findSkipMarkers } from "./test-skip-markers.js";
import { checkSnapshotOveruse, checkTestImportingTest } from "./testing.js";
import { checkPyNoneEquality } from "./ubs-language-specific/python-checks.js";
import { blankPythonTripleQuotedStrings } from "./ubs-language-specific/_shared.js";
import { checkCookieMissingSecurityFlags, checkMixedSyncAsyncFileApi } from "./ubs-language-specific/js-security-checks.js";
import { checkMutexLockUnwrap } from "./ubs-language-specific/rust-go-checks.js";
import { checkAssertionFreeTest, checkMockingTheSUT } from "../taste-checks-test-assertions.js";

const TS = "src/service.ts";
const TEST = "src/service.test.ts";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("bounded detector output and partially edited source", () => {
    it("excludes vendored throw literals while checking production source", () => {
        expect(checkThrowLiteral('throw "bad";', "vendor/library.ts")).toEqual([]);
        expect(checkThrowLiteral('throw "bad";', TS)).toHaveLength(1);
    });

    it("caps independent async and accumulating-spread findings at ten locations", () => {
        const asyncBody = "{\nwork();\nwork();\nwork();\nwork();\nwork();\nwork();\n}";
        const asyncSource = Array.from({ length: 12 }, (_, i) => `async function task${i}() ${asyncBody}`).join("\n");
        const spreadSource = Array.from({ length: 12 }, (_, i) => `const out${i} = items.reduce((acc, x) => [...acc, x], []);`).join("\n");
        expect(checkRequireAwait(asyncSource, TS).map(hit => hit.line)).toEqual([1, 9, 17, 25, 33, 41, 49, 57, 65, 73]);
        expect(checkAccumulatingSpread(spreadSource, TS).map(hit => hit.line)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        expect(checkRequireAwait("async function pending();", TS)).toEqual([]);
        expect(checkRequireAwait(`const load = async function () ${asyncBody};`, TS)).toHaveLength(1);
    });

    it("reports a line once even when multiple async callbacks float on it", () => {
        expect(checkMisusedPromises("a.forEach(async x => work(x)); b.forEach(async y => work(y));", TS)).toHaveLength(1);
        expect(checkMisusedPromises("a.reduce(async acc => await acc, Promise.resolve());", TS)).toEqual([]);
        expect(checkMisusedPromises("a.reduce(async () => work(), 0);", TS)).toHaveLength(1);
        expect(checkMisusedPromises("a.reduce(async (acc, x) => { work(x);", TS)).toHaveLength(1);
        expect(checkFloatingPromises("function fetch<T(\nfetch(url);", TS)).toEqual([]);
    });

    it("requires TLS verification callbacks in the same complete enclosing literal", () => {
        const prefix = "const config = { nested: { x: true }, rejectUnauthorized: false,";
        expect(checkTlsVerifyDisabled(`${prefix} requestCert: true };`, TS)).toEqual([]);
        expect(checkTlsVerifyDisabled(`${prefix} nestedVerifier: { requestCert: true } };`, TS)).toHaveLength(1);
        expect(checkTlsVerifyDisabled("rejectUnauthorized: false", TS)).toHaveLength(1);
        expect(checkTlsVerifyDisabled(`${prefix} requestCert: true`, TS)).toHaveLength(1);
    });

    it("does not confuse local focus-name bindings with runner globals", () => {
        expect(checkFocusedTests('const { fit } = require("./curve");\nfit(points);', TEST)).toEqual([]);
        expect(checkFocusedTests('const { fit, fdescribe, fcontext, ftest } = require("./curve");\nfit(points);', TEST)).toEqual([]);
        expect(checkFocusedTests('const { fit } = require("./curve");', TEST)).toEqual([]);
        expect(checkFocusedTests("fit(\n  name,\n", TEST)).toHaveLength(1);
        expect(checkFocusedTests('fit("focused", () => {});', TEST)).toHaveLength(1);
    });

    it("does not invent placeholder bodies while callback syntax is incomplete", () => {
        for (const code of ["it('x', function", "it('x', function name", "it('x', function(a,", "it('x', () => {", "it('x', "]) {
            expect(checkPlaceholderTests(code, TEST), code).toEqual([]);
        }
        expect(checkPlaceholderTests("it('x', function(\n  done\n) {});", TEST)).toHaveLength(1);
        expect(checkPlaceholderTests("it('x',\nfunction(done = makeDone()) {});", TEST)).toHaveLength(1);
        expect(checkPlaceholderTests("it('x', () => { test.skip('later', () => {}); });", TEST)).toEqual([]);
    });

    it("recovers DOM scanning after an effect nested inside another block closes", () => {
        const code = "function Component() {\nuseEffect(() => {\ndocument.querySelector('safe');\n}); }\ndocument.querySelector('unsafe');";
        expect(checkDirectDomAccess(code, "src/View.tsx").map(hit => hit.line)).toEqual([5]);
    });

    it("keeps incomplete async assertion handlers reportable", () => {
        expect(detectUnawaitedAsyncAssertions("test('x', done => {\n\nexpect(work()).resolves.toBe(1).catch(\n", TEST)).toHaveLength(1);
        expect(detectUnawaitedAsyncAssertions("test('x', function(done) {\nexpect(work()).resolves.toBe(1).then(() => done());\n});", TEST)).toEqual([]);
        expect(detectUnawaitedAsyncAssertions("test('x', (done) => {\nexpect(work()).resolves.toBe(1).finally(() => done());\n});", TEST)).toHaveLength(1);
        expect(detectUnawaitedAsyncAssertions(`test('x', done => {\nexpect(work()).resolves.toBe(1)${".next()".repeat(30)};\n});`, TEST)).toHaveLength(1);
        expect(detectUnawaitedAsyncAssertions("expect(work()).resolves.toBe(1);", "test_service.py")).toEqual([]);
    });

    it("distinguishes poll intervals from a fixed delay before checking a result", () => {
        expect(checkHardcodedTimeoutInTests("test('ready', async () => {\nwhile (!ready()) {\nawait sleep(100);\n}\nexpect(ready()).toBe(true);\n});", TEST)).toEqual([]);
        expect(checkHardcodedTimeoutInTests("test('ready', async () => {\nawait sleep(100); setTimeout(done, 200);\nexpect(ready()).toBe(true);\n});", TEST)).toHaveLength(1);
        expect(checkTestSubprocessDefaultTimeout("test('compile', () => { child_process.execSync('tsc'); });", TEST)).toHaveLength(1);
    });

    it("treats incomplete inline snapshots as opaque instead of inventing a literal", () => {
        for (const tail of ["", " ", "value", "value]", "value}"]) {
            const code = Array.from({ length: 5 }, () => `expect(value).toMatchInlineSnapshot(${tail}`).join("\n");
            expect(checkSnapshotOveruse(code, TEST), tail).toHaveLength(1);
        }
        const imports = Array.from({ length: 12 }, (_, i) => `require('./fixture${i}.test.ts');`).join("\n");
        expect(checkTestImportingTest(imports, TEST).map(hit => hit.line)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    });

    it("does not treat unused assertion imports as a test assertion", () => {
        const imports = 'import { strictEqual as same, deepEqual as deep } from "node:assert";\n';
        expect(checkAssertionFreeTest(`${imports}test('behavior', () => { work(); });`, TEST)).toHaveLength(1);
        expect(checkAssertionFreeTest(`${imports}test('behavior', () => { deep(work(), expected); });`, TEST)).toEqual([]);
        expect(checkMockingTheSUT('vi.mock("./service");', "test_service.py")).toEqual([]);
    });
});

describe("barrel graph boundaries", () => {
    function project(): string {
        const root = mkdtempSync(join(tmpdir(), "barrel-graph-")); roots.push(root); return root;
    }
    const importingBarrel = 'import { value } from "./index";';

    it("follows alias edges and exact-extension files without treating packages as local modules", () => {
        const root = project();
        writeFileSync(join(root, "index.ts"), 'export * from "@/bridge.ts"; export * from "external";');
        writeFileSync(join(root, "bridge.ts"), 'export * from "./consumer.ts";');
        expect(checkImportFromOwnBarrel(importingBarrel, join(root, "consumer.ts"))).toHaveLength(1);
        writeFileSync(join(root, "bridge.ts"), 'export * from "external";');
        expect(checkImportFromOwnBarrel(importingBarrel, join(root, "consumer.ts"))).toEqual([]);
    });

    it("keeps an unreadable or over-budget barrel graph unknown instead of claiming it cannot cycle", () => {
        const root = project();
        mkdirSync(join(root, "index.ts"));
        expect(checkImportFromOwnBarrel(importingBarrel, join(root, "consumer.ts"))).toHaveLength(1);
        rmSync(join(root, "index.ts"), { recursive: true });
        writeFileSync(join(root, "index.ts"), Array.from({ length: 65 }, (_, i) => `export * from "./part${i}.ts";`).join("\n"));
        for (let i = 0; i < 65; i++) writeFileSync(join(root, `part${i}.ts`), "export const value = 1;");
        expect(checkImportFromOwnBarrel(importingBarrel, join(root, "consumer.ts"))).toHaveLength(1);
    });
});

describe("conditional skip ownership", () => {
    it.each([
        ["test.skip(isUnavailable());", 0],
        ["test.skip(options[flag]);", 0],
        ["test.skip({ missing: true }, 'needs service');", 0],
        ["test.skip(true);", 1],
        ["test.skip(condition", 1],
        ["\n\ntest.skip('later', () => {});", 1],
    ])("classifies %s", (code, count) => {
        expect(findSkipMarkers(code, TEST)).toHaveLength(count);
    });

    it("ignores returns outside the skip's function, including later returns on the same line", () => {
        const before = "func setup() { return; }; func check() { t.Skip('later'); return; }";
        expect(findSkipMarkers(before, "suite_test.go")).toHaveLength(1);
        expect(findSkipMarkers("t.Skip('later')", "suite_test.go")).toHaveLength(1);
        expect(findSkipMarkers("func TestX(t *testing.T) { if ready { return }; t.Skip('later') }", "suite_test.go")).toEqual([]);
    });

    it("walks blank lines and indentation without inventing a Python guard", () => {
        expect(findSkipMarkers("class Cases:\n\n    @pytest.mark.skip(reason='later')", "test_x.py")).toHaveLength(1);
        expect(findSkipMarkers("    @pytest.mark.skip(reason='later')", "test_x.py")).toHaveLength(1);
        expect(findSkipMarkers("if condition:\n\n    @pytest.mark.skip(reason='later')", "test_x.py")).toEqual([]);
    });
});

describe("cross-language boundaries", () => {
    it("recognizes ORM class columns and exact suppression IDs without hiding ordinary equality", () => {
        expect(checkPyNoneEquality("query.where(cls.deleted_at == None)", "src/query.py")).toEqual([]);
        expect(checkPyNoneEquality("value == None # noqa: E711", "src/query.py")).toEqual([]);
        expect(checkPyNoneEquality("value == None # noqa: E501", "src/query.py")).toHaveLength(1);
        const doc = '"""escaped \\\" delimiter\nvalue == None\n"""\nvalue == None';
        expect(blankPythonTripleQuotedStrings(doc).split("\n").at(-1)).toBe("value == None");
        expect(blankPythonTripleQuotedStrings(doc).split("\n")[1]?.trim()).toBe("");
    });

    it("does not apply cookie checks to quoted sample calls", () => {
        expect(checkCookieMissingSecurityFlags('const example = `res.setHeader("Set-Cookie", "session=x")`;', TS)).toEqual([]);
        expect(checkCookieMissingSecurityFlags('res.setHeader("Set-Cookie", "session=x");', TS)).toHaveLength(1);
    });

    it("separates multiline lazy callbacks from an async function's own IO", () => {
        const code = "async function load() {\nawait fsp.readFile(path);\nconst lazy = () => (\nfs.readFileSync(path)\n)\n}";
        expect(checkMixedSyncAsyncFileApi(code, TS)).toEqual([]);
        expect(checkMixedSyncAsyncFileApi("async function load() { await fsp.readFile(path); const lazy = () => fs.readFileSync(path) }", TS)).toEqual([]);
        expect(checkMixedSyncAsyncFileApi("async function load() { await fsp.readFile(path); fs.readFileSync(path); }", TS)).toHaveLength(1);
    });

    it("handles incomplete Rust test attributes without exempting an unrelated item", () => {
        expect(checkMutexLockUnwrap("#[cfg(test)]", "src/lib.rs")).toEqual([]);
        expect(checkMutexLockUnwrap("#[cfg(test)] mod tests {\nlet lock: Mutex<u32> = make(); lock.lock().unwrap();", "src/lib.rs")).toEqual([]);
        expect(checkMutexLockUnwrap("#[cfg(test)] mod tests;\nfn work(lock: Mutex<u32>) { lock.lock().unwrap(); }", "src/lib.rs")).toHaveLength(1);
    });

    it("does not infer columns for a renamed table whose original schema is absent", () => {
        const code = "ALTER TABLE external RENAME TO renamed; CREATE INDEX bad ON renamed (missing);";
        expect(checkMigrationOrdering(code, "migrations/001.sql")).toEqual([]);
        expect(checkSqlSchemaConsistency("CREATE TABLE known (id INT); ALTER TABLE known ADD (CONSTRAINT pk PRIMARY KEY(id), name TEXT); INSERT INTO known (name) VALUES ('x');", "migrations/001.sql")).toEqual([]);
        expect(checkMigrationOrdering("CREATE TABLE known (id INT); ALTER TABLE known ADD COLUMN name TEXT", "migrations/001.sql")).toEqual([]);
    });

    it("does not resolve unknown aliases through missing or generic declarations", () => {
        expect(detectUnknownTypeAlias("type Input = Missing; type Data<T> = unknown; type Alias = Data;", TS).map(hit => hit.text)).toEqual([expect.stringContaining("'Data'")]);
        expect(detectUnknownTypeAlias(`${"\n".repeat(1500)}type Input = unknown;`, TS)).toEqual([]);
    });

    it("keeps unavailable workspace dependencies separate from the member's declarations", () => {
        const root = mkdtempSync(join(tmpdir(), "workspace-deps-")); roots.push(root);
        mkdirSync(join(root, "member"));
        writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: [member]\n");
        writeFileSync(join(root, "member", "package.json"), JSON.stringify({ dependencies: { declared: "1.0.0" } }));
        expect(checkExtraneousDependencies('import x from "declared";', join(root, "member", "main.ts"))).toEqual([]);
        expect(checkExtraneousDependencies('import x from "missing";', join(root, "member", "main.ts"))).toHaveLength(1);
    });

    it("checks publish scripts only for actual package roots and reports each missing reference once", () => {
        const root = mkdtempSync(join(tmpdir(), "publish-scripts-")); roots.push(root);
        const path = join(root, "package.json");
        writeFileSync(path, JSON.stringify({ scripts: { prepublishOnly: 42 } }));
        expect(checkPackageJsonPublishInvariants("{}", path)).toEqual([]);
        writeFileSync(join(root, "package-lock.json"), "{}");
        expect(checkPackageJsonPublishInvariants("{}", path)).toHaveLength(1);
        expect(checkPackageJsonScriptPaths(JSON.stringify({ scripts: { check: "node ./missing.js && node ./missing.js" } }), path)).toHaveLength(1);
    });
});
