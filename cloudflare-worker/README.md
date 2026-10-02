# Parkoreen Cloudflare Worker

This folder contains the Cloudflare Worker backend for Parkoreen.

## Already Deployed

The worker is already deployed at: `https://parkoureen.ikunbeautiful.workers.dev`

KV Namespaces are already configured with these IDs:
- USERS: `4c9e8e0bbf5e43de964a55e2d3433c15`
- MAPS: `dde89b1faa604d08ba549a40fba25e3e`
- SESSIONS: `cf190d62b45e4e1e80099b3fa2f2b083`
- ROOMS: `e0026b47bf10450d9dc542beaba00289`

## If You Need to Redeploy

1. Install Wrangler: `npm install -g wrangler`
2. Login: `wrangler login`
3. Deploy: `wrangler deploy`

Or use the Cloudflare Dashboard:
1. Go to dash.cloudflare.com → Workers & Pages → Your Worker
2. Click "Quick Edit"
3. Paste the contents of `worker.js`
4. Save and Deploy

## Map Editor AI assistant

The Map Assistant is temporarily paused while map-generation quality is improved. Its editor button is hidden and `/editor/ai-assist` returns `503` before making an OpenAI request. The client and Worker implementations are retained so the feature can be re-enabled after quality work by setting `MAP_ASSISTANT_ENABLED` to `true` in both `assets/js/editor.js` and `worker.js`. Existing conversations remain in each player's browser.

When the feature is re-enabled, it uses the OpenAI Responses API through this Worker. Configure the API key as a Worker secret; never put it in `wrangler.toml`, browser code, or Git:

```sh
cd cloudflare-worker && npx wrangler secret put OPENAI_API_KEY
```

When enabled, the endpoint is signed-in only and applies per-account request limits. The assistant receives the current map and recent conversation. Embedded media data is omitted by the editor. Its map edits are returned as structured operations and must be previewed and explicitly applied in the editor. Community maps are not automatically used as training data; any future training dataset should require separate creator opt-in and curation.
