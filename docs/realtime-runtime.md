# Realtime Runtime

Her uses GPT Realtime through a server-mediated client-secret flow. The renderer requests a short-lived secret from the local API instead of receiving the long-lived OpenAI API key.

## Tool Bundles

Realtime receives:

- Core tools by default.
- Dynamic bundles selected from the user transcript.
- Tool definitions generated from the Tool Manifest.

The bundle router is deterministic for obvious domains and falls back to model selection when confidence is low.

## Routing

Simple requests should call concrete tools directly when the relevant bundle is exposed. Ambiguous or complex requests can use routing tools such as `intent_route` to clarify or queue work.

## Safety

- Realtime does not own policy decisions.
- Main process validates schemas, permissions, risk, and confirmation.
- High-risk tool calls from Realtime still return confirmation plans.
- Unknown tools are rejected.
