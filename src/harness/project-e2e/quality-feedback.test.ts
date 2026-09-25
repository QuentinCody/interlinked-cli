// Unit E3: §12.3 test-quality signals as ADVICE attached to the edit that
// introduced them. Deterministic, net-new only (a moved line is not a new
// signal), never a verdict: the qualification gate stays CASE_NOT_RUN /
// boundary evidence, and these lines only explain what an edit weakened.
import { describe, expect, it } from "vitest";
import { editedTexts, formatQualityFindings, isTestFile, qualityFindings, type TestQualityFinding } from "./quality-feedback.js";

const rules = (findings: TestQualityFinding[]) => findings.map(row => row.rule);
const SPEC = "tests/orders.spec.ts";

describe("quality feedback — positive (must advise)", () => {
    it("P1: a removed expect, an added .only, a specific matcher replaced by truthiness and an added force:true each produce one advisory with the offending line", () => {
        const before = `test("creates", async ({ page }) => {\n  await page.click("#create");\n  await expect(page.locator("#result")).toHaveText("created 1: widget");\n  await expect(page.locator("#count")).toHaveText("1");\n});`;
        const after = `test.only("creates", async ({ page }) => {\n  await page.click("#create", { force: true });\n  expect(await page.locator("#result").textContent()).toBeTruthy();\n});`;
        const findings = qualityFindings({ path: SPEC, before, after });
        expect(rules(findings)).toEqual(["removed-assertion", "focus-or-skip", "truthiness-replacement", "force-option"]);
        expect(findings.find(row => row.rule === "focus-or-skip")).toMatchObject({ line: 1, evidence: 'test.only("creates", async ({ page }) => {' });
        expect(findings.find(row => row.rule === "removed-assertion")?.advice).toMatch(/preserve accepted behavior/i);
    });
    it("P2: an added timing wait, a raised retry/timeout budget, an intercepted application endpoint, a CSS locator and a test with no assertion are advised; a Write (no before) reports only additive signals", () => {
        const after = `test("lists", async ({ page }) => {\n  await page.route("**/api/orders", route => route.fulfill({ body: "[]" }));\n  await page.waitForTimeout(500);\n  await page.locator(".row > td").click();\n});\ntest.describe.configure({ retries: 3, timeout: 90000 });`;
        const findings = qualityFindings({ path: SPEC, before: null, after });
        expect(rules(findings)).toEqual(["timeout-or-retry", "timing-wait", "brittle-locator", "endpoint-mock", "no-observable-assertion"]);
        expect(rules(qualityFindings({ path: SPEC, before: "test.describe.configure({ retries: 1, timeout: 30000 });", after: "test.describe.configure({ retries: 3, timeout: 30000 });" }))).toEqual(["timeout-or-retry"]);
    });
    it("P3: editedTexts reads Edit (old/new), Write (content only) and MultiEdit (each pair) payloads; formatting attaches the scenario key, caps at three lines and names the path:line", () => {
        expect(editedTexts("Edit", { file_path: "/r/tests/a.spec.ts", old_string: "a", new_string: "b" })).toEqual([{ path: "/r/tests/a.spec.ts", before: "a", after: "b" }]);
        expect(editedTexts("Write", { file_path: "/r/tests/a.spec.ts", content: "b" })).toEqual([{ path: "/r/tests/a.spec.ts", before: null, after: "b" }]);
        expect(editedTexts("MultiEdit", { file_path: "/r/tests/a.spec.ts", edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "d" }] })).toHaveLength(2);
        const many: TestQualityFinding[] =["a", "b", "c", "d"].map((rule, index) => ({ rule, line: index + 1, evidence: rule, advice: `advice ${rule}` }));
        const lines = formatQualityFindings("tests/a.spec.ts", many, ["orders/order-via-page"]);
        expect(lines).toHaveLength(3);
        expect(lines[0]).toBe("[interlinked:e2e-quality] orders/order-via-page: a at tests/a.spec.ts:1 — advice a (advice only; the scenario still clears only through a supervised run)");
        expect(lines[2]).toMatch(/\+1 more signal/);
    });
});
describe("quality feedback — negative (must stay quiet)", () => {
    it("N1: a moved assertion, a consolidated assertion helper and an unchanged test produce nothing; a non-test file is never inspected", () => {
        const before = `test("a", () => {\n  expect(x).toBe(1);\n  expect(y).toBe(2);\n});\ntest("b", () => {\n  expect(z).toBe(3);\n});`;
        const moved = `test("b", () => {\n  expect(z).toBe(3);\n});\ntest("a", () => {\n  expect(y).toBe(2);\n  expect(x).toBe(1);\n});`;
        expect(qualityFindings({ path: SPEC, before, after: moved })).toEqual([]);
        expect(qualityFindings({ path: SPEC, before, after: before })).toEqual([]);
        expect(isTestFile("src/server.ts")).toBe(false);
        expect(qualityFindings({ path: "src/server.ts", before: "expect(1).toBe(1)", after: "" })).toEqual([]);
    });
    it("N2: a retry budget that stays or drops, an existing .only that was already there, and a non-application route (a third-party host) are not net-new signals", () => {
        expect(qualityFindings({ path: SPEC, before: "test.describe.configure({ retries: 3 });", after: "test.describe.configure({ retries: 2 });" })).toEqual([]);
        expect(qualityFindings({ path: SPEC, before: `test.only("a", () => {});`, after: `test.only("a", () => {});\nconst k = 1;` })).toEqual([]);
        expect(rules(qualityFindings({ path: SPEC, before: "", after: `await page.route("https://analytics.example.com/**", route => route.abort());` }))).toEqual([]);
    });
});
