import type { ContractCase, ContractManifest, ContractPolicy } from "./types.js";
function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a contract object");
    return value as Record<string, unknown>;
}
function strings(value: unknown): value is string[] {
    return Array.isArray(value) && value.every(item => typeof item === "string" && !item.includes("\0"));
}
function stringMap(value: unknown, nonempty = false): void {
    if (nonempty && !Object.keys(object(value)).length) throw new Error("Empty map is not an observation");
    if (!Object.values(object(value)).every(item => typeof item === "string")) throw new Error("Expected string values");
}
function validateHttp(value: Record<string, unknown>): void {
    if (typeof value.url !== "string" || !["GET", "POST"].includes(String(value.method)) || (value.body !== undefined && typeof value.body !== "string")) throw new Error("Invalid HTTP runner");
    const url = new URL(value.url);
    if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password) throw new Error("HTTP contracts require a literal loopback http URL without credentials");
}
function validateRunner(value: Record<string, unknown>, expect: Record<string, unknown>, inputs: string[]): void {
    if (value.kind === "process") {
        if (!strings(value.argv) || !value.argv.length || !value.argv[0] || value.argv.length > 128) throw new Error("Process needs bounded argv");
        if (expect.status !== undefined || expect.headers !== undefined) throw new Error("HTTP expectations require an HTTP runner");
        return;
    }
    if (value.kind !== "http") throw new Error("Unsupported contract runner; use process or http");
    validateHttp(value);
    if (inputs.length || expect.files !== undefined || expect.exitCode !== undefined || expect.stderr !== undefined) throw new Error("HTTP contracts cannot claim process/filesystem observations");
}
function validateExpectation(expect: Record<string, unknown>): void {
    if (!Object.keys(expect).length || Object.keys(expect).some(key => !["exitCode", "stdout", "stderr", "json", "status", "headers", "files"].includes(key))) throw new Error("Missing or unsupported observation comparator");
    for (const key of ["stdout", "stderr"]) if (expect[key] !== undefined && typeof expect[key] !== "string") throw new Error(`Invalid ${key}`);
    for (const key of ["exitCode", "status"]) if (expect[key] !== undefined && !Number.isInteger(expect[key])) throw new Error(`Invalid ${key}`);
    for (const key of ["files", "headers"]) if (expect[key] !== undefined) stringMap(expect[key], true);
}
function validateSource(source: Record<string, unknown>): void {
    if (source.observation !== undefined && !["json", "stdout", "contract-example"].includes(String(source.observation))) throw new Error("Unsupported source observation");
    if (!["requirement", "example", "regression", "inferred"].includes(String(source.kind)) || typeof source.path !== "string" || typeof source.quote !== "string" || !source.quote.trim() || typeof source.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(source.sha256)) throw new Error("Invalid source provenance");
}
function validateCase(value: unknown): ContractCase {
    const row = object(value), expect = object(row.expect);
    if (typeof row.id !== "string" || !/^[a-zA-Z0-9_.-]{1,100}$/.test(row.id) || typeof row.description !== "string") throw new Error("Contract needs an id and description");
    validateSource(object(row.source));
    if (!strings(row.inputs) || row.inputs.length > 128 || new Set(row.inputs).size !== row.inputs.length) throw new Error("Contract inputs need at most 128 distinct literal paths");
    validateRunner(object(row.runner), expect, row.inputs);
    validateExpectation(expect);
    if (row.replaces !== undefined) {
        const replacement = object(row.replaces);
        if (typeof replacement.id !== "string" || typeof replacement.reason !== "string" || !replacement.reason.trim()) throw new Error("Replacement needs an id and rationale");
    }
    return value as ContractCase;
}
export function parseContractManifest(content: string): ContractManifest {
    const value = object(JSON.parse(content));
    if (value.version !== 1 || !Array.isArray(value.cases) || value.cases.length > 64) throw new Error("Expected version 1 and at most 64 contract cases");
    const cases = value.cases.map(validateCase);
    if (new Set(cases.map(row => row.id)).size !== cases.length) throw new Error("Duplicate contract case id");
    return { version: 1, cases };
}
export function parseContractPolicy(content: string): ContractPolicy {
    const value = object(JSON.parse(content));
    if (value.version !== 1) throw new Error("Unsupported contract policy version");
    stringMap(value.accepted);
    if (Object.entries(object(value.accepted)).some(([digest, reason]) => !/^[a-f0-9]{64}$/.test(digest) || !String(reason).trim())) throw new Error("Acceptance requires case digest and rationale");
    // SAFETY: stringMap and the digest/rationale checks validate every entry above.
    return { version: 1, accepted: value.accepted as Record<string, string> };
}
