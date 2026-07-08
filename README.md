# n8n-nodes-framer-cms

n8n community node for the **Framer Server API** (`framer-api`). Provides CMS read/write, publish, and deploy operations for Framer projects directly inside n8n workflows — no plugin or open browser required.

> Independent rewrite/fork of [`n8n-nodes-framer`](https://www.npmjs.com/package/n8n-nodes-framer) v0.2.1 (originally by FleetPay, MIT licensed). Reconstructed from the published package to fix a broken `main` entry point, add types throughout, and continue development independently. See [LICENSE](./LICENSE) for attribution.

## Features

- Full CMS access (collections, items, fields)
- `publish()` and `deploy()` native (covers the gap of webhook-plugin integrations)
- A compound **Site Manager** resource that accepts a v4-webhook-style JSON payload and runs multi-step read/audit/write flows (see below) — present in the upstream package but undocumented there
- Credential managed in n8n UI, encrypted in n8n's database — no env vars
- WebSocket-based, designed for batch operations
- Works offline of the Framer editor (no need to keep the project open)

## Installation

### Via n8n UI (recommended)

1. Open your self-hosted n8n
2. Go to **Settings → Community Nodes**
3. Click **Install**
4. Enter package name: `n8n-nodes-framer-cms`
5. Accept the unverified package disclaimer
6. Click **Install**

### Via npm (manual)

```bash
cd ~/.n8n/custom    # or wherever your n8n custom nodes folder is
npm install n8n-nodes-framer-cms
```

Restart n8n after manual install.

## Setup

### 1. Generate a Framer API key

1. Open your Framer project in the browser
2. Go to **Site Settings → API Keys**
3. Click **Create API Key** and copy the value (it is only shown once)

### 2. Create the credential in n8n

1. Go to **Credentials → New**
2. Search for **Framer API**
3. Fill in:
   - **Project URL**: the URL from your browser address bar, e.g. `https://framer.com/projects/Sites--aabbccddeeff`
   - **API Key**: the key you just created
4. Save

### 3. Add the Framer node to a workflow

1. In any workflow, search for **Framer** in the node panel
2. Pick the resource and operation
3. Bind the credential you created

## Operations

### Site Manager (Compound)

Accepts a single **Input JSON** payload (defaults to `$json`, i.e. the incoming webhook body) and runs one of:

| Operation | What it does |
|---|---|
| Read Structure | Every collection with its fields and item count |
| Read Page(s) | Items matching one or more slug paths (`path` or `paths`) |
| Read CMS Collection | All items of a collection matched by name substring (`collection`) |
| Read CMS Item | One item by collection name + `slug` |
| Audit SEO | Scans every item for missing/oversized meta title & description |
| Read Changes | Paths changed since the last publish |
| Update SEO / Pages | Bulk-updates page fields by `path` (looks for a collection named like "page(s)"/"landing") |
| Create Page | Adds one item to the pages collection |
| Create Blog Posts | Adds one or more items to the blog/post collection |
| Publish | Creates a preview deployment |
| Deploy | Promotes a `deployment_id` to production |
| Publish and Deploy | Publish then immediately deploy in one call |

This resource exists to be a drop-in target for existing v4-webhook-based automations — point the webhook at this node instead and keep the same JSON body shape.

### Project
- **Get Info** — display name and hashed project ID

### Collection
- **Get Many** — list all collections (managed and unmanaged)
- **Get** — fetch a collection by ID
- **Get Fields** — list field definitions of a collection
- **Set Fields** — replace field schema (managed collections only)

### Item
- **Get Many** — list items in a collection
- **Add or Update** — bulk insert/update items by ID match
- **Remove** — delete items by ID
- **Set Order** — arrange items in a specific order

### Publish
- **Get Changes** — paths added/removed/modified since last publish
- **Get Contributors** — authors who contributed to a version range
- **Create Preview** — publish a preview link, returns deployment ID
- **Deploy to Production** — promote a preview to production

## Example: full publish flow

```
Manual Trigger
  → Framer (Item: Add or Update)         // populate CMS from external source
  → Framer (Publish: Get Changes)        // verify what changed
  → Framer (Publish: Create Preview)     // get deployment ID
  → Framer (Publish: Deploy to Production)
```

## Architecture notes

- The node opens **one WebSocket connection per execution** and reuses it across all input items, then disconnects. This is the recommended pattern for the Framer Server API and avoids reconnect overhead in batch workflows.
- `framer-api` ships ESM-only (`"type": "module"`) while this node compiles to CommonJS. It's loaded through a dynamic `import()` at runtime (see the top of [`Framer.node.ts`](./nodes/Framer/Framer.node.ts)) so `tsc` doesn't downlevel it to a `require()` call, which would crash with `ERR_REQUIRE_ESM`.
- Compatible with n8n self-hosted (Community Edition or higher). Not available on n8n Cloud (unverified community nodes are restricted to self-hosted).

## Compatibility

- n8n version: ≥ 1.82.0
- Node.js: ≥ 22 (matches the `framer-api` engine requirement)
- Framer Server API: open beta

## Development

```bash
npm install
npm run build      # tsc + copy icons into dist/
npm run lint
```

Link into a local n8n instance for testing:

```bash
npm run build
npm link
cd ~/.n8n/custom
npm link n8n-nodes-framer-cms
```

## Support

Issues and PRs welcome on this repo.

## License

MIT — see [LICENSE](./LICENSE). Originally based on `n8n-nodes-framer` v0.2.1 (MIT, © FleetPay).
