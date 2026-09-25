import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, digestOf, E2E_POLICY_PATH, expectationRevision, loadE2ePolicy, parseE2ePolicy, policyDigest } from "./policy.js";

import { minimalPolicy, type RawPolicy as Raw } from "./__tests__/policy-fixture.js";

const SHA = "a".repeat(64);
function expectationRow(extra: Raw = {}): Raw {
    const { lifecycle, revision, history, ...draftExtra } = extra;
    const draft = {
        id: "exp-1", projectId: "orders", scenarioIds: ["order-persists"], statement: "creating an order persists it", origin: "user-requirement" as const,
        sources: [{ kind: "requirement" as const, path: "REQ.md", sha256: SHA, quote: "orders persist" }], assumptions: [], questions: [],
        examples: { positive: ["add then read"], negative: [] }, contractIds: ["orders.create"], ...draftExtra,
    };
    // SAFETY (test): the spread keeps the draft shape the revision digest is computed over.
    return { ...draft, lifecycle: lifecycle ?? "proposed", revision: revision ?? expectationRevision(draft as never), history: history ?? [] };
}
// SAFETY (test helpers): minimalPolicy() builds exactly these nested shapes.
function proj(raw: Raw): Raw { return (raw.projects as Raw[])[0]!; }
function scen(raw: Raw): Raw { return (proj(raw).scenarios as Raw[])[0]!; }
function suite(raw: Raw): Raw { return (proj(raw).suites as Raw[])[0]!; }
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("parseE2ePolicy — positive (must parse)", () => {
    it("accepts the minimal version-1 policy and keeps declared fields", () => {
        const policy = parseE2ePolicy(JSON.stringify(minimalPolicy()));
        expect(policy.projects[0]?.scenarios[0]?.required).toBe(true);
        expect(policy.projects[0]?.suites[0]?.prepare?.[0]?.argv).toEqual(["node", "build.mjs"]);
        expect(policy.expectations).toEqual([]);
    });
    it("accepts expectations bound to a declared project and scenario, and closed placeholders in argv", () => {
        const raw = minimalPolicy();
        raw.expectations = [expectationRow()];
        suite(raw).prepare = [{ argv: ["node", "build.mjs", "{run-directory}"] }];
        scen(raw).expectationIds = ["exp-1"];
        const policy = parseE2ePolicy(JSON.stringify(raw));
        expect(policy.expectations[0]?.lifecycle).toBe("proposed");
        expect(policy.projects[0]?.scenarios[0]?.expectationIds).toEqual(["exp-1"]);
    });
});

describe("parseE2ePolicy — negative (must refuse)", () => {
    const cases: Array<[string, (raw: Raw) => void, RegExp]> = [
        ["unknown version", raw => { raw.version = 2; }, /unknown schema version/],
        ["unknown top-level key", raw => { raw.extra = 1; }, /unknown key "extra"/],
        ["mode typo", raw => { proj(raw).mode = "block"; }, /mode must be one of/],
        ["required typo", raw => { scen(raw).required = "yes"; }, /required must be/],
        ["escaping root", raw => { proj(raw).root = "../other"; }, /confined project-relative/],
        ["absolute glob", raw => { proj(raw).protectedInputs = ["/etc/**"]; }, /confined project-relative/],
        ["shell string instead of argv", raw => { suite(raw).prepare = ["npm run build"]; }, /must be an object/],
        ["unknown placeholder", raw => { suite(raw).prepare = [{ argv: ["node", "{port}"] }]; }, /unknown placeholder \{port\}/],
        ["unknown adapter", raw => { suite(raw).adapter = "vitest"; }, /adapter must be/],
        ["scenario names undeclared suite", raw => { scen(raw).suite = "http"; }, /not a declared suite/],
        ["empty contractIds", raw => { scen(raw).contractIds = []; }, /at least one portable contract/],
        ["duplicate scenario ids", raw => { proj(raw).scenarios = [scen(raw), scen(raw)]; }, /ids must be unique/],
        ["duplicate project ids", raw => { raw.projects = [proj(raw), proj(raw)]; }, /ids must be unique/],
        ["expectation for unknown project", raw => { raw.expectations = [expectationRow({ projectId: "ghost" })]; }, /not a declared project/],
        ["expectation for unknown scenario", raw => { raw.expectations = [expectationRow({ scenarioIds: ["ghost"] })]; }, /unknown scenario ghost/],
        ["scenario references unknown expectation", raw => { scen(raw).expectationIds = ["ghost"]; }, /unknown expectation ghost/],
        ["expectation with bad lifecycle", raw => { raw.expectations = [expectationRow({ lifecycle: "approved" })]; }, /lifecycle must be one of/],
        ["expectation with bad origin", raw => { raw.expectations = [expectationRow({ origin: "human" })]; }, /origin must be one of/],
        ["review claiming human authority", raw => { raw.expectations = [expectationRow({ history: [{ atMs: 1, action: "accept", revision: SHA, rationale: "ok", authority: "human" }] })]; }, /authority "configured"/],
        ["no projects", raw => { raw.projects = []; }, /1–64 projects/],
        ["http boundary without an owned service (R3, D1)", raw => { scen(raw).boundary = { entry: "http", real: ["application"] }; }, /boundary\.service needs an id/],
        ["http boundary naming a service the suite does not own (R3, D1)", raw => { scen(raw).boundary = { entry: "http", service: "api", real: ["application"] }; }, /"api" is not an owned service/],
        ["fixture-store on a process boundary (D1)", raw => { scen(raw).boundary = { entry: "process", real: ["application", "fixture-store"] }; }, /establishable only through an owned http service/],
        ["real component the adapter cannot establish (R3)", raw => { scen(raw).boundary = { entry: "process", real: ["application", "database"] }; }, /"database" cannot be established/],
        ["expectation whose stored revision does not match its content (R6)", raw => { raw.expectations = [expectationRow({ revision: SHA })]; }, /revision .* does not match the record's content/],
        ["gates.review outside require|advisory", raw => { proj(raw).gates = { review: "always" }; }, /review must be one of/],
    ];
    for (const [name, mutate, message] of cases) {
        it(`refuses ${name}`, () => {
            const raw = minimalPolicy();
            mutate(raw);
            expect(() => parseE2ePolicy(JSON.stringify(raw))).toThrow(message);
        });
    }
});

describe("digests and loading", () => {
    it("canonicalJson sorts keys so equal policies share a digest", () => {
        expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
        const a = parseE2ePolicy(JSON.stringify(minimalPolicy()));
        const b = parseE2ePolicy(JSON.stringify({ expectations: [], projects: minimalPolicy().projects, version: 1 }));
        expect(policyDigest(a)).toBe(policyDigest(b));
        expect(digestOf("x")).toHaveLength(64);
    });
    it("loadE2ePolicy reports unconfigured when the file is absent", () => {
        const root = mkdtempSync(join(tmpdir(), "e2e-policy-")); roots.push(root);
        expect(loadE2ePolicy(root).status).toBe("unconfigured");
    });
    it("loadE2ePolicy reports invalid with the parser reason", () => {
        const root = mkdtempSync(join(tmpdir(), "e2e-policy-")); roots.push(root);
        mkdirSync(join(root, ".interlinked"));
        writeFileSync(join(root, E2E_POLICY_PATH), "{\"version\":3}");
        expect(loadE2ePolicy(root)).toMatchObject({ status: "invalid", reason: expect.stringMatching(/unknown schema version/) });
    });
    it("loadE2ePolicy reports configured with a digest", () => {
        const root = mkdtempSync(join(tmpdir(), "e2e-policy-")); roots.push(root);
        mkdirSync(join(root, ".interlinked"));
        writeFileSync(join(root, E2E_POLICY_PATH), JSON.stringify(minimalPolicy()));
        expect(loadE2ePolicy(root)).toMatchObject({ status: "configured", digest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    });
});
