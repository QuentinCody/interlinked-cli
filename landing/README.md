# Landing page and waitlist

The Worker serves static assets and two waitlist routes. `/api/*` and `/healthz`
run the Worker before asset lookup. The API uses the `WAITLIST_KV` binding in
`wrangler.jsonc`; the export route also requires the `ADMIN_TOKEN` Worker secret.
Keep that secret out of source control and browser code.

From the repository root, `npm test` includes the Worker tests and both
`npm run typecheck` and `npm run typecheck:stable` include `landing/tsconfig.json`.
From this directory, `wrangler dev` runs a local preview and
`wrangler deploy --dry-run` checks the bundle without publishing it.
Deployment is a separate action: verify the account, namespace, and domain
before running `wrangler deploy`. Set the export secret with
`wrangler secret put ADMIN_TOKEN` when configuring that deployment.

`POST /api/waitlist` accepts JSON with `email`, optional `source`, and an empty
`website` honeypot. It normalizes the email and stores the signup time, source,
user agent, and country. Address validation checks shape; it does not confirm
ownership or send mail. Rows remain until explicitly deleted. Duplicate joins
preserve an existing row when visible, but concurrent joins can overwrite it
because [KV reads are eventually consistent](https://developers.cloudflare.com/kv/concepts/how-kv-works/).
The honeypot is a basic filter, not a rate limiter.

`GET /api/waitlist/export` requires `Authorization: Bearer <ADMIN_TOKEN>`.
It returns `{ count, entries, cursor }` for at most 250 keys per request. Follow
each non-null cursor in the next request's `?cursor=` parameter, URL-encoding its
value, even when `entries` is empty. Stop only at a null cursor. `count` is the
current page count and entries are sorted within that page; export all pages
before sorting the complete list. This follows the
[KV pagination contract](https://developers.cloudflare.com/kv/api/list-keys/).
Deleted rows are skipped; corrupt rows produce an error instead of a partial
success. Missing export configuration returns 404, invalid credentials return
401, and storage failures return 503. API responses disable caching.
