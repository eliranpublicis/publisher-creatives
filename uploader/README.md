# Publisher Creatives Uploader

Cloudflare Worker that exposes the MCP bridge used by the private **Publisher HTML5 Agent** plugin.

## Endpoint

`https://publisher-creatives-uploader.eliran-publicis.workers.dev/mcp`

## Current tools

- `health_check` — verifies that ChatGPT/Plugin Creator can reach the MCP server.
- `validate_publish_request` — validates campaign metadata before the binary upload flow is enabled.

## Deployment

Cloudflare should deploy this folder with:

- Root directory: `uploader`
- Deploy command: `npx wrangler deploy`

The Worker name in `wrangler.jsonc` is `publisher-creatives-uploader`, so deployment updates the existing Worker rather than creating a differently named service.

The existing Cloudflare secret `CLOUDFLARE_API_TOKEN` must remain configured on the Worker and must never be committed to Git.


Build trigger: Cloudflare Git integration connected on 2026-10-02.
