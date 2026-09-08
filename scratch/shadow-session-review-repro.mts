// Read-only protocol probes for the review of Claude session 344d9ff3.
import { readFileSync } from "node:fs";
import ts from "typescript";
import { resolvesToSelf } from "../src/harness/checks/self-import-scan.js";
import { normalizeToolInput, toolInputHash } from "../src/harness/shadow/protocol/tool-input.js";
import { projectPostImages } from "../src/harness/shadow/protocol/post-image-projector.js";
import { finalizeInputBundleV1 } from "../../interlinked-cloud/src/shadow/parse-broker.js";
import { validateShadowExecutionRequest } from "../../interlinked-cloud/src/shadow/admission.js";
import { canonicalDigest, sha256Hex } from "../src/harness/shadow/protocol/canonical.js";
import { computeOverlayBytesHash, computePostImageSetHash } from "../src/harness/shadow/protocol/tagged-set.js";
import { EXECUTION_PROFILE_ID } from "../src/harness/shadow/protocol/types-core.js";
import { SHADOW_LIMITS_V1 } from "../src/harness/shadow/protocol/limits.js";
import { isDeniedOverlayPath } from "../src/harness/shadow/protocol/overlay-manifest.js";

const importer = "/proj/src/widget.ts";
const files = new Set([importer, "/proj/src/widget.native.ts"]);
const options = { moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext, moduleSuffixes: [".native", ""] };
const host = { fileExists: (p: string) => files.has(p), readFile: () => "export const x=1;", directoryExists: () => true };
console.log("self_import", JSON.stringify({ ours: resolvesToSelf(importer, "./widget.js", host.fileExists), actual: ts.resolveModuleName("./widget.js", importer, options, host).resolvedModule?.resolvedFileName, typescript: ts.version }));

function normalizedPatch(body: string[]) {
    const result = normalizeToolInput({ client: "codex", tool: "apply_patch", repo_root: "/repo", input: { patch: ["*** Begin Patch", ...body, "*** End Patch"].join("\n") } });
    if (!result.ok) throw new Error(JSON.stringify(result));
    return result.normalized;
}
console.log("dependent_hunks", JSON.stringify(projectPostImages(normalizedPatch(["*** Update File: a.txt", "@@", "-alpha", "+bravo", "@@", "-bravo", "+charlie"]), new Map([["a.txt", "alpha\nomega\n"]]))));
console.log("move_mode", JSON.stringify(projectPostImages(normalizedPatch(["*** Update File: a.txt", "*** Move to: b.txt", "@@", "-alpha", "+bravo"]), new Map([["a.txt", { mode: "100755", content: "alpha\nomega\n" }], ["b.txt", null]]))));
console.log("move_under_source", JSON.stringify(projectPostImages(normalizedPatch(["*** Update File: a.txt", "*** Move to: a.txt/b.txt", "@@", "-alpha", "+bravo"]), new Map([["a.txt", "alpha\nomega\n"], ["a.txt/b.txt", null]]))));

// Start from the broker's pinned, valid golden fixture; replace its overlay
// with harmless bytes at a path the mandatory deny ruleset forbids.
const fixture = JSON.parse(readFileSync(new URL("../../interlinked-cloud/src/shadow/fixtures/bundle-hash-vectors.json", import.meta.url), "utf8")).vectors[0].record;
const { bundle_hash: _discarded, ...raw } = fixture;
raw.overlay = [{ tag: "W", path: ".interlinked/config.local.json", mode: "100644", blob_digest: sha256Hex("{}"), bytes: 2 }];
raw.blobs = [{ blob_digest: sha256Hex("{}"), bytes: 2, immutable_key: "inert-probe-blob" }];
const finalized = finalizeInputBundleV1(raw);
console.log("denied_path_finalize", JSON.stringify({ denied: isDeniedOverlayPath(raw.overlay[0].path), ok: finalized.ok }));
if (!finalized.ok) throw new Error(finalized.reason);
const bundle = finalized.value;
const overlayHash = computeOverlayBytesHash(bundle.overlay);
const postHash = computePostImageSetHash(bundle.post_images);
if (!overlayHash.ok || !postHash.ok) throw new Error("fixture hash failure");
const tool = normalizedPatch(["*** Add File: transient.txt", "+x", "*** Delete File: transient.txt"]);
const config = { schema_version: 1 as const, profile_id: EXECUTION_PROFILE_ID, typecheck_strict: true, introduced_only: true as const, max_diagnostics: 10000 };
const configHash = canonicalDigest<"exec-config">(config);
const env = {
    schema: "shadow-env-v1" as const, image_manifest_digest: "sha256:image", verifier_sha256: canonicalDigest<"sha256">("verifier"),
    argv: ["tsgo", "--noEmit"], cwd: "/workspace", env_allowlist: ["PATH"], provisioner_version: "1.0.0",
    registry_policy: { host: "registry.example", replace_registry_host: "always" as const },
    egress_policy_hash: canonicalDigest<"sha256">("egress"), broker_scanner_policy_digest: bundle.broker_scanner_policy_digest,
    exec_config_hash: configHash, resource_limits: SHADOW_LIMITS_V1,
};
const baseRef = "a".repeat(40);
const preHash = canonicalDigest<"pre-tree">("pre");
const claim = {
    mirror: bundle.mirror, base_ref: baseRef, tree_algo: "shadow-tree-v1", post_image_algo: "shadow-postimages-v1", overlay_algo: "shadow-overlay-v1",
    overlay_manifest_hash: bundle.overlay_manifest_hash, overlay_bytes_hash: overlayHash.hash, pre_tree_hash: preHash,
    post_image_set_hash: postHash.hash, post_tree_hash: canonicalDigest<"post-tree">("post"), dependencies: { mode: "none" },
};
const input = {
    request: {
        schema_version: 1, request_id: "req-probe", idempotency_key: "idem-probe", bundle_id: bundle.bundle_id, execution_claim: claim,
        freshness_claim: { base_local_head: baseRef, local_head: baseRef, input_hash: toolInputHash(tool), local_pre_tree_hash: preHash, local_overlay_manifest_hash: bundle.overlay_manifest_hash, local_post_image_set_hash: postHash.hash },
        changeset: { schema_version: 1, pre_tree_hash: preHash, post_image_set_hash: postHash.hash, touched_paths: [] },
        tool_input: tool, expected_bundle_hash: bundle.bundle_hash, execution_profile_id: EXECUTION_PROFILE_ID, lane: "async", deadline_at: "2026-09-04T00:30:00Z",
    },
    authenticated_principal_id: bundle.principal_id, bundle,
    authority: { mirror_key: bundle.mirror.key, version: bundle.mirror.version, base_ref: baseRef },
    policy: { tree_algo: "shadow-tree-v1", post_image_algo: "shadow-postimages-v1", overlay_algo: "shadow-overlay-v1", overlay_manifest_hash: bundle.overlay_manifest_hash, env_digest: canonicalDigest<"env">(env), exec_config_hash: configHash, broker_scanner_policy_digest: bundle.broker_scanner_policy_digest, deadline_at: "2026-09-04T00:30:00Z" },
    published_env: env, published_exec_config: config, current_scanner_policy_digest: bundle.broker_scanner_policy_digest, now: "2026-09-04T00:10:00Z",
};
// Runtime probes intentionally enter the public unknown parsers first.
const { parseShadowExecutionRequest } = await import("../src/harness/shadow/protocol/parse-transport.js");
const { parseExpectedExecutionPolicy } = await import("../src/harness/shadow/protocol/parse-core.js");
const { parseShadowEnv, parseShadowExecConfig } = await import("../src/harness/shadow/protocol/parse-records.js");
const parsedRequest = parseShadowExecutionRequest(input.request);
console.log("denied_path_request_parse", JSON.stringify({ ok: parsedRequest.ok }));
const parsedPolicy = parseExpectedExecutionPolicy(input.policy);
const parsedEnv = parseShadowEnv(input.published_env);
const parsedConfig = parseShadowExecConfig(input.published_exec_config);
if (!parsedRequest.ok || !parsedPolicy.ok || !parsedEnv.ok || !parsedConfig.ok) throw new Error(JSON.stringify({ parsedRequest, parsedPolicy, parsedEnv, parsedConfig }));
const admittedInput = {
    ...input, request: parsedRequest.value, policy: parsedPolicy.value, published_env: parsedEnv.value,
    published_exec_config: parsedConfig.value, now: bundle.finalized_at,
    authority: { mirror_key: bundle.mirror.key, version: bundle.mirror.version, base_ref: parsedRequest.value.execution_claim.base_ref },
};
console.log("denied_path_admission", JSON.stringify(validateShadowExecutionRequest(admittedInput)));
const allowedBundle = finalizeInputBundleV1({ ...raw, overlay: raw.overlay.map((entry: { path: string }) => ({ ...entry, path: "src/only.ts" })) });
if (!allowedBundle.ok) throw new Error(allowedBundle.reason);
const allowedOverlayHash = computeOverlayBytesHash(allowedBundle.value.overlay);
if (!allowedOverlayHash.ok) throw new Error(allowedOverlayHash.detail);
const allowedInput = {
    ...admittedInput, bundle: allowedBundle.value,
    request: { ...admittedInput.request, expected_bundle_hash: allowedBundle.value.bundle_hash,
        execution_claim: { ...admittedInput.request.execution_claim, overlay_bytes_hash: allowedOverlayHash.hash } },
};
console.log("allowed_path_control", JSON.stringify(validateShadowExecutionRequest(allowedInput)));
const inconsistentEnv = { ...parsedEnv.value, exec_config_hash: canonicalDigest<"exec-config">("different-config") };
console.log("inconsistent_env_config", JSON.stringify(validateShadowExecutionRequest({ ...allowedInput, published_env: inconsistentEnv, policy: { ...parsedPolicy.value, env_digest: canonicalDigest<"env">(inconsistentEnv) } })));
