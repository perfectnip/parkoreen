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

The editor's GPT-5.6 Luna assistant calls the OpenAI Responses API through this Worker. Configure the OpenAI API key as a Worker secret; never put it in `wrangler.toml`, browser code, or Git:

```sh
cd cloudflare-worker && npx wrangler secret put OPENAI_API_KEY
```

The endpoint is signed-in only and applies per-account request limits. The assistant receives the current map and recent conversation. Embedded media data is omitted by the editor. Its map edits are returned as structured operations and must be previewed and explicitly applied in the editor.
