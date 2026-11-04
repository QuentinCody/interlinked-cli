// ===========================================
// Built-in Rules — Supply Chain, Process Safety, Information Flow
// ===========================================
// Covers package.json lifecycle-script injection, .npmrc / .yarnrc manipulation,
// npm publish guards, fork bombs, nohup/disown background network,
// cron/systemd/launchd persistence, and clipboard exfiltration.

import type { GuardRule } from "../types.js";

/**
 * Public API — consumed by `rules/builtin-rules.ts` to assemble the full
 * BUILTIN_RULES array exported by `rules-loader.ts`.
 */
export const SECURITY_AND_SAFETY_RULES: GuardRule[] = [
	// ===========================================
	// Supply chain patterns (Feature 3)
	// ===========================================
	{
		id: "builtin-build-script-injection",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Write", "Edit", "WriteFile", "EditFile", "write_file", "edit_file"],
		action: "warn",
		patterns: [
			{
				field: "content",
				regex: '"(preinstall|postinstall|prepare|prepublish)"\\s*:\\s*"[^"]*\\b(curl|wget|nc|bash\\s+-c|eval|exec)\\b',
			},
			{
				field: "new_string",
				regex: '"(preinstall|postinstall|prepare|prepublish)"\\s*:\\s*"[^"]*\\b(curl|wget|nc|bash\\s+-c|eval|exec)\\b',
			},
		],
		reason: "Package lifecycle script contains network/exec commands (possible supply chain injection)",
		suggestion: "Review the lifecycle script carefully for malicious patterns",
		severity: "high",
		category: "supply-chain",
	},

	// ===========================================
	// Supply chain: config file manipulation
	// ===========================================
	{
		id: "builtin-npmrc-manipulation",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Write", "Edit", "WriteFile", "EditFile", "write_file", "edit_file"],
		action: "block",
		patterns: [
			{
				field: "file_path",
				regex: "(\\.npmrc|\\.yarnrc|\\.yarnrc\\.yml|\\.pnpmfile\\.cjs)$",
			},
		],
		reason: "Modifying package manager config can redirect dependency resolution to attacker-controlled registries (dependency confusion)",
		suggestion:
			"If you need to change registry settings, ask the user to edit the file manually",
		severity: "critical",
		category: "supply-chain",
	},
	{
		id: "builtin-npm-publish",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "warn",
		patterns: [
			{ field: "command", regex: "\\bnpm\\s+publish\\b" },
			{ field: "command", regex: "--dry-run", negate: true },
		],
		reason: "npm publish without --dry-run will publish to the registry. Accidental publishes can expose private code",
		suggestion:
			"Use npm publish --dry-run first to preview, then ask the user to confirm the real publish",
		severity: "high",
		category: "supply-chain",
	},

	// ===========================================
	// Information flow: scanner LOCAL-ONLY artifacts
	// ===========================================
	// Defense-in-depth on top of protected_files. `.interlinked/scanner/pending/`
	// holds raw flagged PII captured by the content scanner; the systemMessage /
	// redacted-reason design only works if the agent can't pull the content
	// back via a Bash/Grep/Glob side-channel. protected_files catches direct
	// Read/Write/Edit; this rule catches the long-tail tools that traffic in
	// arbitrary paths or commands.
	{
		id: "builtin-scanner-pending-access",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: [
			"Bash",
			"Shell",
			"run_command",
			"Grep",
			"grep",
			"Search",
			"Glob",
			"glob",
			"FileSearch",
		],
		action: "block",
		patterns: [
			// Bash command body — catches `cat .interlinked/scanner/pending/...`,
			// `head/tail/less/grep/jq/find/ls/rg .interlinked/scanner/pending/...`,
			// `xxd .interlinked/content-scanner.audit.jsonl`, etc. The regex
			// matches the path itself, so any tool that mentions it gets blocked
			// regardless of the program in front.
			{
				field: "command",
				regex: "\\.interlinked/(scanner/pending|content-scanner\\.audit)",
			},
			// Grep tool — `path` field tells the tool where to search.
			{
				field: "path",
				regex: "\\.interlinked/(scanner/pending|content-scanner\\.audit)",
			},
			// Glob tool — `pattern` field is the glob expression.
			{
				field: "pattern",
				regex: "\\.interlinked/(scanner/pending|content-scanner\\.audit)",
			},
		],
		reason:
			"BLOCKED: .interlinked/scanner/pending/ contains raw PII the privacy filter quarantined for the user only. Reading it through any tool would re-introduce the values into the model's context — that defeats the entire systemMessage design. Open the file in a separate terminal if you need to review.",
		suggestion:
			"If you genuinely need to inspect a pending file, open it in a non-agent terminal: `cat .interlinked/scanner/pending/<id>.json` from your shell directly.",
		severity: "critical",
		category: "Security",
	},

	// ===========================================
	// Process safety: persistence, background network, etc.
	// ===========================================
	// Note: the canonical fork-bomb rule (`builtin-fork-bomb`) lives in
	// `builtin-rules-resource-bombs.ts` (Plan 03 row 11). It used to live
	// here with a wider pattern set; the canonical-shape regex moved to the
	// resource-bomb family so the keyword-quick-reject layer can route it
	// into the always-evaluate set with `keywords: []`.
	{
		id: "builtin-nohup-network",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [
			{
				field: "command",
				regex: "\\bnohup\\b.*\\b(curl|wget|nc|netcat|python3?|node|ruby|perl)\\b.*&",
				flags: "i",
			},
			{
				field: "command",
				regex: "\\bdisown\\b.*\\b(curl|wget|nc|netcat|python3?|node|ruby|perl)\\b",
				flags: "i",
			},
		],
		reason: "Detached background process with network capability — this is a RAT persistence pattern (ref: axios@1.14.1 used nohup python3 dropper with ppid:1)",
		suggestion:
			"Run network commands in the foreground so their output is visible and they terminate with the session",
		severity: "critical",
		category: "process-safety",
	},
	{
		id: "builtin-background-network",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "warn",
		patterns: [
			{
				field: "command",
				regex: "\\b(curl|wget|nc|netcat|python3?|node|ruby|perl)\\b[^|;]*\\s+&\\s*$",
			},
		],
		reason: "Background process with network capability. Background network activity is rarely legitimate in an agent context",
		suggestion: "Run network commands in the foreground. If you need async work, explain why",
		severity: "high",
		category: "process-safety",
	},
	{
		// Red-team F2 (2026-08-09): measured ALLOWED before this rule existed.
		// This is the hole UNDER the supply-chain guard rather than beside it —
		// installs are default-deny across ten ecosystems, and a piped download
		// runs arbitrary remote code with no manifest, registry, allowlist entry
		// or version pin. `block`, not `warn`: an unreviewed remote payload is
		// the classic dropper stage, and the legitimate form (download, read,
		// then run) costs one extra step. Sinks are shells/interpreters only, so
		// `curl … | jq` and `| grep` stay untouched. The same pattern is mirrored
		// in the cold/inline path via dcgCheckRemoteExecution.
		id: "builtin-remote-code-execution",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [
			{
				field: "command",
				regex:
					"\\b(curl|wget|fetch)\\b[^|]*\\|\\s*(sudo\\s+)?((ba|z|k|da)?sh|(python3?|perl|ruby|node|php)(?!\\s+(-[a-zA-Z]+\\s+)*-[a-zA-Z]*[cerm]\\b))\\b",
			},
			{
				field: "command",
				regex:
					"\\b((ba|z|k|da)?sh|python3?|perl|ruby|node|php)\\b\\s*<\\(\\s*[^)]*\\b(curl|wget|fetch)\\b",
			},
		],
		reason:
			"Remote code execution: a download piped into a shell/interpreter runs unreviewed remote code and bypasses the package allowlist entirely (no manifest, no registry, no version pin)",
		suggestion:
			"Download to a file, read it, then run it deliberately; or install the dependency through its package manager so the supply-chain gate can screen it",
		severity: "critical",
		category: "supply-chain",
	},
	{
		id: "builtin-cron-persistence",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		// ASK, not block. Installing or reloading a launchd/cron job is ordinary
		// setup, and a hard block does not prevent it — it pushes the work outside
		// the harness, where it happens unobserved. Confirmation keeps the human in
		// the loop AND keeps the action on the record. The dropper signal was never
		// "a service was installed"; it is "a service was installed without the
		// user knowing", and an `ask` is exactly what removes that property.
		action: "ask",
		patterns: [
			{ field: "command", regex: "\\bcrontab\\s+(-e|-r|-)\\b" },
			{ field: "command", regex: "\\bsystemctl\\s+(enable|mask)\\b" },
			{ field: "command", regex: "\\blaunchctl\\s+(load|submit)\\b" },
		],
		reason: "Modifying scheduled tasks or system services creates persistent effects beyond this session",
		suggestion:
			"Confirm this is a service you intend to install or reload. Installing a launchd/cron job is normal setup; doing it unannounced is the dropper pattern.",
		severity: "critical",
		category: "process-safety",
	},
	{
		id: "builtin-cron-file-write",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Write", "Edit", "WriteFile", "EditFile", "write_file", "edit_file"],
		// ASK for the same reason as builtin-cron-persistence: writing a plist is
		// real persistence and must be visible, but it is also how every legitimate
		// agent job gets installed. Blocking it outright only relocated the work to
		// a terminal the harness cannot see.
		action: "ask",
		patterns: [
			{
				field: "file_path",
				regex: "(/etc/cron\\.d/|/etc/crontab|\\.service$|/LaunchAgents/|/LaunchDaemons/)",
			},
		],
		reason: "Writing to cron/systemd/launchd directories creates persistent scheduled tasks",
		suggestion:
			"Confirm you intend to install or update this service. State plainly what it runs, on what schedule, and how to remove it.",
		severity: "critical",
		category: "process-safety",
	},

	// ===========================================
	// Information flow: clipboard exfiltration
	// ===========================================
	{
		id: "builtin-clipboard-exfil",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "warn",
		patterns: [
			{ field: "command", regex: "\\|\\s*(pbcopy|xclip|xsel|clip\\.exe)\\b" },
			{ field: "command", regex: "\\b(pbcopy|xclip|xsel|clip\\.exe)\\b.*<" },
		],
		reason: "Piping data to clipboard — data leaves the terminal silently and may contain sensitive content",
		suggestion: "Print the output to the terminal instead so it's visible and reviewable",
		severity: "medium",
		category: "information-flow",
	},
];
