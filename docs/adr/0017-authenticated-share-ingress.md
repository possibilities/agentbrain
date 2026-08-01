# ADR 0017: Authenticated share ingress for personal devices

- Status: Accepted
- Date: 2026-08-01

## Context

Saving a link today requires a shell. Everything Mike reads on a phone, or in a
browser tab away from a terminal, is either lost or manually re-entered later.
The two Ingresses that would remove that friction are a Chrome action and an
Android share target, and both are network clients: neither can invoke the
Agentbrain CLI directly.

[ADR 0012](0012-local-security-and-sensitive-ingestion.md) deferred exactly this
surface: "Remote or multi-user access is deferred. Any future daemon, web UI,
remote operator, or shared index requires a separate authorization and
threat-model decision before exposure." `test/source-boundary.test.ts` encodes
that deferral by forbidding `Bun.serve` anywhere in `src/`. This ADR is the
separate decision that deferral required.

The devices involved share a private Tailscale tailnet. It is tempting to treat
tailnet membership as sufficient authorization, but that conflates reachability
with authority: every process on every joined device, including a compromised
app on a phone or any other machine on the tailnet, would inherit write access
to the durable ingestion ledger. ADR 0012 already establishes that the Unix
account is the authorization boundary for local use; a network listener steps
outside that boundary and needs its own.

## Decision

- **One ingestion contract, not a parallel store.** The ingress exposes
  `POST /v1/share` and resolves each payload into exactly one Admission intent
  passed to the same `admitSubmission` path the CLI uses. It creates no tables,
  no queue, and no documents of its own. Duplicate suppression, intent hashing,
  job identity, retries, and worker materialization are inherited unchanged, so
  a replayed share returns `duplicate` with the same job.
- **The server is the authoritative ingestion point.** Clients report what they
  observed; the server decides whether a payload is a URL job or a text job,
  including recovering a locator from free-text shares. Client-side parsing is
  a convenience, never the contract.
- **Network reachability is not authorization.** Every route, including health,
  requires a bearer token. The token is generated locally, stored `0600` under
  the Agentbrain state directory per ADR 0012, and compared in constant time.
  Tailnet membership remains a transport property only.
- **Binding is explicit and narrow.** The default bind is `127.0.0.1`. Accepting
  device shares requires naming the tailnet address; binding every interface
  additionally requires `--allow-any-interface`. There is no configuration in
  which the ingress is exposed by default.
- **The ingress is inbound only.** It performs no outbound network work. ADR
  0002's boundary is untouched: Agentscrape still owns every URL fetch, and the
  resident Worker still materializes admitted jobs.
- **The listener exemption is exactly one module.** `test/source-boundary.test.ts`
  continues to forbid outbound network clients across all of `src/`, and
  continues to forbid inbound binding everywhere except `src/share-server.ts`.
  A second listener is a new decision, not an implementation detail.
- **Client identity is a bounded enum.** `ingress` is `chrome-extension` or
  `android-share`; an unrecognized client is rejected rather than recorded as
  free-form provenance supplied by a network peer.
- **Transport privacy is not resource sensitivity.** Consistent with ADR 0012, a
  public URL shared from a phone is not sensitive merely because it arrived over
  a private transport. Shared payloads default to the `saved-links` collection.
- **Operational output carries no content.** Request logs record method, path,
  status, a safe outcome label, and job id. Shared URLs, titles, text bodies,
  and the token never appear in logs, and a text payload is never echoed back in
  a response.
- **Bounds are enforced before admission.** Payloads are capped (1 MiB body,
  100k characters of text), must be `application/json`, and unparseable or
  unauthorized requests are refused before any durable write.

## Consequences

- Saving a link from a phone or browser becomes a single tap or keystroke, and
  every saved link lands in the same ledger as CLI submissions with correct
  ingress provenance.
- The token is a real credential with real handling obligations: it must be
  distributed to each device, rotated with `share token init --force`, and its
  loss grants tailnet-reachable write access to the ingestion queue until
  rotated.
- HTTP inside the tailnet means Tailscale provides the transport encryption.
  Android's cleartext policy must permit the tailnet host explicitly, which the
  bundled network security config does for MagicDNS names.
- The ingress must stay running to receive shares. It is a separate process from
  the Worker; a share is durably queued the moment it is admitted, and
  materialization still waits on the Worker.
- Every future route on this listener inherits the same obligations:
  authenticate first, bound the payload, admit through Admission, and log no
  content.

## Related

- [ADR 0003: Agentbrain owns durable ingestion](0003-agentbrain-owns-durable-ingestion.md)
- [ADR 0005: Public ingestion Admission contract](0005-public-ingestion-admission-contract.md)
- [ADR 0012: Local security and sensitive ingestion](0012-local-security-and-sensitive-ingestion.md)
- [`docs/contracts/share-ingest-v1.md`](../contracts/share-ingest-v1.md)
- [`docs/runbooks/share-ingress.md`](../runbooks/share-ingress.md)
