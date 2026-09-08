import { isJsonObject } from "../../src/lib/json-types.js";
import { wireObject, wireString } from "../../src/lib/value-validation.js";

interface KVNamespaceLite {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  list(options?: {
    prefix?: string;
    limit?: number;
    cursor?: string;
  }): Promise<{ keys: { name: string }[]; list_complete: boolean; cursor?: string }>;
}

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  WAITLIST_KV: KVNamespaceLite;
  /** Set via `wrangler secret put ADMIN_TOKEN`; export route 404s when absent. */
  ADMIN_TOKEN?: string;
}

const HEALTH_PATH = "/healthz";
const WAITLIST_PATH = "/api/waitlist";
const WAITLIST_EXPORT_PATH = "/api/waitlist/export";
const WAITLIST_PREFIX = "wl:";
const MAX_EMAIL_LENGTH = 254;
// Shape validation only; joining does not verify ownership of the address.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const EXPORT_PAGE_SIZE = 250;

interface WaitlistRow {
  email: string;
  joined_at: string;
  source: string;
  user_agent: string;
  country: string;
}

const isWaitlistRow = wireObject<WaitlistRow>({
  email: wireString,
  joined_at: wireString,
  source: wireString,
  user_agent: wireString,
  country: wireString,
});

function parseWaitlistRow(text: string): WaitlistRow | null {
  try {
    const row: unknown = JSON.parse(text);
    return isWaitlistRow(row) ? row : null;
  } catch {
    return null;
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

async function handleWaitlistJoin(req: Request, env: Env): Promise<Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json(400, { error: "body must be JSON" });
  }
  if (!isJsonObject(raw)) return json(400, { error: "body must be a JSON object" });
  const body = raw;

  // Honeypot: the hidden "website" field is empty for humans.
  if (typeof body.website === "string" && body.website.length > 0) {
    return json(200, { ok: true });
  }

  const email =
    typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (email.length === 0 || email.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(email)) {
    return json(400, { error: "enter a valid email address" });
  }

  const key = `${WAITLIST_PREFIX}${email}`;
  const existing = await env.WAITLIST_KV.get(key);
  if (existing !== null) {
    return json(200, { ok: true, already: true });
  }

  const row: WaitlistRow = {
    email,
    joined_at: new Date().toISOString(),
    source: typeof body.source === "string" ? body.source.slice(0, 64) : "landing",
    user_agent: (req.headers.get("user-agent") ?? "").slice(0, 256),
    country: (req.headers.get("cf-ipcountry") ?? "").slice(0, 8),
  };
  await env.WAITLIST_KV.put(key, JSON.stringify(row));
  return json(200, { ok: true });
}

async function handleWaitlistExport(req: Request, env: Env): Promise<Response> {
  const token = env.ADMIN_TOKEN;
  if (!token) return json(404, { error: "not found" });
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${token}`) return json(401, { error: "unauthorized" });

  const rows: WaitlistRow[] = [];
  const cursor = new URL(req.url).searchParams.get("cursor");
  const page = await env.WAITLIST_KV.list({
    prefix: WAITLIST_PREFIX,
    limit: EXPORT_PAGE_SIZE,
    ...(cursor ? { cursor } : {}),
  });
  if (!page.list_complete && !page.cursor) {
    return json(503, { error: "waitlist page is incomplete; retry the export" });
  }
  for (const key of page.keys) {
    const value = await env.WAITLIST_KV.get(key.name);
    if (value === null) continue;
    const row = parseWaitlistRow(value);
    if (row === null) return json(500, { error: "stored waitlist entry is invalid" });
    rows.push(row);
  }

  rows.sort((a, b) => a.joined_at.localeCompare(b.joined_at));
  return json(200, { count: rows.length, entries: rows, cursor: page.list_complete ? null : page.cursor });
}

async function handleWaitlistApi(request: Request, env: Env, path: string): Promise<Response> {
  const method = path === WAITLIST_PATH ? "POST" : "GET";
  if (request.method !== method) {
    const response = json(405, { error: "method not allowed" });
    response.headers.set("allow", method);
    return response;
  }
  try {
    return await (method === "POST" ? handleWaitlistJoin(request, env) : handleWaitlistExport(request, env));
  } catch {
    return json(503, { error: "waitlist temporarily unavailable; try again" });
  }
}

const handler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === HEALTH_PATH) {
      return new Response("ok", { headers: { "content-type": "text/plain" } });
    }
    if (url.pathname === WAITLIST_PATH || url.pathname === WAITLIST_EXPORT_PATH) {
      return handleWaitlistApi(request, env, url.pathname);
    }

    return env.ASSETS.fetch(request);
  },
};

export default handler;
