import type { OptionValues } from "commander";
import { CHECK_REGISTRY } from "../harness/check-registry/index.js";
import { BEHAVIORAL_CHECK_META, GENERIC_CHECK_META, QUALITY_CHECK_META, STRUCTURAL_CHECK_META, SUGGESTION_CHECK_META } from "../harness/check-metadata.js";
import { loadCheckPolicy, resolveAction } from "../harness/check-policy.js";
import { registeredSessionPredicates, unsupportedRulePredicates } from "../harness/evaluator/active-when.js";
import { loadRules } from "../harness/rules-loader.js";
import { readFindingOutcomes } from "../harness/check-observation-reader.js";
import { runningEvidenceIdentity } from "../harness/check-observation-store.js";
import { output, getOutputMode } from "../lib/output.js";
import { hookCapabilityInventory } from "./harness-capabilities.js";
import { DEFAULT_ADVISORY_SKIPS } from "./verify/advisory.js";

interface Explanation {
    id: string; name: string; description: string; kind: "check" | "guard" | "predicate";
    implemented: true | "documented"; enabled_here: boolean | "unknown" | "conditional";
    policy: unknown; client_support: unknown; recently_observed: unknown;
}
interface ExplainInput { cwd: string; topic: string; client?: string }
function observedRecently(timestamp: string): boolean {
    const age = Date.now() - Date.parse(timestamp);
    return age >= 0 && age <= 7 * 24 * 60 * 60 * 1000;
}
const ALIASES: Record<string, string> = { permissions: "permission", tests: "test", mutation: "mutation", supplychain: "supply-chain" };
const CLIENT_ALIASES: Record<string, string> = { claude: "claude-code", gemini: "gemini-cli", copilot: "copilot-cli" };

function inventory(cwd: string): Explanation[] {
    const policy = loadCheckPolicy(cwd);
    const rules = loadRules(cwd);
    const metadata = { ...GENERIC_CHECK_META, ...SUGGESTION_CHECK_META, ...QUALITY_CHECK_META, ...STRUCTURAL_CHECK_META, ...BEHAVIORAL_CHECK_META };
    const out: Explanation[] = Object.entries(metadata).map(([id, meta]) => {
        const check = CHECK_REGISTRY.find(c => c.id === id);
        const resolved = check ? resolveAction(check, policy) : null;
        return { id, name: meta.name, description: meta.description, kind: "check", implemented: check ? true : "documented",
            enabled_here: resolved ? resolved.action !== "silent" : rules.quality_checks[id]?.enabled ?? "unknown",
            policy: { resolved, default_verify: !DEFAULT_ADVISORY_SKIPS.has(id),
                conditions: policy.checks[id]?.when ?? null, qualification: "Static policy; file, phase and suppression filters still apply" },
            client_support: "unknown", recently_observed: "unknown" };
    });
    for (const rule of rules.rules) {
        out.push({ id: rule.id, name: rule.id, description: rule.reason, kind: "guard", implemented: true,
            enabled_here: rule.enabled, policy: { action: rule.action, trigger: rule.trigger,
                conditions: rule.active_when ?? null, unsupported_predicates: unsupportedRulePredicates(rule) },
            client_support: "unknown", recently_observed: "unknown" });
    }
    for (const id of registeredSessionPredicates()) {
        out.push({ id, name: id, description: "Registered active_when predicate; applies only through a matching rule", kind: "predicate",
            implemented: true, enabled_here: "conditional", policy: null, client_support: "unknown", recently_observed: "unknown" });
    }
    return out;
}

/** Static capability and local execution evidence are separate from native enforcement. */
export async function explainHarness(input: ExplainInput) {
    const topic = input.topic.toLowerCase().replace(/\s+/g, " ").trim();
    const needle = ALIASES[topic] ?? topic;
    const entries = inventory(input.cwd);
    const exact = entries.filter(row => row.id === topic);
    const matches = exact.length ? exact : entries.filter(row => [row.id, row.name, row.description].join(" ").toLowerCase().includes(needle));
    const outcomes = await readFindingOutcomes(input.cwd);
    const capabilities = hookCapabilityInventory(input.cwd);
    const provider = input.client ? CLIENT_ALIASES[input.client] ?? input.client : undefined;
    const client = capabilities.adapters.find(adapter => adapter.provider === provider);
    for (const match of matches) {
        match.client_support = client ? { provider: client.provider, declared_events: client.events,
            last_hook_emission: client.lastEmission, definition_matches: client.definitionMatchesLastEmission, enforcement: "unmeasured" } : "unknown";
        const observed = outcomes.executions.find(row => row.check === match.id);
        if (observed) match.recently_observed = { timestamp: observed.last, detector: observed.detector,
            configuration: observed.configuration, file: observed.file, scope: observed.scope,
            within_seven_days: observedRecently(observed.last),
            current_runtime: observed.detector === runningEvidenceIdentity(), native_delivery: "unknown" };
    }
    return { schema: "harness-explain.v1", topic: input.topic, client: input.client ?? "unknown",
        runtime: runningEvidenceIdentity(), matches, observation_scope: outcomes.coverage,
        interpretation: "Missing observation is unknown. Local implementation, policy and declared client support do not prove hook activation or enforcement." };
}

export async function harnessExplainCommand(topic: string, opts: OptionValues): Promise<void> {
    const result = await explainHarness({ cwd: process.cwd(), topic, ...(typeof opts.client === "string" ? { client: opts.client } : {}) });
    output(getOutputMode(opts), result, { json: () => result, normal: () => result.matches.length
        ? result.matches.map(row => row.id + ": implemented=" + row.implemented + "; enabled here=" + row.enabled_here
            + "; client support=" + (row.client_support === "unknown" ? "unknown" : "declared; enforcement unmeasured") + "; observation=" +
            (row.recently_observed === "unknown" ? "unknown" : "retained (see --json for identity/scope)")).join("\n") + "\n" + result.interpretation
        : "No registered metadata matches " + topic + ". This is not proof that no implementation exists." });
}
