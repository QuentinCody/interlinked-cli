import { describe, expect, it } from "vitest";
import { classify } from "./audit-receipts-classify.mjs";

describe("classify — builtin-shutdown-reboot", () => {
	it("P1: treats a command-start shutdown as real", () => {
		expect(classify("builtin-shutdown-reboot", "sudo shutdown -h now")).toBe("real");
	});
	it("P2: treats a command-start reboot as real", () => {
		expect(classify("builtin-shutdown-reboot", "reboot")).toBe("real");
	});
	it("N1: treats a mention inside a commit message as text", () => {
		expect(classify("builtin-shutdown-reboot", 'git commit -m "handle shutdown"')).toBe("fp_in_text");
	});
	it("N2: treats a mid-command substring match as text", () => {
		expect(classify("builtin-shutdown-reboot", "node scripts/shutdown-helper.mjs")).toBe("fp_in_text");
	});
});

describe("classify — builtin-rm-rf-root", () => {
	it("P1: treats rm -rf / as real", () => {
		expect(classify("builtin-rm-rf-root", "rm -rf /etc")).toBe("real");
	});
	it("P2: treats a wildcard delete as real", () => {
		expect(classify("builtin-rm-rf-root", "sudo rm -rf *")).toBe("real");
	});
	it("N1: treats an echoed mention as text", () => {
		expect(classify("builtin-rm-rf-root", "echo rm -rf /")).toBe("fp_in_text");
	});
	it("N2: treats a path under /Users as a path FP", () => {
		expect(classify("builtin-rm-rf-root", "rm -rf /Users/x/tmpdir")).toBe("fp_path_under_users");
	});
});

describe("classify — builtin-drop-database", () => {
	it("P1: flags a non-text DROP for review", () => {
		expect(classify("builtin-drop-database", "psql -c 'DROP DATABASE app'")).toBe("needs_review");
	});
	it("N1: treats a grep for DROP as text", () => {
		expect(classify("builtin-drop-database", "grep DROP schema.sql")).toBe("fp_in_text");
	});
});

describe("classify — builtin-kubectl-delete-all", () => {
	it("P1: treats a command-start kubectl delete --all as real", () => {
		expect(classify("builtin-kubectl-delete-all", "kubectl delete --all pods")).toBe("real");
	});
	it("N1: treats an rg mention as text", () => {
		expect(classify("builtin-kubectl-delete-all", "rg 'kubectl delete --all'")).toBe("fp_in_text");
	});
	it("N2: treats a non-command-start match as text", () => {
		expect(classify("builtin-kubectl-delete-all", "sudo kubectl delete --all pods")).toBe("fp_in_text");
	});
});

describe("classify — builtin-chmod-777", () => {
	it("P1: treats chmod 777 as real", () => {
		expect(classify("builtin-chmod-777", "chmod 777 file")).toBe("real");
	});
	it("P2: treats sudo chmod 0777 as real", () => {
		expect(classify("builtin-chmod-777", "sudo chmod 0777 file")).toBe("real");
	});
	it("N1: treats a documented mention as text", () => {
		expect(classify("builtin-chmod-777", 'git commit -m "no chmod 777"')).toBe("fp_in_text");
	});
	it("N2: treats a mid-command match as text", () => {
		expect(classify("builtin-chmod-777", "bash -c 'chmod 777 f'")).toBe("fp_in_text");
	});
});

describe("classify — builtin-nohup-network", () => {
	it("P1: flags a real nohup command for review", () => {
		expect(classify("builtin-nohup-network", "nohup node server.js &")).toBe("needs_review");
	});
	it("N1: treats a command with no nohup as text", () => {
		expect(classify("builtin-nohup-network", "node server.js &")).toBe("fp_in_text");
	});
});

describe("classify — unverifiable rules", () => {
	it("P1: marks the injection scan unverified", () => {
		expect(classify("pretooluse-injection-scan", "/tmp/notes.md")).toBe("needs_review");
	});
	it("N1: marks an unknown rule unverified", () => {
		expect(classify("some-other-rule", "rm -rf /")).toBe("needs_review");
	});
});
