import { describe, expect, it } from "vitest";
import { checkTlsVerifyDisabled } from "./agent-safety-crypto.js";

describe("TLS companion options belong to the same literal", () => {
	it.each([
		"const server = {requestCert: true}; const client = {rejectUnauthorized: false};",
		"const client = {rejectUnauthorized: false}; const server = {requestCert: true};",
		"const client = {rejectUnauthorized: false, unrelated: {requestCert: true}};",
		"const configs = {server: {requestCert: true}, client: {rejectUnauthorized: false}};",
	])("reports the insecure client in %s", (source) => {
		expect(checkTlsVerifyDisabled(source, "src/tls.ts")).toEqual([{ line: 1, text: source }]);
	});
	it("preserves same-literal server and custom verifier exemptions", () => {
		expect(checkTlsVerifyDisabled("const server = {rejectUnauthorized: false, requestCert: true};", "src/tls.ts")).toEqual([]);
		expect(checkTlsVerifyDisabled("cfg := &tls.Config{InsecureSkipVerify: true, VerifyConnection: verify}", "tls.go")).toEqual([]);
	});
});
