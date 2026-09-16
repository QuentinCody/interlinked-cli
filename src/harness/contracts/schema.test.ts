import { describe, expect, it } from "vitest";
import { parseContractManifest, parseContractPolicy } from "./schema.js";
const sample = () => ({ id: "roundtrip", description: "Preserve supplied JSON", source: { kind: "example", path: "spec.md", sha256: "a".repeat(64), quote: "same JSON" }, inputs: ["main.py"], runner: { kind: "process", argv: ["python3", "main.py"] }, expect: { json: { value: "01" } } });
describe("portable contract schema", () => {
    it("retains exact expected data without scalar normalization", () => {
        const result = parseContractManifest(JSON.stringify({ version: 1, cases: [sample()] }));
        expect(result.cases[0]?.expect.json).toEqual({ value: "01" });
    });
    it("rejects unknown comparators, duplicate ids and empty expectations", () => {
        for (const cases of [[sample(), sample()], [{ ...sample(), expect: {} }], [{ ...sample(), expect: { files: {} } }], [{ ...sample(), expect: { normalize: true } }]]) expect(() => parseContractManifest(JSON.stringify({ version: 1, cases }))).toThrow();
    });
    it("requires bounded input and a real expectation source", () => {
        for (const changed of [{ inputs: Array(129).fill("main.py") }, { source: { ...sample().source, quote: "" } }, { runner: { kind: "shell", command: "true" } }]) expect(() => parseContractManifest(JSON.stringify({ version: 1, cases: [{ ...sample(), ...changed }] }))).toThrow();
    });
    it("limits HTTP checks to explicit loopback requests without redirects or credentials", () => {
        for (const url of ["https://example.com", "http://localhost", "http://x:y@127.0.0.1"]) expect(() => parseContractManifest(JSON.stringify({ version: 1, cases: [{ ...sample(), inputs: [], runner: { kind: "http", url, method: "GET" }, expect: { status: 200 } }] }))).toThrow();
    });
    it("cannot accept a case through a label instead of its digest", () => {
        expect(() => parseContractPolicy('{"version":1,"accepted":{"roundtrip":"approved"}}')).toThrow();
        expect(parseContractPolicy(JSON.stringify({ version: 1, accepted: { ["a".repeat(64)]: "Public API v1" } })).accepted).toHaveProperty("a".repeat(64));
    });
});
