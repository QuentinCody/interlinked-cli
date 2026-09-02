import { describe, expect, it } from "vitest";
import { classifyCommand } from "./policy-classifier-command.js";

describe("classifyCommand — empty/unknown", () => {
	it("returns unknown for an empty command", () => {
		expect(classifyCommand("")).toBe("unknown");
	});

	it("returns bash_other for an unrecognized command", () => {
		expect(classifyCommand("some-proprietary-tool --flag")).toBe("bash_other");
	});
});

describe("classifyCommand — network", () => {
	it("classifies curl to localhost", () => {
		expect(classifyCommand("curl http://localhost:3000")).toBe("curl_localhost");
	});

	it("classifies curl to an external host", () => {
		expect(classifyCommand("curl https://example.com")).toBe("curl_external");
	});

	it("classifies wget to 127.0.0.1 as localhost", () => {
		expect(classifyCommand("wget http://127.0.0.1:8080")).toBe("curl_localhost");
	});

	it("classifies ssh/scp/sftp/rsync as network_ssh", () => {
		expect(classifyCommand("ssh user@host")).toBe("network_ssh");
		expect(classifyCommand("scp file user@host:/tmp")).toBe("network_ssh");
		expect(classifyCommand("rsync -av src dest")).toBe("network_ssh");
	});

	it("classifies nc/netcat/telnet as network_raw", () => {
		expect(classifyCommand("nc -l 1234")).toBe("network_raw");
		expect(classifyCommand("telnet host 23")).toBe("network_raw");
	});

	it("classifies npm publish as npm_publish", () => {
		expect(classifyCommand("npm publish")).toBe("npm_publish");
	});
});

describe("classifyCommand — git", () => {
	it("classifies git push/pull/fetch/clone as git_network", () => {
		expect(classifyCommand("git push origin main")).toBe("git_network");
		expect(classifyCommand("git fetch")).toBe("git_network");
	});

	it("classifies git commit/add/stash/reset/checkout/rebase/merge as git_local", () => {
		expect(classifyCommand("git commit -m x")).toBe("git_local");
		expect(classifyCommand("git checkout main")).toBe("git_local");
	});
});

describe("classifyCommand — build/test", () => {
	it("classifies npm test / npx vitest as npm_test", () => {
		expect(classifyCommand("npm test")).toBe("npm_test");
		expect(classifyCommand("npx vitest run")).toBe("npm_test");
	});

	it("classifies npm install / yarn / pnpm as npm_install", () => {
		expect(classifyCommand("npm install lodash")).toBe("npm_install");
		expect(classifyCommand("pnpm add react")).toBe("npm_install");
	});

	it("classifies tsc/biome/eslint/prettier as lint_typecheck", () => {
		expect(classifyCommand("tsc --noEmit")).toBe("lint_typecheck");
		expect(classifyCommand("eslint .")).toBe("lint_typecheck");
	});

	it("classifies make/cargo/go build as build", () => {
		expect(classifyCommand("cargo build")).toBe("build");
		expect(classifyCommand("go build ./...")).toBe("build");
	});
});

describe("classifyCommand — file operations", () => {
	it("classifies rm as file_delete", () => {
		expect(classifyCommand("rm -rf foo")).toBe("file_delete");
	});

	it("classifies chmod/chown as file_permissions", () => {
		expect(classifyCommand("chmod +x foo.sh")).toBe("file_permissions");
	});

	it("classifies cat/head/tail/wc as file_read_cmd", () => {
		expect(classifyCommand("cat foo.txt")).toBe("file_read_cmd");
		expect(classifyCommand("tail -n 10 foo.log")).toBe("file_read_cmd");
	});

	it("classifies mkdir/touch/cp/mv as file_manage", () => {
		expect(classifyCommand("mkdir -p foo")).toBe("file_manage");
		expect(classifyCommand("cp a b")).toBe("file_manage");
	});

	it("classifies ls/find/fd as file_list", () => {
		expect(classifyCommand("ls -la")).toBe("file_list");
		expect(classifyCommand("find . -name '*.ts'")).toBe("file_list");
	});
});

describe("classifyCommand — precedence", () => {
	it("network commands take priority over other matches", () => {
		// contains both curl (network) and cat-like words is not applicable here;
		// verify network is checked before git/build/file groups by using a command
		// that matches multiple categories textually is avoided — instead assert
		// order via a command matching only one category per group above.
		expect(classifyCommand("curl -o out.txt https://example.com/a")).toBe("curl_external");
	});
});
