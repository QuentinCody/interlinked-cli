// ===========================================
// `interlinked sponsor` — opt-in sponsor slot management
// ===========================================
// Spec: docs/design/sponsor-slots.md. The command owns config + the
// spinner-verb surface; the daemon (src/harness/sponsor/runtime.ts) owns
// fetching, rotation, the statusline row, and telemetry. Free-sponsor
// phase: no accounts, no payments — an anonymous install id is the only
// identity, and only when telemetry stays enabled.

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	clearSponsorStatus,
	DEFAULT_FEED_URL,
	fetchFeedWire,
	SPONSOR_STATUS_FILE,
	selectCreative,
	verifyWire,
} from "../harness/sponsor/feed-client.js";
import { readLocalConfig, type SponsorConfig, updateLocalConfig } from "../lib/config.js";
import { c } from "../lib/formatter.js";
import { addSponsorSpinnerVerb, removeSponsorSpinnerVerbs } from "../lib/sponsor-spinner.js";

interface SponsorCmdDeps {
	/** Project root (defaults to process.cwd()). */
	cwd?: string;
	/** ~/.claude/settings.json override for tests. */
	claudeSettingsPath?: string;
	fetchImpl?: typeof fetch;
}

interface SponsorEnableOpts {
	spinner?: boolean;
	feedUrl?: string;
	json?: boolean;
}

interface SponsorJsonOpts {
	json?: boolean;
}

function resolveDeps(deps: SponsorCmdDeps): Required<SponsorCmdDeps> {
	return {
		cwd: deps.cwd ?? process.cwd(),
		claudeSettingsPath:
			deps.claudeSettingsPath ?? join(homedir(), ".claude", "settings.json"),
		fetchImpl: deps.fetchImpl ?? fetch,
	};
}

function interlinkedDir(cwd: string): string {
	return join(cwd, ".interlinked");
}

/** `interlinked sponsor enable [--spinner] [--feed-url <url>]` */
export async function sponsorEnableAction(
	opts: SponsorEnableOpts,
	deps: SponsorCmdDeps = {},
): Promise<number> {
	const { cwd, claudeSettingsPath, fetchImpl } = resolveDeps(deps);
	if (!existsSync(interlinkedDir(cwd))) {
		console.error(
			c.red("No .interlinked/ here — run `interlinked enable` first, then opt in."),
		);
		return 1;
	}
	const existing = readLocalConfig(cwd) ?? {};
	const installId = existing.install_id ?? randomUUID();
	const prior: SponsorConfig = existing.sponsor ?? {};
	const sponsor: SponsorConfig = {
		...prior,
		enabled: true,
		telemetry: prior.telemetry ?? true,
	};
	if (opts.feedUrl) sponsor.feed_url = opts.feedUrl;

	if (opts.spinner) {
		await applySpinnerOptIn(sponsor, claudeSettingsPath, fetchImpl);
	}

	updateLocalConfig({ install_id: installId, sponsor }, cwd);
	if (opts.json) {
		console.log(JSON.stringify({ enabled: true, install_id: installId, sponsor }, null, 2));
		return 0;
	}
	console.log(c.green("Sponsor slot enabled (statusline row 3)."));
	console.log(
		c.dim(
			`Telemetry: ${sponsor.telemetry ? "anonymous impressions/clicks" : "off"} · install ${installId.slice(0, 8)}…`,
		),
	);
	console.log(c.dim("Restart the daemon to start rendering: interlinked harness restart"));
	return 0;
}

/** `interlinked sponsor disable` */
export async function sponsorDisableAction(
	opts: SponsorJsonOpts,
	deps: SponsorCmdDeps = {},
): Promise<number> {
	const { cwd, claudeSettingsPath } = resolveDeps(deps);
	const existing = readLocalConfig(cwd) ?? {};
	const prior: SponsorConfig = existing.sponsor ?? {};
	const written = prior.spinner_verbs_written ?? [];
	if (written.length > 0) {
		const res = removeSponsorSpinnerVerbs(claudeSettingsPath, written);
		if (!res.ok) {
			console.error(c.yellow(`Spinner verbs not removed: ${res.reason ?? "unknown"}`));
		}
	}
	const sponsor: SponsorConfig = {
		...prior,
		enabled: false,
		spinner: false,
		spinner_verbs_written: [],
	};
	updateLocalConfig({ sponsor }, cwd);
	clearSponsorStatus(interlinkedDir(cwd));
	if (opts.json) {
		console.log(JSON.stringify({ enabled: false }, null, 2));
		return 0;
	}
	console.log(c.green("Sponsor slot disabled — row clears on the next statusline refresh."));
	return 0;
}

/** `interlinked sponsor status [--json]` */
export async function sponsorStatusAction(
	opts: SponsorJsonOpts,
	deps: SponsorCmdDeps = {},
): Promise<number> {
	const { cwd } = resolveDeps(deps);
	const cfg = readLocalConfig(cwd) ?? {};
	const sponsor: SponsorConfig = cfg.sponsor ?? {};
	const live = readLiveStatus(interlinkedDir(cwd));
	if (opts.json) {
		console.log(
			JSON.stringify(
				{
					enabled: sponsor.enabled === true,
					telemetry: sponsor.telemetry ?? true,
					spinner: sponsor.spinner === true,
					feed_url: sponsor.feed_url ?? DEFAULT_FEED_URL,
					install_id: cfg.install_id ?? null,
					live,
				},
				null,
				2,
			),
		);
		return 0;
	}
	console.log(`Sponsor slot: ${sponsor.enabled ? c.green("enabled") : c.dim("disabled")}`);
	console.log(c.dim(`  feed: ${sponsor.feed_url ?? DEFAULT_FEED_URL}`));
	console.log(c.dim(`  telemetry: ${(sponsor.telemetry ?? true) ? "on" : "off"}`));
	if (live.creative) {
		console.log(c.dim(`  showing: ${live.creative} — ${live.text ?? ""}`));
	}
	return 0;
}

/**
 * Install the current creative's spinner verb into ~/.claude/settings.json and
 * record it on `sponsor`. Leaves `sponsor` untouched when no verb is available
 * or the settings write is skipped.
 */
async function applySpinnerOptIn(
	sponsor: SponsorConfig,
	claudeSettingsPath: string,
	fetchImpl: typeof fetch,
): Promise<void> {
	const verb = await resolveSpinnerVerb(sponsor.feed_url ?? DEFAULT_FEED_URL, fetchImpl);
	if (!verb) {
		console.error(
			c.yellow("Spinner surface skipped: no verified feed/creative available yet."),
		);
		return;
	}
	const res = addSponsorSpinnerVerb(claudeSettingsPath, verb);
	if (!res.ok || !res.written) {
		console.error(c.yellow(`Spinner surface skipped: ${res.reason ?? "unknown"}`));
		return;
	}
	sponsor.spinner = true;
	const written = new Set(sponsor.spinner_verbs_written ?? []);
	written.add(res.written);
	sponsor.spinner_verbs_written = [...written];
	console.log(c.green(`Spinner verb installed: "${res.written}"`));
	console.log(c.dim("Claude Code reads spinnerVerbs at boot — restart to see it."));
}

/** Fetch + verify the feed once (admission-time network) and derive the verb. */
async function resolveSpinnerVerb(
	feedUrl: string,
	fetchImpl: typeof fetch,
): Promise<string | null> {
	const wire = await fetchFeedWire(feedUrl, fetchImpl);
	if (!wire) return null;
	const feed = verifyWire(wire);
	if (!feed) return null;
	const creative = selectCreative(feed, Date.now());
	if (!creative) return null;
	return `Sponsored by ${creative.text}`;
}

function readLiveStatus(dir: string): Record<string, string> {
	const out: Record<string, string> = {};
	try {
		const raw = readFileSync(join(dir, SPONSOR_STATUS_FILE), "utf8");
		for (const line of raw.split("\n")) {
			const eq = line.indexOf("=");
			if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
		}
	} catch (e) {
		void e;
	}
	return out;
}
