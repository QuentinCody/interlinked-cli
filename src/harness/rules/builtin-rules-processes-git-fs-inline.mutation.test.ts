// ===========================================
// builtin-rules-processes-git-fs-inline — mutation-hardening corpus
// ===========================================
//
// Companion to builtin-rules-processes-git-fs-inline.test.ts, which only pins the
// interactive-staging rule. This file states what the OTHER rules and the shared
// regex fragments are for. Every expectation comes from the module's own comments
// and reason text, from documented shell/git semantics (macOS runs CHMOD as chmod,
// `-r` is a chmod mode, `--staged` is index-only), or from a command whose danger
// is obvious — never from "whatever the regex returns today".
//
// KNOWN GAPS ARE NOT PINNED. The module itself names some (a bare `git clone <url>`
// and a quoted relative destination are "not caught"); the regexes also miss
// bundled short flags such as `git add -pf`. A future fix must stay free to close
// them, so no case below asserts that such a command is allowed.
//
// Each case runs ONE rule through the evaluator's real matcher (`matchesRule`), so
// the executed_only projection, flag handling and the `nonempty_file_group`
// filesystem predicate behave exactly as in the daemon.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { matchesRule, shouldEvaluateRule } from "../evaluator/rule-matching.js";
import type { GuardRule } from "../types.js";
import {
	PROCESS_RULES_GIT_FS_INLINE,
	PROCESS_RULES_SYSTEM_FS,
} from "./builtin-rules-processes-git-fs-inline.js";

const ALL_RULES: readonly GuardRule[] = [...PROCESS_RULES_SYSTEM_FS, ...PROCESS_RULES_GIT_FS_INLINE];

function ruleNamed(id: string): GuardRule {
	const rule = ALL_RULES.find(candidate => candidate.id === id);
	if (!rule) throw new Error(`Rule ${id} is missing from the process rule tables`);
	return rule;
}

function fires(ruleId: string, command: string, cwd?: string): boolean {
	return matchesRule({ command, toolInput: { command }, rule: ruleNamed(ruleId), cwd });
}

// ---------------------------------------------------------------------------
// Policy: which rules refuse, which ask, which warn once
// ---------------------------------------------------------------------------

describe("rule policy — what the guard does when a rule fires", () => {
	const REFUSING = [
		"builtin-sudo-rm",
		"builtin-chmod-777",
		"builtin-chmod-000",
		"builtin-chown-recursive",
		"builtin-shutdown-reboot",
		"builtin-lvm-removal",
		"builtin-dd-block-device",
		"builtin-disk-format",
		"builtin-inline-script-destruct",
		"builtin-bash-c-destruct",
		"builtin-shred",
		"builtin-wipefs",
		"builtin-file-truncate",
		"builtin-git-filter-branch",
		"builtin-git-restore-dot",
		"builtin-git-add-interactive",
	];

	it.each(REFUSING)("%s refuses the command outright instead of asking or warning", id => {
		expect(ruleNamed(id).action).toBe("block");
	});

	it.each(["builtin-git-commit-amend", "builtin-git-discard-file"])(
		"%s asks the user first, because legitimate uses exist (an unpushed amend, an intended discard)",
		id => {
			expect(ruleNamed(id).action).toBe("ask");
		},
	);

	it("builtin-git-clone-into-tree warns once and allows a deliberate retry", () => {
		expect(ruleNamed("builtin-git-clone-into-tree").action).toBe("soft_block");
	});
});

describe("rule activation — which tool calls a rule is evaluated for", () => {
	const ids = ALL_RULES.map(rule => rule.id);

	it.each(ids)("%s is enabled and evaluated before Bash, Shell and run_command calls", id => {
		for (const tool of ["Bash", "Shell", "run_command"]) {
			expect(shouldEvaluateRule(ruleNamed(id), "PreToolUse", tool)).toBe(true);
		}
	});

	it.each(ids)("%s is not evaluated after the tool ran, nor for file-editing tools", id => {
		const rule = ruleNamed(id);
		expect(shouldEvaluateRule(rule, "PostToolUse", "Bash")).toBe(false);
		expect(shouldEvaluateRule(rule, "PreToolUse", "Edit")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// builtin-sudo-rm
// ---------------------------------------------------------------------------

describe("builtin-sudo-rm", () => {
	const id = "builtin-sudo-rm";

	it.each(["sudo rm -rf build", "sudo   rm file.txt", "sudo\trm file.txt"])(
		"blocks a privileged rm however it is spaced: %j",
		command => {
			expect(fires(id, command)).toBe(true);
		},
	);

	it("names the rm command itself, so a different command that merely starts with rm (rmdir) is not blocked", () => {
		expect(fires(id, "sudo rmdir old-empty-dir")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// builtin-chmod-777
// ---------------------------------------------------------------------------

describe("builtin-chmod-777", () => {
	const id = "builtin-chmod-777";

	it.each(["chmod 777 deploy.sh", "chmod -R 777 build", "sudo chmod 777 /etc/hosts"])(
		"blocks the world-writable mode with or without -R: %j",
		command => {
			expect(fires(id, command)).toBe(true);
		},
	);

	it("allows an ordinary restrictive mode such as 755", () => {
		expect(fires(id, "chmod 755 deploy.sh")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// builtin-chmod-000 (and the fragments it shares with chown and truncate)
// ---------------------------------------------------------------------------

describe("builtin-chmod-000", () => {
	const id = "builtin-chmod-000";

	it.each([
		"chmod -R 000 /srv/data",
		"chmod --recursive 000 /srv/data",
		"chmod 000 -R /srv/data",
		"chmod -R 0000 /srv/data",
		"chmod -R a= /srv/data",
		"chmod -R ugo= /srv/data",
		"chmod -R a-rwx /srv/data",
		"chmod -R ugo-rwx /srv/data",
		"sudo chmod -R 000 /srv/data",
	])("blocks a recursive chmod that removes every permission bit: %j", command => {
		expect(fires(id, command)).toBe(true);
	});

	it.each(["CHMOD -R 000 /srv/data", "Chmod -R 000 /srv/data", "CHMOD 000 src/"])(
		"treats the verb case-insensitively because macOS runs CHMOD as chmod: %j",
		command => {
			expect(fires(id, command)).toBe(true);
		},
	);

	it("does not read a lower-case -r as the recursive flag, because -r is a chmod mode (remove read)", () => {
		expect(fires(id, "chmod -r 000 notes.txt")).toBe(false);
	});

	it.each([".", "..", "~", "/", "*", "$HOME", "${HOME}", "src/", "src/*", "src/."])(
		"blocks mode 000 on the directory-shaped target %s even without -R",
		target => {
			expect(fires(id, `chmod 000 ${target}`)).toBe(true);
		},
	);

	it("leaves a single named file free to become 000", () => {
		expect(fires(id, "chmod 000 secrets.txt")).toBe(false);
	});

	it("keeps a real operand blocked when a temp operand sits next to it", () => {
		expect(fires(id, "chmod -R 000 /tmp/x /srv/data")).toBe(true);
	});

	it.each(["chmod -R 000 $HOME", "chmod -R 000 ${HOME}/projects", "chmod -R 000 $HOME/projects"])(
		"treats $HOME and ${HOME} as the real home directory, so %j is blocked",
		command => {
			expect(fires(id, command)).toBe(true);
		},
	);

	it("never blocks on an operand whose value is unknown (led by a variable other than HOME)", () => {
		expect(fires(id, "chmod -R 000 $PROJECT_DIR")).toBe(false);
	});

	it.each([
		"/tmp/build",
		"/var/tmp/build",
		"/private/tmp/build",
		"/var/folders/ab/cd/T/build",
		"/private/var/folders/ab/cd/T/build",
		"$TMPDIR/build",
		"${TMPDIR}/build",
		"scratch/build",
		"./scratch/build",
		"~/proj/scratch/build",
		"/home/dev/scratch/build",
	])("does not block a recursive 000 under the scratch or temp location %s", target => {
		expect(fires(id, `chmod -R 000 ${target}`)).toBe(false);
	});

	it("treats a path under /dev/ as a device rather than a file, so it is not blocked either", () => {
		expect(fires(id, "chmod -R 000 /dev/null")).toBe(false);
	});

	it.each(["/tmp/x/", "scratch/out/"])(
		"does not block 000 on the scratch or temp directory %s",
		target => {
			expect(fires(id, `chmod 000 ${target}`)).toBe(false);
		},
	);

	it.each(["/tmp/../etc", "/tmp/a/../../etc", "scratch/../src"])(
		"a '..' segment voids the temp carve-out, so a recursive 000 on %s is still blocked",
		target => {
			expect(fires(id, `chmod -R 000 ${target}`)).toBe(true);
		},
	);

	it("ignores a quoted mention of the command because only executed text counts", () => {
		expect(fires(id, 'echo "chmod -R 000 /srv/data"')).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// builtin-chown-recursive
// ---------------------------------------------------------------------------

describe("builtin-chown-recursive", () => {
	const id = "builtin-chown-recursive";

	it.each([
		"chown -R alice /srv/data",
		"chown -R alice:staff /srv/data",
		"chown --recursive alice /srv/data",
		"chown -hR alice /srv/data",
		"chown alice -R /srv/data",
		"CHOWN -R alice /srv/data",
		"sudo chown -R alice /srv/data",
	])("blocks a recursive ownership change of a real tree: %j", command => {
		expect(fires(id, command)).toBe(true);
	});

	it("allows a non-recursive chown of one path", () => {
		expect(fires(id, "chown alice /srv/data")).toBe(false);
	});

	it.each(["/tmp/build", "/var/folders/ab/cd/T/build", "scratch/out", "$BUILD_DIR", "/dev/null"])(
		"reads the first operand as the owner, so a recursive chown into %s is not blocked",
		target => {
			expect(fires(id, `chown -R alice ${target}`)).toBe(false);
		},
	);

	it("a '..' segment voids the temp carve-out for chown too", () => {
		expect(fires(id, "chown -R alice /tmp/../etc")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// builtin-shutdown-reboot
// ---------------------------------------------------------------------------

describe("builtin-shutdown-reboot", () => {
	const id = "builtin-shutdown-reboot";

	it.each([
		"shutdown -h now",
		"reboot",
		"halt",
		"poweroff",
		"init 0",
		"init 6",
		"systemctl poweroff",
		"systemctl reboot",
		"systemctl halt",
	])("blocks the host-halting command %j", command => {
		expect(fires(id, command)).toBe(true);
	});

	it.each([
		"sudo reboot",
		"env A=1 sudo reboot",
		"command reboot",
		"exec reboot",
		"nohup shutdown -h now",
		"bash -c reboot",
		"sh -c reboot",
		'sudo bash -c "reboot"',
		"SHUTDOWN -h now",
		"Reboot",
	])("is not evaded by a wrapper, a shell -c, or letter case: %j", command => {
		expect(fires(id, command)).toBe(true);
	});

	it.each(["true && reboot", "false || reboot", "ls; reboot", "ls | reboot", "ls\nreboot"])(
		"blocks the command in any command position: %j",
		command => {
			expect(fires(id, command)).toBe(true);
		},
	);

	it.each([
		"cat ./shutdown.log",
		"cat shutdown.log",
		"echo Graceful shutdown stalled",
		"grep reboot /var/log/syslog",
		'rg "x|reboot" logs/',
		"rebootloader --help",
		'bash -c "echo shutdown stalled"',
		"systemctl restart nginx",
	])("does not mistake a mention of the word for the command: %j", command => {
		expect(fires(id, command)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Disk and volume destruction
// ---------------------------------------------------------------------------

describe("builtin-lvm-removal", () => {
	const id = "builtin-lvm-removal";

	it.each(["lvremove vg/lv", "vgremove vg0", "pvremove /dev/sdb", "LVREMOVE vg/lv", "sudo lvremove -f vg/lv"])(
		"blocks the LVM removal command %j",
		command => {
			expect(fires(id, command)).toBe(true);
		},
	);

	it.each(["lvdisplay", "lvs"])("allows the read-only LVM command %j", command => {
		expect(fires(id, command)).toBe(false);
	});
});

describe("builtin-dd-block-device", () => {
	const id = "builtin-dd-block-device";

	it.each(["dd if=img.iso of=/dev/sdb bs=4M", "dd of=/dev/sdb", "sudo dd if=x of=/dev/disk2"])(
		"blocks dd writing to a block device: %j",
		command => {
			expect(fires(id, command)).toBe(true);
		},
	);

	it.each(["dd if=/dev/sda of=backup.img", "dd if=/dev/urandom of=out.bin bs=1M count=1"])(
		"allows dd that only READS a device and writes a regular file: %j",
		command => {
			expect(fires(id, command)).toBe(false);
		},
	);
});

describe("builtin-disk-format", () => {
	const id = "builtin-disk-format";

	it.each([
		"mkfs -t ext4 /dev/sdb1",
		"fdisk /dev/sda",
		"sudo fdisk /dev/sda",
		"parted /dev/sda mklabel gpt",
		"gdisk /dev/sda",
		"echo hi;fdisk /dev/sda",
		"true&&parted /dev/sda",
	])("blocks the partitioning or formatting command %j wherever it starts a command", command => {
		expect(fires(id, command)).toBe(true);
	});
});

describe("builtin-shred and builtin-wipefs", () => {
	it.each([
		["builtin-shred", "shred -u secrets.txt"],
		["builtin-shred", "sudo shred /dev/sda"],
		["builtin-wipefs", "wipefs -a /dev/sdb"],
		["builtin-wipefs", "sudo wipefs /dev/sdb"],
	])("%s blocks %j", (id, command) => {
		expect(fires(id, command)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Embedded destructive commands
// ---------------------------------------------------------------------------

describe("builtin-inline-script-destruct", () => {
	const id = "builtin-inline-script-destruct";

	it.each([
		"python -c \"import os; os.remove('x')\"",
		"python3 -c \"import shutil; shutil.rmtree('d')\"",
		"node -e \"require('fs').unlink('x', () => {})\"",
		"node -e \"require('rimraf').sync('d')\"",
		"ruby -e \"File.unlink('x')\"",
		"perl -e \"unlink('x')\"",
	])("blocks an interpreter one-liner that deletes files: %j", command => {
		expect(fires(id, command)).toBe(true);
	});

	it.each(['python3 -c "print(1)"', "python3 cleanup.py"])(
		"allows an interpreter command with no destructive call: %j",
		command => {
			expect(fires(id, command)).toBe(false);
		},
	);
});

describe("builtin-bash-c-destruct", () => {
	const id = "builtin-bash-c-destruct";

	it.each([
		'bash -c "rm -rf build"',
		"bash -c 'killall node'",
		"bash -c 'pkill -f server'",
		"bash -c 'kill -9 123'",
		"bash -c 'kill $(pgrep node)'",
		"bash -c 'kill `pgrep node`'",
		"bash -c 'kill 123 456'",
	])("blocks a destructive command inside bash -c: %j", command => {
		expect(fires(id, command)).toBe(true);
	});

	it.each(["bash -c 'kill 123'", "bash -c 'ls -la'"])(
		"allows plain `kill <PID>` (the form the kill-signal rule recommends) and harmless scripts inside bash -c: %j",
		command => {
			expect(fires(id, command)).toBe(false);
		},
	);
});

// ---------------------------------------------------------------------------
// builtin-file-truncate
// ---------------------------------------------------------------------------

describe("builtin-file-truncate — command shapes (no filesystem consulted)", () => {
	const id = "builtin-file-truncate";

	it.each([
		"truncate -s 0 data.log",
		"truncate -s0 data.log",
		"truncate --size=0 data.log",
		"truncate -r /dev/null data.log",
		"truncate --reference=/dev/null data.log",
		": > data.log",
		"true > data.log",
		"cat /dev/null > data.log",
		"> data.log",
		"cp /dev/null data.log",
		"sudo : > data.log",
		"echo hi; : > data.log",
		"> logs/app",
	])("blocks the zero-byte truncation %j", command => {
		expect(fires(id, command)).toBe(true);
	});

	it.each(["truncate --help", "truncate --version"])(
		"allows %j because it exits before touching any file",
		command => {
			expect(fires(id, command)).toBe(false);
		},
	);

	it.each([
		": >> data.log",
		"make &> build.log",
		"npm test &> test.log",
		"python tool.py -p 'x' > out.log",
	])("does not treat an append or an ordinary redirection as a truncation: %j", command => {
		expect(fires(id, command)).toBe(false);
	});

	it("does not read a markdown '> quote' as a redirection (a bare > needs a path-shaped target)", () => {
		expect(fires(id, "> quote")).toBe(false);
	});

	it.each([
		"true > /dev/null",
		": > /dev/null",
		"truncate -s 0 /tmp/x.log",
		": > /tmp/x.log",
		": > scratch/x.log",
		": > $OUT/x.log",
	])("allows %j because a device, temp or scratch path is not a file worth protecting", command => {
		expect(fires(id, command)).toBe(false);
	});

	it.each(["truncate -s 0 /tmp/../etc/hosts", ": > /tmp/../etc/hosts"])(
		"a '..' segment voids the temp carve-out, so %j is blocked",
		command => {
			expect(fires(id, command)).toBe(true);
		},
	);
});

describe("builtin-file-truncate — only existing contents are worth protecting", () => {
	const id = "builtin-file-truncate";
	let dir: string;

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "fs-inline-truncate-"));
		writeFileSync(join(dir, "full.log"), "contents worth keeping\n");
		writeFileSync(join(dir, "empty.log"), "");
	});

	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const SHAPES: ReadonlyArray<[string, (file: string) => string]> = [
		["truncate -s 0", file => `truncate -s 0 ${file}`],
		[": >", file => `: > ${file}`],
		["true >", file => `true > ${file}`],
		["cat /dev/null >", file => `cat /dev/null > ${file}`],
		["a bare >", file => `> ${file}`],
		["cp /dev/null", file => `cp /dev/null ${file}`],
	];

	it.each(SHAPES)("%s refuses a file that has contents", (_label, command) => {
		expect(fires(id, command("full.log"), dir)).toBe(true);
	});

	it.each(SHAPES)("%s allows creating a file that does not exist yet", (_label, command) => {
		expect(fires(id, command("missing.log"), dir)).toBe(false);
	});

	it.each(SHAPES)("%s allows a file that is already empty", (_label, command) => {
		expect(fires(id, command("empty.log"), dir)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

describe("builtin-git-filter-branch", () => {
	it.each(["git filter-branch --tree-filter 'rm f' HEAD", "git filter-repo --path secrets/"])(
		"blocks the history rewrite %j",
		command => {
			expect(fires("builtin-git-filter-branch", command)).toBe(true);
		},
	);
});

describe("builtin-git-restore-dot", () => {
	const id = "builtin-git-restore-dot";

	it("blocks git restore . because it discards every unstaged change", () => {
		expect(fires(id, "git restore .")).toBe(true);
	});

	it.each(["git restore --staged src/a.ts", "git restore --staged ."])(
		"does not block %j because unstaging only touches the index",
		command => {
			expect(fires(id, command)).toBe(false);
		},
	);

	it("does not hard-block a single-file restore, which builtin-git-discard-file handles by asking", () => {
		expect(fires(id, "git restore src/a.ts")).toBe(false);
	});
});

describe("builtin-git-commit-amend", () => {
	const id = "builtin-git-commit-amend";

	it.each(["git commit --amend", "git commit --amend --no-edit", 'git commit -m "x" --amend', "GIT COMMIT --AMEND"])(
		"asks before rewriting the last commit: %j",
		command => {
			expect(fires(id, command)).toBe(true);
		},
	);

	it.each([
		'git commit -m "fix --amend bug"',
		"git commit -m x && git push --amend",
		"git commit -m x; git log --amend",
		"git commit -m x | cat --amend",
	])("stays inside one git commit invocation and ignores quoted text: %j", command => {
		expect(fires(id, command)).toBe(false);
	});
});

describe("builtin-git-discard-file", () => {
	const id = "builtin-git-discard-file";

	it.each(["git checkout -- src/a.ts", "git checkout HEAD -- src/a.ts", "git restore src/a.ts"])(
		"asks before discarding uncommitted changes to a file: %j",
		command => {
			expect(fires(id, command)).toBe(true);
		},
	);

	it.each(["git checkout -- .", "git restore ."])(
		"leaves the whole-tree dot form %j to the hard-blocking rules",
		command => {
			expect(fires(id, command)).toBe(false);
		},
	);

	it.each([
		"git restore --staged src/a.ts",
		"git restore -S src/a.ts",
		"git restore --worktree src/a.ts",
		"git restore -W src/a.ts",
	])("leaves %j alone: --staged/-S only touch the index and --worktree/-W belong to their own rule", command => {
		expect(fires(id, command)).toBe(false);
	});

	it("does not treat a branch switch as a discard", () => {
		expect(fires(id, "git checkout main")).toBe(false);
	});

	it("ignores a quoted mention of the command", () => {
		expect(fires(id, 'echo "git checkout -- src/a.ts"')).toBe(false);
	});
});

describe("builtin-git-clone-into-tree", () => {
	const id = "builtin-git-clone-into-tree";
	const url = "https://example.com/repo.git";

	it.each([`git clone ${url} ref`, `git clone ${url} ./ref`, `git clone --depth 1 ${url} ref`])(
		"warns when the clone lands inside the working tree: %j",
		command => {
			expect(fires(id, command)).toBe(true);
		},
	);

	it.each([`git clone ${url} /tmp/ref`, `git clone ${url} ~/ref`])(
		"allows a clone to an absolute or home destination: %j",
		command => {
			expect(fires(id, command)).toBe(false);
		},
	);

	it.each([
		`git clone ${url} /tmp/x --branch main`,
		`git clone ${url} /tmp/x --depth 1`,
		`git clone ${url} /tmp/x 2>&1`,
	])("does not mistake a trailing flag value or fd redirect for the destination: %j", command => {
		expect(fires(id, command)).toBe(false);
	});

	it("stays inside the clone's own segment, so a later command in a compound is not read as the destination", () => {
		expect(fires(id, `git clone ${url} /tmp/x && git -C /tmp/x rev-list --count HEAD`)).toBe(false);
	});
});

describe("builtin-git-add-interactive", () => {
	const id = "builtin-git-add-interactive";

	it.each(["GIT ADD -P", "Git Add --Patch"])("is not evaded by letter case: %j", command => {
		expect(fires(id, command)).toBe(true);
	});

	it.each(["git\\\r\nadd -p", "git add\\\r\n-p", "git add src/a.ts\\\r\n-p"])(
		"keeps protection across an escaped CRLF line continuation: %j",
		command => {
			expect(fires(id, command)).toBe(true);
		},
	);

	it.each(['echo "git add -p"', 'git commit -m "git add -p"'])(
		"ignores a quoted mention because only executed text counts: %j",
		command => {
			expect(fires(id, command)).toBe(false);
		},
	);

	it("does not read a pathspec after -- such as -prefix.txt as the -p flag", () => {
		expect(fires(id, "git add -- -prefix.txt")).toBe(false);
	});
});
