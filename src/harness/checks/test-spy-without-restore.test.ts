import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkSpyWithoutRestore as check } from "./test-spy-without-restore.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const leaking = 'it("calls", () => { const spy = vi.spyOn(api, "send"); api.send(3); expect(spy).toHaveBeenCalledWith(3); });';

describe("spy restoration — positive (must fire)", () => {
    it("reports a leaking spy", () => {
        expect(check(leaking, "api.test.ts").map((finding) => finding.line)).toEqual([1]);
    });
    it.each([
        'const values: string[] = []; it("appends", () => { vi.spyOn(values, "push"); });',
        'describe("shared", () => { const values: string[] = []; it("appends", () => { vi.spyOn(values, "push"); }); });',
        'const shared: string[] = []; it("appends", () => { const values = shared; vi.spyOn(values, "push"); });',
        'const values: string[] = []; it("appends", () => { function unrelated() { const values: string[] = []; } vi.spyOn(values, "push"); });',
        'const shared: string[] = []; it("appends", () => { const { 0: values } = [shared]; vi.spyOn(values, "push"); });',
        'it("prototype", () => { vi.spyOn(Array.prototype, "push"); });',
    ])("still reports shared array methods: %s", (source) => {
        expect(check(source, "api.test.ts").map((finding) => finding.line)).toEqual([1]);
    });
    it.each(["clearAllMocks", "resetAllMocks"])("%s is insufficient", (method) => {
        expect(check(`${leaking}\nafterEach(() => vi.${method}());`, "api.test.ts")).toHaveLength(1);
    });
    it("does not borrow restoration from another test or sibling suite", () => {
        const source = `describe("leaks", () => { ${leaking} }); describe("cleans", () => { afterEach(() => vi.restoreAllMocks()); });`;
        expect(check(source, "api.test.ts")).toHaveLength(1);
        expect(check(`${leaking} it("other", () => { vi.restoreAllMocks(); });`, "api.test.ts")).toHaveLength(1);
    });
});

describe("spy restoration — negative (must not fire)", () => {
    it.each([
        'it("empty local array", () => { const values: string[] = []; const spy = vi.spyOn(values, "push"); expect(spy).not.toHaveBeenCalled(); });',
        'it("populated local array", () => { const values = ["first"]; const spy = jest.spyOn(values, "pop"); expect(values.pop()).toBe("first"); expect(spy).toHaveBeenCalledTimes(1); });',
    ])("exempts a fresh array created within its test: %s", (source) => {
        expect(check(source, "api.test.ts")).toEqual([]);
    });
    it.each([
        `${leaking} afterEach(() => vi.restoreAllMocks());`,
        `${leaking} beforeEach(() => vi.restoreAllMocks());`,
        'it("calls", () => { vi.spyOn(api, "send").mockImplementation(() => 3).mockRestore(); });',
        'it("calls", () => { vi.spyOn(api, "send"); vi.mocked(api.send).mockRestore(); });',
        'it("local", () => { const api = new Api(); vi.spyOn(api, "send"); api.send(); });',
        'it("local factory", () => { const { api } = makeFixture(); vi.spyOn(api, "send"); api.send(); });',
        'it("local member", () => { const session = createSession(); vi.spyOn(session.files, "add"); session.files.add("x"); });',
        'it("calls", () => { const spy = jest.spyOn(api, "send"); try { api.send(3); } finally { spy.mockRestore(); } });',
        'it("calls", () => { using spy = vi.spyOn(api, "send"); api.send(3); });',
        `describe.skip("off", () => { ${leaking} });`,
        'it("fixture", () => { const text = "vi.spyOn(api, \'send\')"; });',
        'describe("nested", () => { beforeEach(() => { spy = vi.spyOn(api, "send"); }); afterEach(() => spy.mockRestore()); });',
    ])("recognizes cleanup or nonexecuted source: %s", (source) => {
        expect(check(source, "api.test.ts")).toEqual([]);
    });
    it.each([
        ["vitest.config.ts", 'export default { test: { restoreMocks: true } };'],
        ["jest.config.cjs", 'module.exports = { restoreMocks: true };'],
        ["vitest.config.ts", 'export default { test: { setupFiles: ["./setup.ts"] } };'],
        ["jest.config.json", '{ "setupFilesAfterEnv": ["<rootDir>/setup.ts"] }'],
    ])("reads %s without executing it", (name, config) => {
        const directory = mkdtempSync(join(tmpdir(), "spy-restore-"));
        directories.push(directory);
        writeFileSync(join(directory, "package.json"), "{}");
        writeFileSync(join(directory, name), config);
        writeFileSync(join(directory, "setup.ts"), "afterEach(() => vi.restoreAllMocks());");
        expect(check(leaking, join(directory, "api.test.ts"))).toEqual([]);
    });
    it("does not cache stale configuration", () => {
        const directory = mkdtempSync(join(tmpdir(), "spy-restore-"));
        directories.push(directory);
        writeFileSync(join(directory, "package.json"), "{}");
        const path = join(directory, "vitest.config.ts");
        writeFileSync(path, "export default { test: { restoreMocks: true } };");
        expect(check(leaking, join(directory, "api.test.ts"))).toEqual([]);
        writeFileSync(path, "export default { test: { restoreMocks: false } };");
        expect(check(leaking, join(directory, "api.test.ts"))).toHaveLength(1);
    });
});
