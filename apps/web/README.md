# Appliance Clinic web front end

The static site at https://applianceclinic.ai: the customer chat, the admin, the appliance help pages and the recall
search. It is plain HTML, CSS and browser JavaScript with no framework or bundler. The build copies `public/` to
`dist/` and makes a few deterministic changes.

| Path | What it is |
|---|---|
| `public/index.html`, `app.js`, `chat-session.js`, `styles.css` | Customer chat: conversation, photo of the rating plate, safety, media, part cards, feedback, New chat |
| `public/webmcp.js`, `webmcp-badge.js` | WebMCP tools for agent browsers (Chrome origin trial). The tools call the same `/api` as the chat |
| `public/sw.js` | Service worker. It caches the static shell for offline use; it never caches `/api`, admin or conversations |
| `public/admin.html`, `admin.js`, `styles-admin.css` | Admin console (see below) |
| `public/*-logic.js` | Pure helpers the admin uses. Each one is a UMD module, so the tests load it in Node |
| `public/<appliance>/…/index.html`, `hubs/` | Public help pages, and the appliance data their "diagnose this" buttons use |
| `public/recalls/recalls.js` | Script for the recall pages. The pages themselves are written by the API (`services/whichpart-api/recalls`) |
| `public/404.html`, `robots.txt`, `sitemap*.xml`, `site.webmanifest`, `assets/` | Site furniture |
| `scripts/build.mjs`, `site-files.mjs` | Build: `public/` → `dist/` plus `dist.manifest.json` |
| `scripts/serve.mjs` | Local development server |
| `scripts/deploy.mjs` | Deploy to the AC web bucket, and roll back |
| `test/` | Vitest + jsdom tests |

## Run it locally

```sh
cd apps/web
npm ci
npm run serve                                   # http://localhost:8080, API = https://applianceclinic.ai/api
API_ORIGIN=https://<other-host> npm run serve   # another Appliance Clinic API
```

`serve` builds the site, serves `dist/` and forwards `/api/*` unchanged to `API_ORIGIN`. The admin session cookie
(Secure, SameSite=Lax, no Domain) works on `localhost` as it does on the live site.

Pointed at production, the chat is real: turns are diagnosed and recorded as transcripts. Use obvious test wording.
In a sandbox with an HTTP proxy, run it with `NODE_USE_ENV_PROXY=1`.

## How it calls the API

- **Same origin only.** Every request goes to `/api` on the site's own origin. CloudFront sends `/api*` to the
  `whichpart-api` BFF (`services/whichpart-api`). `window.WHICHPART_API_BASE` can override the base for local
  experiments; nothing in the site sets it.
- **Customer turn.** `POST /api` with the conversation window, the opaque `stateToken` from the previous reply (echoed
  back, never read), and an `observability` session and turn id.
  - The reply is a view: `reply`, `diagnosis`, `safety` (stop), `safetyInformation`, `media`, `parts`, `needsModel`,
    `traceId`.
  - `app.js` renders those fields as text. It never sets API text as HTML, and never reinterprets the reply.
- **Errors.** A non-2xx response or a network failure leaves the conversation unchanged and shows a retry banner. The
  client never invents an assistant turn.
- **Shop links.** A part card links to the `offers[].url` the API returned, in a new tab with no referrer. This is the
  only path from the site to a shop. No diagnosis request goes anywhere but `/api`, and `test/boundary.test.mjs`
  enforces that.
- **Other calls:** `POST /api` with `feedback` (thumbs), `GET /api/recalls` (recall search) and `/api/auth/*`.

## Admin authentication

The admin page holds no identity configuration. It asks `GET /api/auth/me`, signs in with `POST /api/auth/login`
(email and password) and signs out with `POST /api/auth/logout`. The BFF does the rest:

1. It authenticates against the **Appliance Clinic Cognito pool**.
2. It sets an HttpOnly session cookie.
3. It allows `/api/admin/*` only to members of the pool's `admin` group (ADR 0006,
   `services/whichpart-api/ac-auth.js`).

Showing the admin shell is presentation only: every admin call is checked again on the server.

To give someone admin access, create the user in the AC pool and add them to the `admin` group.
`infra/production/verify-ac-auth.sh` shows the commands; it creates temporary users and deletes them.

## Admin areas

| Area | API | Status |
|---|---|---|
| Dashboard | `/admin/dashboard` | Kept |
| Conversations (transcripts, review, quality) | `/admin/transcripts*` | Kept |
| Test: live workbench, scenarios library, batch quality runs | `/admin/benchmark/*`, `/admin/library*` | Kept |
| Knowledge | `/admin/knowledge`, `/admin/knowledge/record` | **Read-only.** Knowledge ships with the diagnosis engine (ADR 0019). The draft / publish / version-history editor and its seven routes were removed from the API, so their UI was removed here too |
| Error codes | `/admin/error-codes*` | Kept (draft → publish workflow, history) |
| Media | `/admin/media*` | Kept (draft → publish workflow, history, knowledge mapping) |
| Safety: recalls and safety ingest | `/admin/recalls*`, `/admin/safety-ingest*` | Kept |
| Diagnostics (deployed components, runtime facts) | `/admin/diagnostics` | Kept. The retired shared engine's RAG-index fields are no longer shown (the API stopped sending them) |
| Settings (transcript retention, inference, Jev, AI config) | `/admin/settings*`, `/admin/ai-config*` | Kept |

## Checks

```sh
npm run check      # = lint + typecheck + test + build
```

- **lint:** ESLint over everything.
- **typecheck:** `tsc` over the browser scripts as JavaScript, with JSDoc where a DOM type needs narrowing.
  - `admin.js` (about 7,800 lines of string-built DOM code) is linted but not type-checked.
  - `sw.js` is also linted only, because it needs the WebWorker library.
- **test:** what the customer sees for each kind of reply (normal, error, offline, safety stop, safety panel,
  diagnosis, media, part card and shop link, model request, feedback, draft saving); admin bootstrap and sign-in; the
  read-only knowledge page; the API boundary; the build.
- **build:** deterministic. CI builds twice and compares the manifests.

## Build

```sh
npm run build                                   # dist/ and dist.manifest.json
WEBMCP_ORIGIN_TRIAL_TOKEN=<token> npm run build
```

- Local `file?v=…` references in the pages and in `sw.js` become `file?v=<content hash>`. A changed script is a new
  cache key, and the service worker's cache name follows its precache list.
- The WebMCP origin-trial meta tag gets the token, or is removed when none is given. The token is public (it is served
  in the page) but is not committed.
- Every local `src`/`href` must resolve, or the build fails.

## Deploy

```sh
node scripts/deploy.mjs                   # dry run: what would change
EXECUTE=1 node scripts/deploy.mjs         # back up, upload, verify
node scripts/deploy.mjs --rollback <id>   # put back what that deploy replaced
```

**Needs:** the aws CLI with Appliance Clinic account credentials. The bucket is `whichpart-web-800960611664`, served by
the applianceclinic.ai CloudFront distribution.

**What it does (ADR 0008):**
1. Carries over the live WebMCP token, unless `WEBMCP_ORIGIN_TRIAL_TOKEN` is set.
2. Builds the site.
3. Uploads only files whose MD5 differs from the bucket, with the content type and Cache-Control in
   `scripts/site-files.mjs`.
4. Before uploading, copies every object it will replace to
   `s3://applianceclinic-migration-backup-800960611664/site-deploys/<id>/`.
5. Uploads pages last, then checks each object's ETag and metadata.

**What it never does:**
- It never deletes. The bucket also holds files the API writes at run time (`media/`, the recall pages,
  `sitemap-recalls.xml`).
- It never changes CloudFront. HTML is cached for 60 s and versioned scripts for 5 min, so no invalidation is needed.
