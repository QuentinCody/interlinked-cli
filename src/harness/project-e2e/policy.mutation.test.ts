import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    canonicalJson, digestOf, E2E_POLICY_PATH, expectationRevision, loadE2ePolicy, OBSERVABLE_KEYS, parseE2ePolicy, policyDigest,
    SUPPORTED_BOUNDARY_ENTRIES, SUPPORTED_REAL_COMPONENTS,
} from "./policy.js";
import { minimalPolicy, type RawPolicy as Raw } from "./__tests__/policy-fixture.js";

const SHA = "b".repeat(64);
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

// SAFETY (test helpers): minimalPolicy() builds exactly these nested shapes.
function proj(raw: Raw): Raw { return (raw.projects as Raw[])[0]!; }
function scen(raw: Raw): Raw { return (proj(raw).scenarios as Raw[])[0]!; }
function suite(raw: Raw): Raw { return (proj(raw).suites as Raw[])[0]!; }
function parse(raw: Raw) { return parseE2ePolicy(JSON.stringify(raw)); }
function refuse(mutate: (raw: Raw) => void, message: RegExp): void {
    const raw = minimalPolicy();
    mutate(raw);
    expect(() => parse(raw)).toThrow(message);
}
function accept(mutate: (raw: Raw) => void) {
    const raw = minimalPolicy();
    mutate(raw);
    return parse(raw);
}
const API = { id: "api", argv: ["node", "server.js", "{port}"], ready: { kind: "http", path: "/health", status: 200 } };
function withApi(raw: Raw, env?: Record<string, string>): void {
    suite(raw).services = [env ? { ...API, env } : API];
}
function httpScenario(raw: Raw, extra: Raw = {}): void {
    withApi(raw, { STORE: "{fixture-directory}" });
    scen(raw).boundary = { entry: "http", service: "api", real: ["application"], ...extra };
}
function browserScenario(raw: Raw, requests: unknown = [{ method: "POST", path: "/orders" }]): void {
    suite(raw).adapter = "playwright";
    delete suite(raw).prepare;
    delete suite(raw).artifacts;
    withApi(raw);
    scen(raw).caseIds = ["checkout"];
    scen(raw).boundary = { entry: "browser", service: "api", real: ["application"], requests };
}
function structuredSuite(raw: Raw): void {
    proj(raw).suites = [{ id: "native", adapter: "structured-runner", run: { argv: ["npm", "test"] }, report: { format: "json", path: "r.json" } }];
    scen(raw).suite = "native";
    delete scen(raw).boundary;
}
function twoContracts(raw: Raw): void { scen(raw).contractIds = ["orders.create", "orders.read"]; }
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
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("exported constants — fixed vocabulary", () => {
    it("pins the policy path and the supported vocabularies", () => {
        expect(E2E_POLICY_PATH).toBe(".interlinked/e2e-policy.json");
        expect([...SUPPORTED_BOUNDARY_ENTRIES]).toEqual(["process", "http", "browser"]);
        expect([...SUPPORTED_REAL_COMPONENTS]).toEqual(["application", "fixture-store"]);
        expect([...OBSERVABLE_KEYS]).toEqual(["files", "stdout", "stderr", "exitCode", "status", "json", "headers"]);
    });
});

describe("boundary parsing", () => {
    it("keeps an http boundary bound to its owned service and refuses an unknown entry kind", () => {
        const policy = accept(raw => httpScenario(raw, { allowedDoubles: ["clock"] }));
        expect(policy.projects[0]?.scenarios[0]?.boundary).toEqual({ entry: "http", service: "api", real: ["application"], allowedDoubles: ["clock"] });
        refuse(raw => { scen(raw).boundary = { entry: "ftp", real: ["application"] }; }, /boundary\.entry must be one of process, http, browser/);
    });
    it("refuses a process boundary that names a service", () => {
        refuse(raw => { withApi(raw); scen(raw).boundary = { entry: "process", service: "api", real: ["application"] }; }, /boundary\.service belongs to an http or browser boundary/);
    });
    it("lets fixture-store through only when SOME env value of the owned service binds {fixture-directory}", () => {
        const policy = accept(raw => { withApi(raw, { A: "plain", B: "{fixture-directory}/store" }); scen(raw).boundary = { entry: "http", service: "api", real: ["application", "fixture-store"] }; });
        expect(policy.projects[0]?.scenarios[0]?.boundary?.real).toEqual(["application", "fixture-store"]);
        refuse(raw => { withApi(raw, { A: "plain" }); scen(raw).boundary = { entry: "http", service: "api", real: ["fixture-store"] }; }, /needs service api to bind \{fixture-directory\}/);
        refuse(raw => { withApi(raw); scen(raw).boundary = { entry: "http", service: "api", real: ["fixture-store"] }; }, /needs service api to bind \{fixture-directory\}/);
    });
    it("does not demand a fixture-directory binding when fixture-store is not claimed", () => {
        const policy = accept(raw => { withApi(raw); scen(raw).boundary = { entry: "http", service: "api", real: ["application"] }; });
        expect(policy.projects[0]?.scenarios[0]?.boundary?.service).toBe("api");
    });
    it("rejects allowedDoubles that is not a list of non-empty strings and omits it when undeclared", () => {
        refuse(raw => { scen(raw).boundary = { entry: "process", real: ["application"], allowedDoubles: "clock" }; }, /allowedDoubles must be a list/);
        const policy = accept(() => undefined);
        expect(policy.projects[0]?.scenarios[0]?.boundary).toEqual({ entry: "process", real: ["application"] });
    });
    it("caps real components at 32", () => {
        refuse(raw => { scen(raw).boundary = { entry: "process", real: Array.from({ length: 33 }, () => "application") }; }, /real must be a list of at most 32/);
        accept(raw => { scen(raw).boundary = { entry: "process", real: Array.from({ length: 32 }, () => "application") }; });
    });
    it("rejects a boundary with an unknown key", () => {
        refuse(raw => { scen(raw).boundary = { entry: "process", real: ["application"], extra: 1 }; }, /boundary has unknown key "extra"/);
    });
});

describe("browser boundary requests", () => {
    it("keeps the required requests of a browser boundary", () => {
        const policy = accept(raw => browserScenario(raw, [{ method: "GET", path: "/orders/*" }, { method: "DELETE", path: "/orders/1" }]));
        expect(policy.projects[0]?.scenarios[0]?.boundary).toEqual({
            entry: "browser", service: "api", real: ["application"], requests: [{ method: "GET", path: "/orders/*" }, { method: "DELETE", path: "/orders/1" }],
        });
    });
    it("refuses a browser boundary with no requests, an empty list, or more than 32", () => {
        refuse(raw => browserScenario(raw, null), /requests must list 1–32 requests/);
        refuse(raw => browserScenario(raw, []), /requests must list 1–32 requests/);
        refuse(raw => browserScenario(raw, Array.from({ length: 33 }, () => ({ method: "GET", path: "/a" }))), /requests must list 1–32 requests/);
        accept(raw => browserScenario(raw, Array.from({ length: 32 }, () => ({ method: "GET", path: "/a" }))));
        accept(raw => browserScenario(raw, [{ method: "GET", path: "/a" }]));
    });
    it("refuses a request whose method is not an upper-case word of 3 to 10 letters", () => {
        for (const method of ["get", "GE", "ABCDEFGHIJK", "G3T", 5]) refuse(raw => browserScenario(raw, [{ method, path: "/a" }]), /method must be an upper-case HTTP method/);
        accept(raw => browserScenario(raw, [{ method: "ABCDEFGHIJ", path: "/a" }]));
        accept(raw => browserScenario(raw, [{ method: "GET", path: "/a" }]));
    });
    it("refuses a request path that is not absolute or exceeds 512 characters", () => {
        refuse(raw => browserScenario(raw, [{ method: "GET", path: "orders" }]), /path must start with "\/"/);
        refuse(raw => browserScenario(raw, [{ method: "GET", path: 7 }]), /path must start with "\/"/);
        refuse(raw => browserScenario(raw, [{ method: "GET", path: `/${"a".repeat(512)}` }]), /path must start with "\/"/);
        accept(raw => browserScenario(raw, [{ method: "GET", path: `/${"a".repeat(511)}` }]));
    });
    it("refuses an unknown key inside a request and requests on a non-browser boundary", () => {
        refuse(raw => browserScenario(raw, [{ method: "GET", path: "/a", body: "x" }]), /requests\[0\] has unknown key "body"/);
        refuse(raw => { scen(raw).boundary = { entry: "process", real: ["application"], requests: [{ method: "GET", path: "/a" }] }; }, /requests belongs to a browser boundary/);
    });
    it("requires a browser boundary to name an owned service", () => {
        refuse(raw => { browserScenario(raw); (scen(raw).boundary as Raw).service = "ghost"; }, /"ghost" is not an owned service of suite cli/);
    });
});

describe("native case selection", () => {
    it("refuses caseIds on a managed-contracts suite", () => {
        refuse(raw => { scen(raw).caseIds = ["x"]; }, /caseIds is only valid on a structured-runner or playwright suite/);
    });
    it("keeps declared native case ids on a structured-runner suite", () => {
        const policy = accept(raw => { structuredSuite(raw); scen(raw).caseIds = ["a", "b"]; });
        expect(policy.projects[0]?.scenarios[0]?.caseIds).toEqual(["a", "b"]);
        expect(policy.projects[0]?.suites[0]).toMatchObject({ adapter: "structured-runner", run: { argv: ["npm", "test"] }, report: { format: "json", path: "r.json" } });
    });
    it("refuses a structured-runner scenario with empty, missing, or duplicate caseIds", () => {
        refuse(raw => { structuredSuite(raw); scen(raw).caseIds = []; }, /must declare at least one native case id/);
        refuse(raw => { structuredSuite(raw); }, /caseIds must be a list/);
        refuse(raw => { structuredSuite(raw); scen(raw).caseIds = ["a", "a"]; }, /caseIds ids must be unique/);
    });
    it("refuses a boundary claim on a structured-runner suite", () => {
        refuse(raw => { structuredSuite(raw); scen(raw).caseIds = ["a"]; scen(raw).boundary = { entry: "process", real: ["application"] }; }, /boundary cannot be declared on a structured-runner suite/);
    });
    it("caps caseIds at 4096 entries", () => {
        refuse(raw => { structuredSuite(raw); scen(raw).caseIds = Array.from({ length: 4097 }, (_, i) => `c${i}`); }, /at most 4096/);
        accept(raw => { structuredSuite(raw); scen(raw).caseIds = Array.from({ length: 4096 }, (_, i) => `c${i}`); });
    });
});

describe("scenario fields", () => {
    it("keeps description, expectation ids and surface ids; coerces description to a string", () => {
        const policy = accept(raw => { scen(raw).description = 42; scen(raw).surfaceIds = ["cli:orders"]; });
        expect(policy.projects[0]?.scenarios[0]).toMatchObject({ description: "42", surfaceIds: ["cli:orders"], id: "order-persists", suite: "cli", required: true, contractIds: ["orders.create"], affects: ["src/**"] });
        expect(policy.projects[0]?.scenarios[0]?.expectationIds).toBeUndefined();
    });
    it("rejects an unknown scenario key and a non-boolean required value of any kind", () => {
        refuse(raw => { scen(raw).bogus = 1; }, /unknown key "bogus"/);
        for (const value of [undefined, 1, "true", null]) refuse(raw => { scen(raw).required = value; }, /required must be true or false/);
        expect(accept(raw => { scen(raw).required = false; }).projects[0]?.scenarios[0]?.required).toBe(false);
    });
    it("caps contractIds at 64 and surfaceIds at 256", () => {
        refuse(raw => { scen(raw).contractIds = Array.from({ length: 65 }, (_, i) => `c${i}`); }, /contractIds must be a list of at most 64/);
        accept(raw => { scen(raw).contractIds = Array.from({ length: 64 }, (_, i) => `c${i}`); });
        refuse(raw => { scen(raw).surfaceIds = Array.from({ length: 257 }, (_, i) => `s${i}`); }, /surfaceIds must be a list of at most 256/);
        accept(raw => { scen(raw).surfaceIds = Array.from({ length: 256 }, (_, i) => `s${i}`); });
    });
    it("caps expectationIds at 64", () => {
        refuse(raw => { scen(raw).expectationIds = Array.from({ length: 65 }, (_, i) => `e${i}`); }, /expectationIds must be a list of at most 64/);
    });
    it("parses a stability block with its default of three runs", () => {
        const policy = accept(raw => { scen(raw).stability = {}; });
        expect(policy.projects[0]?.scenarios[0]?.stability).toEqual({ qualificationRuns: 3 });
        expect(accept(raw => { scen(raw).stability = { qualificationRuns: 5, seed: "s1" }; }).projects[0]?.scenarios[0]?.stability).toEqual({ qualificationRuns: 5, seed: "s1" });
        refuse(raw => { scen(raw).stability = { qualificationRuns: 6 }; }, /qualificationRuns must be an integer from 1 to 5/);
    });
    it("requires the scenario suite id to be well formed and its affects to be globs", () => {
        refuse(raw => { scen(raw).suite = 5; }, /suite needs an id/);
        refuse(raw => { scen(raw).affects = ["../x"]; }, /confined project-relative/);
        refuse(raw => { scen(raw).id = "bad id"; }, /needs an id matching/);
    });
});

describe("proof modes", () => {
    const fault = { id: "f1", path: "src/a.js", find: "a", replace: "b", rationale: "breaks it" };
    it("accepts execution proof alone and refuses everything a mode does not use", () => {
        expect(accept(raw => { scen(raw).proof = { mode: "execution" }; }).projects[0]?.scenarios[0]?.proof).toEqual({ mode: "execution" });
        refuse(raw => { scen(raw).proof = { mode: "execution", designated: ["orders.create"] }; }, /designated is not used for mode execution/);
        refuse(raw => { scen(raw).proof = { mode: "execution", revision: "HEAD" }; }, /revision is not used for mode execution/);
        refuse(raw => { scen(raw).proof = { mode: "execution", fault }; }, /fault is not used for mode execution/);
        refuse(raw => { scen(raw).proof = { mode: "nope" }; }, /proof\.mode must be one of/);
        refuse(raw => { scen(raw).proof = { mode: "execution", extra: 1 }; }, /proof has unknown key "extra"/);
    });
    it("old-new needs a revision, no fault, and designated evidence", () => {
        const designated = [{ id: "orders.create", outcome: ["stdout"] }];
        const policy = accept(raw => { scen(raw).proof = { mode: "old-new", revision: "HEAD~1", designated }; });
        expect(policy.projects[0]?.scenarios[0]?.proof).toEqual({ mode: "old-new", revision: "HEAD~1", designated });
        refuse(raw => { scen(raw).proof = { mode: "old-new", designated }; }, /revision is required for mode old-new/);
        refuse(raw => { scen(raw).proof = { mode: "old-new", revision: "HEAD", fault, designated }; }, /fault is not used for mode old-new/);
        refuse(raw => { scen(raw).proof = { mode: "old-new", revision: "HEAD" }; }, /designated is required for mode old-new/);
        refuse(raw => { scen(raw).proof = { mode: "old-new", revision: "has space", designated }; }, /revision must be a git revision name/);
        refuse(raw => { scen(raw).proof = { mode: "old-new", revision: 5, designated }; }, /revision must be a string/);
        refuse(raw => { scen(raw).proof = { mode: "old-new", revision: "x".repeat(129), designated }; }, /revision must be a git revision name/);
        accept(raw => { scen(raw).proof = { mode: "old-new", revision: "x".repeat(128), designated }; });
    });
    it("controlled-fault needs a fault and no revision", () => {
        const designated = [{ id: "orders.create", action: ["orders.read"] }];
        const policy = accept(raw => { twoContracts(raw); scen(raw).proof = { mode: "controlled-fault", fault, designated }; });
        expect(policy.projects[0]?.scenarios[0]?.proof).toEqual({ mode: "controlled-fault", fault, designated });
        refuse(raw => { twoContracts(raw); scen(raw).proof = { mode: "controlled-fault", designated }; }, /fault is required for mode controlled-fault/);
        refuse(raw => { twoContracts(raw); scen(raw).proof = { mode: "controlled-fault", fault, revision: "HEAD", designated }; }, /revision is not used for mode controlled-fault/);
        refuse(raw => { twoContracts(raw); scen(raw).proof = { mode: "controlled-fault", fault }; }, /designated is required for mode controlled-fault/);
    });
    it("validates the fault record field by field", () => {
        const base = (extra: Raw) => (raw: Raw) => { scen(raw).proof = { mode: "controlled-fault", fault: { ...fault, ...extra }, designated: [{ id: "orders.create", outcome: ["stdout"] }] }; };
        expect(accept(base({ replace: "" })).projects[0]?.scenarios[0]?.proof?.fault?.replace).toBe("");
        refuse(base({ find: "" }), /fault\.find must be a non-empty string/);
        refuse(base({ find: "  " }), /fault\.find must be a non-empty string/);
        refuse(base({ rationale: " " }), /fault\.rationale must be a non-empty string/);
        refuse(base({ replace: 3 }), /fault\.replace must be a non-empty string/);
        refuse(base({ find: 3 }), /fault\.find must be a non-empty string/);
        refuse(base({ path: "../x" }), /confined project-relative/);
        refuse(base({ path: "/abs" }), /confined project-relative/);
        refuse(base({ extra: 1 }), /fault has unknown key "extra"/);
        refuse(base({ id: "bad id" }), /needs an id matching/);
        expect(accept(base({ path: "src\\a.js" })).projects[0]?.scenarios[0]?.proof?.fault?.path).toBe("src/a.js");
    });
    it("characterization takes a revision and optional plain designated ids, never an outcome or action", () => {
        expect(accept(raw => { scen(raw).proof = { mode: "characterization", revision: "v1" }; }).projects[0]?.scenarios[0]?.proof).toEqual({ mode: "characterization", revision: "v1" });
        expect(accept(raw => { scen(raw).proof = { mode: "characterization", revision: "v1", designated: ["orders.create"] }; }).projects[0]?.scenarios[0]?.proof?.designated).toEqual([{ id: "orders.create" }]);
        refuse(raw => { scen(raw).proof = { mode: "characterization" }; }, /revision is required for mode characterization/);
        refuse(raw => { scen(raw).proof = { mode: "characterization", revision: "v1", fault }; }, /fault is not used for mode characterization/);
        refuse(raw => { scen(raw).proof = { mode: "characterization", revision: "v1", designated: [{ id: "orders.create", outcome: ["stdout"] }] }; }, /outcome\/action are not used for mode characterization/);
        refuse(raw => { twoContracts(raw); scen(raw).proof = { mode: "characterization", revision: "v1", designated: [{ id: "orders.create", action: ["orders.read"] }] }; }, /outcome\/action are not used for mode characterization/);
    });
    it("a counterfactual designated case must declare outcome or action evidence", () => {
        refuse(raw => { scen(raw).proof = { mode: "old-new", revision: "HEAD", designated: ["orders.create"] }; }, /needs action evidence/);
        refuse(raw => { scen(raw).proof = { mode: "old-new", revision: "HEAD", designated: [{ id: "orders.create" }] }; }, /needs action evidence/);
        accept(raw => { twoContracts(raw); scen(raw).proof = { mode: "old-new", revision: "HEAD", designated: [{ id: "orders.create", action: ["orders.read"] }] }; });
    });
    it("validates designated outcome observables", () => {
        const make = (outcome: unknown) => (raw: Raw) => { scen(raw).proof = { mode: "old-new", revision: "HEAD", designated: [{ id: "orders.create", outcome }] }; };
        expect(accept(make(["exitCode", "stderr"])).projects[0]?.scenarios[0]?.proof?.designated).toEqual([{ id: "orders.create", outcome: ["exitCode", "stderr"] }]);
        refuse(make([]), /outcome must name at least one observable/);
        refuse(make(["stdout", "stdout"]), /outcome ids must be unique/);
        refuse(make(["bogus"]), /outcome must be one of files, stdout/);
        refuse(make("stdout"), /outcome must be a list/);
        refuse(make(Array.from({ length: 8 }, () => "stdout")), /at most 7/);
    });
    it("validates designated action cases", () => {
        const make = (action: unknown) => (raw: Raw) => { twoContracts(raw); scen(raw).proof = { mode: "old-new", revision: "HEAD", designated: [{ id: "orders.create", action }] }; };
        refuse(make([]), /action must name at least one case/);
        refuse(make(["orders.create"]), /"orders.create" must be another of the scenario's contractIds/);
        refuse(make(["ghost"]), /"ghost" must be another of the scenario's contractIds/);
        refuse(make(["orders.read", "orders.read"]), /action ids must be unique/);
        refuse(make("orders.read"), /action must be a list/);
        expect(accept(make(["orders.read"])).projects[0]?.scenarios[0]?.proof?.designated).toEqual([{ id: "orders.create", action: ["orders.read"] }]);
    });
    it("validates the designated list itself", () => {
        const make = (designated: unknown) => (raw: Raw) => { twoContracts(raw); scen(raw).proof = { mode: "old-new", revision: "HEAD", designated }; };
        refuse(make([]), /non-empty list of at most 64 designated cases/);
        refuse(make("orders.create"), /non-empty list of at most 64 designated cases/);
        refuse(make([{ id: "ghost", outcome: ["stdout"] }]), /"ghost" is not one of the scenario's contractIds/);
        refuse(make([{ id: "orders.create", outcome: ["stdout"] }, { id: "orders.create", action: ["orders.read"] }]), /designated ids must be unique/);
        refuse(make([{ id: "orders.create", outcome: ["stdout"], extra: 1 }]), /has unknown key "extra"/);
        refuse(make([42]), /must be an object/);
        refuse(make([{ outcome: ["stdout"] }]), /is not one of the scenario's contractIds/);
    });
});

describe("gates, surfaces and observations", () => {
    it("keeps every declared gate value and omits undeclared ones", () => {
        const policy = accept(raw => { proj(raw).gates = { stop: "off", commit: "warn", ci: "off", review: "require" }; });
        expect(policy.projects[0]?.gates).toEqual({ stop: "off", commit: "warn", ci: "off", review: "require" });
        expect(accept(raw => { proj(raw).gates = {}; }).projects[0]?.gates).toEqual({});
        expect(accept(raw => { proj(raw).gates = { stop: "warn", commit: "require", ci: "require", review: "advisory" }; }).projects[0]?.gates).toEqual({ stop: "warn", commit: "require", ci: "require", review: "advisory" });
        expect(accept(() => undefined).projects[0]?.gates).toBeUndefined();
    });
    it("refuses an out-of-vocabulary value for each gate and an unknown gate key", () => {
        refuse(raw => { proj(raw).gates = { stop: "require" }; }, /gates\.stop must be one of warn, off/);
        refuse(raw => { proj(raw).gates = { commit: "off2" }; }, /gates\.commit must be one of require, warn, off/);
        refuse(raw => { proj(raw).gates = { ci: "advisory" }; }, /gates\.ci must be one of require, warn, off/);
        refuse(raw => { proj(raw).gates = { review: "off" }; }, /gates\.review must be one of require, advisory/);
        refuse(raw => { proj(raw).gates = { other: "off" }; }, /gates has unknown key "other"/);
    });
    it("parses declared surfaces with optional method and description", () => {
        const surfaces = [{ id: "http:GET /orders/{id}", kind: "http", address: "/orders/{id}", method: "GET", description: "read" }, { id: "cli:orders", kind: "cli", address: "orders" }, { id: "o", kind: "other", address: "x" }];
        expect(accept(raw => { proj(raw).surfaces = surfaces; }).projects[0]?.surfaces).toEqual(surfaces);
        expect(accept(raw => { proj(raw).surfaces = []; }).projects[0]?.surfaces).toEqual([]);
    });
    it("refuses malformed surfaces", () => {
        const make = (extra: Raw) => (raw: Raw) => { proj(raw).surfaces = [{ id: "cli:a", kind: "cli", address: "a", ...extra }]; };
        refuse(make({ address: "" }), /address must be a non-empty string/);
        refuse(make({ address: "  " }), /address must be a non-empty string/);
        refuse(make({ address: 3 }), /address must be a non-empty string/);
        refuse(make({ id: " " }), /needs an id matching/);
        refuse(make({ id: "bad\u0000id" }), /needs an id matching/);
        refuse(make({ id: "x".repeat(201) }), /needs an id matching/);
        refuse(make({ id: 5 }), /needs an id matching/);
        accept(make({ id: "x".repeat(200) }));
        refuse(make({ kind: "grpc" }), /kind must be one of cli, http, other/);
        refuse(make({ method: "" }), /method must be a non-empty string/);
        refuse(make({ method: " " }), /method must be a non-empty string/);
        refuse(make({ method: 4 }), /method must be a non-empty string/);
        refuse(make({ extra: 1 }), /unknown key "extra"/);
        expect(accept(make({ description: 9 })).projects[0]?.surfaces?.[0]?.description).toBe("9");
    });
    it("refuses a surface list that is not a list, too long, or has duplicate ids", () => {
        refuse(raw => { proj(raw).surfaces = "cli"; }, /must be a list of at most 256 surface declarations/);
        refuse(raw => { proj(raw).surfaces = Array.from({ length: 257 }, (_, i) => ({ id: `s${i}`, kind: "cli", address: "a" })); }, /at most 256 surface declarations/);
        accept(raw => { proj(raw).surfaces = Array.from({ length: 256 }, (_, i) => ({ id: `s${i}`, kind: "cli", address: "a" })); });
        refuse(raw => { proj(raw).surfaces = [{ id: "s", kind: "cli", address: "a" }, { id: "s", kind: "cli", address: "b" }]; }, /surfaces ids must be unique/);
    });
    it("keeps each runtimeCoverage profile and refuses an unknown profile or key", () => {
        for (const runtimeCoverage of ["off", "node", "node-required"]) expect(accept(raw => { proj(raw).observations = { runtimeCoverage }; }).projects[0]?.observations).toEqual({ runtimeCoverage });
        refuse(raw => { proj(raw).observations = { runtimeCoverage: "v8" }; }, /runtimeCoverage must be one of off, node, node-required/);
        refuse(raw => { proj(raw).observations = { runtimeCoverage: "off", extra: 1 }; }, /observations has unknown key "extra"/);
        refuse(raw => { proj(raw).observations = "node"; }, /observations must be an object/);
    });
});

describe("project fields", () => {
    it("keeps root, manifest, shared inputs and mode, normalizing backslashes", () => {
        const policy = accept(raw => { Object.assign(proj(raw), { root: "apps\\web", contractManifest: "c\\m.json", sharedInputs: ["lib\\**"], mode: "advisory" }); });
        expect(policy.projects[0]).toMatchObject({ id: "orders", root: "apps/web", contractManifest: "c/m.json", sharedInputs: ["lib/**"], mode: "advisory", protectedInputs: ["src/**"] });
        const bare = accept(() => undefined).projects[0]!;
        expect(bare.root).toBe(".");
        expect(bare.contractManifest).toBeUndefined();
        expect(bare.sharedInputs).toBeUndefined();
        expect(bare.surfaces).toBeUndefined();
        expect(bare.observations).toBeUndefined();
    });
    it("refuses invalid manifest, shared inputs, root type and unknown project keys", () => {
        refuse(raw => { proj(raw).contractManifest = "../m.json"; }, /contractManifest must be a confined/);
        refuse(raw => { proj(raw).sharedInputs = ["/etc"]; }, /sharedInputs must be a confined/);
        refuse(raw => { proj(raw).root = 5; }, /root must be a string/);
        refuse(raw => { proj(raw).root = ""; }, /root must be a confined/);
        refuse(raw => { proj(raw).bogus = 1; }, /projects\[0\] has unknown key "bogus"/);
        refuse(raw => { proj(raw).id = "a/b"; }, /needs an id matching/);
    });
    it("needs suites and scenarios to be lists", () => {
        refuse(raw => { proj(raw).suites = {}; }, /needs suites and scenarios lists/);
        refuse(raw => { proj(raw).scenarios = "x"; }, /needs suites and scenarios lists/);
        refuse(raw => { delete proj(raw).suites; }, /needs suites and scenarios lists/);
    });
    it("refuses duplicate suite ids", () => {
        refuse(raw => { proj(raw).suites = [suite(raw), suite(raw)]; }, /suites ids must be unique/);
    });
    it("binds each scenario only to suites of its own project", () => {
        refuse(raw => {
            const other = { id: "other", root: "o", protectedInputs: ["src/**"], mode: "advisory", suites: [{ id: "second", adapter: "managed-contracts" }], scenarios: [{ id: "s", suite: "cli", affects: [], contractIds: ["c"], required: false }] };
            (raw.projects as Raw[]).push(other);
        }, /suite "cli" is not a declared suite/);
    });
    it("requires protectedInputs", () => {
        refuse(raw => { delete proj(raw).protectedInputs; }, /protectedInputs must be a list/);
    });
});

describe("expectation records", () => {
    const review = { atMs: 5, action: "accept", revision: SHA, rationale: "ok", authority: "configured" };
    const withExpectation = (extra: Raw = {}, scenario = true) => (raw: Raw) => { raw.expectations = [expectationRow(extra)]; if (scenario) scen(raw).expectationIds = ["exp-1"]; };
    it("round-trips every field of a fully populated expectation", () => {
        const sources = [{ kind: "regression", path: "docs/r.md", sha256: SHA, quote: "q" }];
        const row = expectationRow({ sources, assumptions: ["a1"], questions: ["q1"], examples: { positive: ["p"], negative: ["n"] }, lifecycle: "accepted", history: [review], origin: "approved-specification" });
        const policy = accept(raw => { raw.expectations = [row]; });
        expect(policy.expectations[0]).toEqual({
            id: "exp-1", projectId: "orders", scenarioIds: ["order-persists"], statement: "creating an order persists it", origin: "approved-specification",
            sources: [{ kind: "regression", path: "docs/r.md", sha256: SHA, quote: "q" }], assumptions: ["a1"], questions: ["q1"], examples: { positive: ["p"], negative: ["n"] },
            contractIds: ["orders.create"], lifecycle: "accepted", revision: row.revision, history: [review],
        });
    });
    it("accepts every lifecycle and every origin", () => {
        for (const lifecycle of ["proposed", "accepted", "disputed", "superseded"]) expect(accept(withExpectation({ lifecycle }, false)).expectations[0]?.lifecycle).toBe(lifecycle);
        for (const origin of ["user-requirement", "approved-specification", "regression-report", "existing-behavior", "agent-inference"]) expect(accept(withExpectation({ origin }, false)).expectations[0]?.origin).toBe(origin);
    });
    it("accepts every review action and source kind", () => {
        for (const action of ["propose", "accept", "dispute", "replace"]) expect(accept(withExpectation({ history: [{ ...review, action }] }, false)).expectations[0]?.history[0]?.action).toBe(action);
        for (const kind of ["requirement", "example", "regression", "conversation", "inferred"]) expect(accept(withExpectation({ sources: [{ kind, path: "R.md", sha256: SHA, quote: "q" }] }, false)).expectations[0]?.sources[0]?.kind).toBe(kind);
    });
    it("refuses a blank, missing or non-string statement", () => {
        for (const statement of ["", "   ", 5]) refuse(withExpectation({ statement }, false), /statement must be an observable statement/);
    });
    it("refuses a revision that is not a lowercase sha256 hex digest", () => {
        for (const revision of ["abc", "A".repeat(64), "g".repeat(64), "b".repeat(63), `${"b".repeat(64)}0`, 5]) refuse(withExpectation({ revision }, false), /revision must be a sha256 digest/);
    });
    it("refuses sources or history that are not lists", () => {
        refuse(withExpectation({ sources: "x" }, false), /needs sources and history lists/);
        refuse(withExpectation({ history: "x" }, false), /needs sources and history lists/);
    });
    it("refuses malformed source references", () => {
        const make = (extra: Raw) => withExpectation({ sources: [{ kind: "requirement", path: "R.md", sha256: SHA, quote: "q", ...extra }] }, false);
        refuse(make({ sha256: "abc" }), /needs a sha256 digest and a non-empty quote/);
        refuse(make({ sha256: "B".repeat(64) }), /needs a sha256 digest and a non-empty quote/);
        refuse(make({ sha256: "b".repeat(65) }), /needs a sha256 digest and a non-empty quote/);
        refuse(make({ sha256: 5 }), /needs a sha256 digest and a non-empty quote/);
        refuse(make({ quote: "  " }), /needs a sha256 digest and a non-empty quote/);
        refuse(make({ quote: 3 }), /needs a sha256 digest and a non-empty quote/);
        refuse(make({ kind: "hunch" }), /sources\[0\]\.kind must be one of/);
        refuse(make({ path: "../R.md" }), /sources\[0\]\.path must be a confined/);
        refuse(make({ extra: 1 }), /sources\[0\] has unknown key "extra"/);
    });
    it("refuses malformed review entries", () => {
        const make = (extra: Raw) => withExpectation({ history: [{ ...review, ...extra }] }, false);
        refuse(make({ atMs: 1.5 }), /needs atMs, revision and rationale/);
        refuse(make({ atMs: "1" }), /needs atMs, revision and rationale/);
        refuse(make({ revision: 5 }), /needs atMs, revision and rationale/);
        refuse(make({ rationale: "  " }), /needs atMs, revision and rationale/);
        refuse(make({ rationale: 5 }), /needs atMs, revision and rationale/);
        refuse(make({ action: "approve" }), /history\[0\]\.action must be one of/);
        refuse(make({ authority: undefined }), /needs authority "configured"/);
        refuse(make({ extra: 1 }), /history\[0\] has unknown key "extra"/);
    });
    it("refuses an unknown expectation key, bad examples and non-list fields", () => {
        refuse(withExpectation({ extra: 1 }, false), /expectations\[0\] has unknown key "extra"/);
        refuse(withExpectation({ examples: { positive: [], negative: [], other: [] } }, false), /examples has unknown key "other"/);
        refuse(withExpectation({ examples: [] }, false), /examples must be an object/);
        refuse(withExpectation({ assumptions: "x" }, false), /assumptions must be a list/);
        refuse(withExpectation({ questions: [""] }, false), /questions must be a list/);
        refuse(withExpectation({ scenarioIds: "x" }, false), /scenarioIds must be a list/);
        refuse(withExpectation({ contractIds: [5] }, false), /contractIds must be a list/);
    });
    it("caps scenarioIds and contractIds at 64 entries", () => {
        refuse(withExpectation({ scenarioIds: Array.from({ length: 65 }, () => "order-persists") }, false), /scenarioIds must be a list of at most 64/);
        refuse(withExpectation({ contractIds: Array.from({ length: 65 }, (_, i) => `c${i}`) }, false), /contractIds must be a list of at most 64/);
    });
    it("rejects duplicate expectation ids and a malformed supersededBy", () => {
        refuse(raw => { raw.expectations = [expectationRow(), expectationRow()]; }, /expectations ids must be unique/);
        refuse(raw => { raw.expectations = [{ ...expectationRow(), supersededBy: "bad id" }]; }, /supersededBy needs an id matching/);
    });
    it("resolves supersededBy against the declared expectations only", () => {
        const second = expectationRow({ id: "exp-2" });
        const policy = accept(raw => { raw.expectations = [{ ...expectationRow({ lifecycle: "superseded" }), supersededBy: "exp-2" }, second]; });
        expect(policy.expectations[0]?.supersededBy).toBe("exp-2");
        expect(policy.expectations[1]?.supersededBy).toBeUndefined();
        refuse(raw => { raw.expectations = [{ ...expectationRow({ lifecycle: "superseded" }), supersededBy: "ghost" }]; }, /expectation exp-1 is superseded by unknown ghost/);
    });
    it("accepts exactly 1024 expectations and refuses 1025 or a non-list", () => {
        const many = (n: number) => Array.from({ length: n }, (_, i) => expectationRow({ id: `exp-${i}` }));
        expect(accept(raw => { raw.expectations = many(1024); }).expectations).toHaveLength(1024);
        refuse(raw => { raw.expectations = Array.from({ length: 1025 }, () => ({})); }, /expectations must be a list of at most 1024 records/);
        refuse(raw => { raw.expectations = "x"; }, /expectations must be a list of at most 1024 records/);
        refuse(raw => { raw.expectations = {}; }, /expectations must be a list/);
        refuse(raw => { raw.expectations = null; }, /expectations must be a list of at most 1024 records/);
    });
    it("treats a missing expectations key as an empty list", () => {
        const raw = minimalPolicy();
        delete raw.expectations;
        expect(parse(raw).expectations).toEqual([]);
    });
    it("binds scenario references to expectations of the same project only", () => {
        const second = () => ({ id: "other", root: "o", protectedInputs: ["src/**"], mode: "advisory", suites: [{ id: "s2", adapter: "managed-contracts" }], scenarios: [{ id: "sc2", suite: "s2", affects: [], contractIds: ["c"], required: false, expectationIds: ["exp-1"] }] });
        expect(() => parse({ ...minimalPolicy(), projects: [...(minimalPolicy().projects as Raw[]), second()], expectations: [expectationRow()] })).toThrow(/scenario sc2 references expectation exp-1 from another project/);
    });
    it("refuses an expectation naming a scenario of a different project", () => {
        const other = { id: "other", root: "o", protectedInputs: ["src/**"], mode: "advisory", suites: [{ id: "s2", adapter: "managed-contracts" }], scenarios: [{ id: "sc2", suite: "s2", affects: [], contractIds: ["c"], required: false }] };
        expect(() => parse({ ...minimalPolicy(), projects: [...(minimalPolicy().projects as Raw[]), other], expectations: [expectationRow({ scenarioIds: ["sc2"] })] })).toThrow(/expectation exp-1 names unknown scenario sc2/);
    });
});

describe("expectationRevision — which fields move the digest", () => {
    const draft = () => {
        const { lifecycle, revision, history, ...rest } = expectationRow();
        void lifecycle; void revision; void history;
        return rest as unknown as Parameters<typeof expectationRevision>[0];
    };
    it("is a sha256 of the meaning-bearing fields", () => {
        const base = draft();
        expect(expectationRevision(base)).toMatch(/^[a-f0-9]{64}$/);
        expect(expectationRevision(base)).toBe(expectationRevision({ ...base }));
    });
    it("changes when any meaning-bearing field changes", () => {
        const base = draft();
        const baseline = expectationRevision(base);
        const variants: Array<Partial<typeof base>> = [
            { id: "exp-9" }, { projectId: "p2" }, { scenarioIds: ["x"] }, { statement: "different" }, { origin: "agent-inference" },
            { sources: [{ kind: "example", path: "R.md", sha256: SHA, quote: "q" }] }, { assumptions: ["a"] }, { questions: ["q"] },
            { examples: { positive: ["other"], negative: [] } }, { examples: { positive: ["add then read"], negative: ["n"] } }, { contractIds: ["z"] },
        ];
        for (const variant of variants) expect(expectationRevision({ ...base, ...variant })).not.toBe(baseline);
    });
    it("ignores lifecycle, history and supersession", () => {
        const base = draft();
        expect(expectationRevision({ ...base, lifecycle: "accepted", history: [{}], supersededBy: "x" } as never)).toBe(expectationRevision(base));
    });
    it("drops extra example keys so only positive and negative count", () => {
        const base = draft();
        expect(expectationRevision({ ...base, examples: { ...base.examples, stray: ["x"] } as never })).toBe(expectationRevision(base));
    });
});

describe("policy-level fields", () => {
    it("keeps top-level sharedInputs and omits them when undeclared", () => {
        expect(accept(raw => { raw.sharedInputs = ["lib\\**", "tsconfig.json"]; }).sharedInputs).toEqual(["lib/**", "tsconfig.json"]);
        expect(accept(() => undefined).sharedInputs).toBeUndefined();
        expect(accept(() => undefined).scheduling).toBeUndefined();
        refuse(raw => { raw.sharedInputs = ["../x"]; }, /sharedInputs must be a confined/);
    });
    it("limits a policy to 1 to 64 projects", () => {
        const many = (n: number) => Array.from({ length: n }, (_, i) => ({ ...proj(minimalPolicy()), id: `p${i}` }));
        expect(accept(raw => { raw.projects = many(64); }).projects).toHaveLength(64);
        refuse(raw => { raw.projects = many(65); }, /policy needs 1–64 projects/);
        refuse(raw => { raw.projects = "x"; }, /policy needs 1–64 projects/);
        refuse(raw => { delete raw.projects; }, /policy needs 1–64 projects/);
    });
    it("refuses a policy that is not a JSON object and a non-1 version of any type", () => {
        expect(() => parseE2ePolicy("[]")).toThrow(/policy must be an object/);
        expect(() => parseE2ePolicy("null")).toThrow(/policy must be an object/);
        expect(() => parseE2ePolicy("{not json")).toThrow();
        for (const version of ["1", 1.5, null, 0]) refuse(raw => { raw.version = version; }, /unknown schema version/);
        refuse(raw => { delete raw.version; }, /unknown schema version/);
    });
    it("measures the 1 MiB limit in bytes, not characters", () => {
        const limit = 1024 * 1024;
        const sized = (bytes: number) => {
            const raw = minimalPolicy();
            const text = JSON.stringify(raw);
            return text + " ".repeat(bytes - Buffer.byteLength(text));
        };
        expect(parseE2ePolicy(sized(limit)).version).toBe(1);
        expect(() => parseE2ePolicy(sized(limit + 1))).toThrow(/file exceeds 1 MiB/);
        // 600k two-byte characters: under 1 MiB as a string length, over it as bytes.
        const wide = JSON.stringify({ ...minimalPolicy(), pad: "é".repeat(600_000) });
        expect(wide.length).toBeLessThan(limit);
        expect(() => parseE2ePolicy(wide)).toThrow(/file exceeds 1 MiB/);
    });
});

describe("scheduling bounds", () => {
    const sched = (value: unknown) => (raw: Raw) => { raw.scheduling = value; };
    it("keeps each declared scheduling field and nothing else", () => {
        expect(accept(sched({})).scheduling).toEqual({});
        expect(accept(sched({ autoRun: false })).scheduling).toEqual({ autoRun: false });
        expect(accept(sched({ autoRun: true, quietMs: 5000, minIntervalMs: 20_000, budgetMs: 30_000 })).scheduling).toEqual({ autoRun: true, quietMs: 5000, minIntervalMs: 20_000, budgetMs: 30_000 });
    });
    it("accepts the inclusive bounds of each field and refuses one step outside", () => {
        const bounds: Array<[string, number, number]> = [["quietMs", 1_000, 60_000], ["minIntervalMs", 10_000, 3_600_000], ["budgetMs", 10_000, 600_000]];
        for (const [key, low, high] of bounds) {
            expect(accept(sched({ [key]: low })).scheduling).toEqual({ [key]: low });
            expect(accept(sched({ [key]: high })).scheduling).toEqual({ [key]: high });
            refuse(sched({ [key]: low - 1 }), new RegExp(`scheduling\\.${key} must be an integer from ${low} to ${high} ms`));
            refuse(sched({ [key]: high + 1 }), new RegExp(`scheduling\\.${key} must be an integer from ${low} to ${high} ms`));
            refuse(sched({ [key]: low + 0.5 }), new RegExp(`scheduling\\.${key} must be an integer`));
            refuse(sched({ [key]: String(low) }), new RegExp(`scheduling\\.${key} must be an integer`));
        }
    });
    it("refuses a non-boolean autoRun, unknown scheduling keys and a non-object block", () => {
        for (const autoRun of [1, "true", null]) refuse(sched({ autoRun }), /scheduling\.autoRun must be true or false/);
        refuse(sched({ extra: 1 }), /scheduling has unknown key "extra"/);
        refuse(sched([]), /scheduling must be an object/);
    });
});

describe("canonicalJson and digests", () => {
    it("serializes primitives, nesting and key order canonically", () => {
        expect(canonicalJson(null)).toBe("null");
        expect(canonicalJson("a\"b")).toBe('"a\\"b"');
        expect(canonicalJson(3)).toBe("3");
        expect(canonicalJson(true)).toBe("true");
        expect(canonicalJson([])).toBe("[]");
        expect(canonicalJson({})).toBe("{}");
        expect(canonicalJson([3, [1, 2], { b: null, a: [] }])).toBe('[3,[1,2],{"a":[],"b":null}]');
        expect(canonicalJson({ z: 1, a: { y: 2, b: 1 } })).toBe('{"a":{"b":1,"y":2},"z":1}');
        expect(canonicalJson({ 'k"ey': 1 })).toBe('{"k\\"ey":1}');
    });
    it("digestOf hashes strings and Buffers by their bytes and other values by canonical JSON", () => {
        expect(digestOf("x")).toBe(sha256("x"));
        expect(digestOf("")).toBe(sha256(""));
        expect(digestOf(Buffer.from("x"))).toBe(sha256("x"));
        expect(digestOf(Buffer.from([0xff, 0x00]))).toBe(createHash("sha256").update(Buffer.from([0xff, 0x00])).digest("hex"));
        expect(digestOf({ b: 1, a: 2 })).toBe(sha256('{"a":2,"b":1}'));
        expect(digestOf({ a: 2, b: 1 })).toBe(digestOf({ b: 1, a: 2 }));
        expect(digestOf(["x"])).toBe(sha256('["x"]'));
        expect(digestOf(7)).toBe(sha256("7"));
        expect(digestOf("x")).not.toBe(digestOf(["x"]));
    });
    it("policyDigest is the canonical-JSON digest of the parsed policy and moves with content", () => {
        const policy = accept(() => undefined);
        expect(policyDigest(policy)).toBe(sha256(canonicalJson(policy)));
        expect(policyDigest(accept(raw => { proj(raw).mode = "advisory"; }))).not.toBe(policyDigest(policy));
    });
});

describe("loadE2ePolicy", () => {
    function rootWith(content?: string): string {
        const root = mkdtempSync(join(tmpdir(), "e2e-policy-mut-"));
        roots.push(root);
        if (content !== undefined) { mkdirSync(join(root, ".interlinked")); writeFileSync(join(root, E2E_POLICY_PATH), content); }
        return root;
    }
    it("reports unconfigured with the path that was looked for", () => {
        const root = rootWith();
        expect(loadE2ePolicy(root)).toEqual({ status: "unconfigured", path: join(root, E2E_POLICY_PATH) });
    });
    it("reports configured with the parsed policy, its digest and its path", () => {
        const root = rootWith(JSON.stringify(minimalPolicy()));
        const loaded = loadE2ePolicy(root);
        expect(loaded.status).toBe("configured");
        if (loaded.status !== "configured") return;
        expect(loaded.path).toBe(join(root, E2E_POLICY_PATH));
        expect(loaded.policy.projects[0]?.id).toBe("orders");
        expect(loaded.digest).toBe(policyDigest(loaded.policy));
    });
    it("reports invalid for malformed JSON with the parse error text and for refusals with the field", () => {
        const bad = loadE2ePolicy(rootWith("{not json"));
        expect(bad).toMatchObject({ status: "invalid" });
        expect((bad as { reason: string }).reason.length).toBeGreaterThan(0);
        expect((bad as { reason: string }).reason).not.toMatch(/^e2e policy:/);
        const root = rootWith(JSON.stringify({ ...minimalPolicy(), extra: 1 }));
        expect(loadE2ePolicy(root)).toEqual({ status: "invalid", path: join(root, E2E_POLICY_PATH), reason: 'e2e policy: policy has unknown key "extra"' });
    });
});
