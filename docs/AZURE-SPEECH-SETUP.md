# Azure AI Speech integration readiness

The GitHub Pages frontend currently has **no configured Azure Speech token-broker endpoint**, region, Speech SDK, or Azure credentials. Browser speech remains the active provider. Azure neural speech must not be reported as enabled until a broker and an Azure Speech resource are configured and tested.

## Required Cloudflare Worker work (not implemented here)

The existing AI chat endpoint and its request/response contract must remain unchanged. Add a separately reviewed token-broker route to the Worker only when you choose to configure Azure. Do not assume a URL/path for that route in the frontend.

The broker should:

- Keep the Azure Speech subscription key in a Cloudflare Worker secret, never in the frontend, repository, or returned response.
- Authenticate with Azure and return only a short-lived access token, expiration timestamp, and optionally the configured region.
- Set strict CORS for `https://seblpoulsen.github.io` (and any deliberately used local development origin), validate method/content type, avoid caching, apply abuse/rate controls, and return generic errors without credentials.
- Be deployment-tested independently without changing the existing AI chat handler.

## Frontend runtime configuration after the broker exists

Only after the route is implemented and tested, configure the page before `voice-engine.js` loads with a non-secret object:

```js
window.JARVIS_SPEECH_CONFIG = {
  tokenBrokerUrl: 'THE_ACTUAL_BROKER_URL_FROM_YOUR_WORKER',
  region: 'YOUR_AZURE_SPEECH_RESOURCE_REGION',
  voice: 'en-GB-RyanNeural'
};
```

This is configuration, not a secret. The broker response expected by the provider module is JSON `{ "token": "...", "expiresAt": "ISO-8601 timestamp or epoch milliseconds" }`. Tokens are held only in memory and refreshed one minute before expiry. Do not configure this until the Worker endpoint and response contract actually exist.

The Microsoft Speech SDK must also be loaded from a reviewed, pinned Microsoft distribution before Azure can be selected. The Azure provider in `voice-engine.js` checks for the SDK and explicit configuration; otherwise it is unavailable and the browser provider remains in use. No SDK CDN request or Azure request is made by default.

## Voice and cost

`en-GB-RyanNeural` is a requested voice name, not a guarantee of resource/region availability. Validate it against the actual Speech resource and region before selecting it. Azure Speech has account, quota, and pricing terms that can change; confirm current Microsoft pricing and any free allowance in your Azure account before enabling it. This project does not create an Azure resource, subscription, or billing configuration.
