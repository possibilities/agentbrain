# Agentbrain share clients

Device clients for the authenticated share ingress. Both speak the same
contract — [`docs/contracts/share-ingest-v1.md`](../docs/contracts/share-ingest-v1.md)
— and neither owns any storage or ingestion logic of its own.

| Directory | Platform | Entry points |
| --- | --- | --- |
| [`chrome/`](chrome) | Chrome / Chromium desktop (MV3) | toolbar action, context menu, keyboard shortcut |
| [`android/`](android) | Android 8.0+ | system share sheet (`ACTION_SEND`, `text/plain`) |

Setup for both is in
[`docs/runbooks/share-ingress.md`](../docs/runbooks/share-ingress.md). The
authorization decision behind this surface is
[ADR 0017](../docs/adr/0017-authenticated-share-ingress.md).

## Design note

Clients are deliberately thin. They report what the platform gave them — a URL,
or free text that may contain one — and the server decides whether that becomes
a URL job or a text job. Keeping resolution server-side means there is one
implementation of the rules, tested once, and a client bug cannot invent a
second ingestion policy.

Neither client is built or tested by `bun run check`; they are verified against
a running ingress as described in the runbook.
