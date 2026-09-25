// Suite parsing (extracted from policy.ts): managed-contracts, structured-runner
// and — Unit E2 — the playwright adapter, which must OWN the application its
// browser drives and always produces a Playwright JSON report.
import { describe, expect, it } from "vitest";
import { parseSuite } from "./policy-suites.js";

const SERVICE = { id: "app", argv: ["node", "dist/server.js", "--port", "{port}"], ready: { kind: "http", path: "/health", status: 200 } };

describe("parseSuite — positive (must parse)", () => {
    it("P1: a playwright suite defaults its run argv and report, keeps an explicit run/report, and binds the owned app", () => {
        const suite = parseSuite({ id: "ui", adapter: "playwright", prepare: [{ argv: ["node", "build.mjs"] }], artifacts: ["dist/**"], services: [SERVICE] }, "s");
        expect(suite).toMatchObject({ id: "ui", adapter: "playwright", run: { argv: ["npx", "playwright", "test"] }, report: { format: "playwright", path: "playwright-report.json" }, services: [{ id: "app" }] });
        const explicit = parseSuite({ id: "ui", adapter: "playwright", run: { argv: ["npx", "playwright", "test", "tests/orders.spec.ts"] }, report: { format: "playwright", path: "out/report.json" }, services: [SERVICE] }, "s");
        expect(explicit.run).toEqual({ argv: ["npx", "playwright", "test", "tests/orders.spec.ts"] });
        expect(explicit.report).toEqual({ format: "playwright", path: "out/report.json" });
    });
    it("P2: the two earlier adapters keep their contracts (structured needs run + report; managed-contracts may own services)", () => {
        expect(parseSuite({ id: "t", adapter: "structured-runner", run: { argv: ["pytest"] }, report: { format: "junit", path: "r.xml" } }, "s").report).toEqual({ format: "junit", path: "r.xml" });
        expect(parseSuite({ id: "api", adapter: "managed-contracts", services: [SERVICE] }, "s").services).toHaveLength(1);
    });
});
describe("parseSuite — negative (must refuse)", () => {
    it("N1: a playwright suite without an owned app, with a non-playwright report format, a structured suite binding services, and an unknown adapter are refused", () => {
        expect(() => parseSuite({ id: "ui", adapter: "playwright" }, "s")).toThrow(/s\.services: a playwright suite must OWN the application/);
        expect(() => parseSuite({ id: "ui", adapter: "playwright", report: { format: "json", path: "r.json" }, services: [SERVICE] }, "s")).toThrow(/s\.report\.format must be one of playwright/);
        expect(() => parseSuite({ id: "t", adapter: "structured-runner", run: { argv: ["pytest"] }, report: { format: "junit", path: "r.xml" }, services: [SERVICE] }, "s")).toThrow(/a structured-runner suite cannot bind them/);
        expect(() => parseSuite({ id: "t", adapter: "cypress" }, "s")).toThrow(/s\.adapter must be one of managed-contracts, structured-runner, playwright/);
        expect(() => parseSuite({ id: "api", adapter: "managed-contracts", run: { argv: ["x"] } }, "s")).toThrow(/run\/report belong to a structured-runner or playwright suite/);
    });
});
