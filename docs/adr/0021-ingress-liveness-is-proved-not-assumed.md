# ADR 0021: A share ingress proves it can serve, and exits when it cannot

- Status: Accepted
- Date: 2026-08-20

## Context

[ADR 0017](0017-authenticated-share-ingress.md) binds the ingress to one
tailnet address for the life of the process. That address belongs to an
interface the ingress does not own: a Tailscale restart tears the interface
down and re-creates it, and the socket bound to the old one survives the flap
in name only. The process stays up, the socket stays in `LISTEN`, and every
connection is accepted and dropped before it reaches the handler.

Every layer read that as healthy. `launchd`'s `KeepAlive` watches for an exit
that never comes. The ledger records nothing, because no Admission is ever
attempted. `doctor` reported all seven checks green while shares were being
dropped — its checks all read the database, and the database is exactly where
this failure leaves no trace. The only visible symptom was the device outbox
from [ADR 0020](0020-client-share-outbox.md) counting up on the toolbar badge,
which is the client correctly reporting a server that never answered.

Observed on 2026-08-20: an ingress bound at 00:21 stopped serving after a
12:47 Tailscale restart, and held its dead socket for hours.

## Decision

- **A serving ingress proves it can serve.** On a cadence it sends itself
  `GET /v1/health` over its own bound address. Only a completed request counts:
  a socket that accepts and drops still connects, so reachability is not proof.
- **An ingress that cannot serve exits.** It does not re-bind in place — that
  races the socket it is replacing and hides the flap from the operator. The
  service definition owns restart, and a fresh bind is the only thing that
  recovers a stale one. A single failed probe is a flap; a sustained one is an
  exit.
- **A serving ingress registers itself.** `share-ingress.json` in the private
  state directory names the URL and pid while an ingress is claiming that
  address, and is withdrawn on shutdown. It is a claim, not a lock.
- **`doctor` reports the ingress it can see.** No registration is not a defect,
  because the service is opt-in. A registration whose process is gone is a
  warning: a stale claim, dropping nothing. A registered, running ingress that
  cannot answer is a failure — that is the state where shares are lost and
  nothing else says so.

## Consequences

Recovery costs one restart cycle rather than an operator noticing a badge.

The probe is the first request agentbrain makes, so the ADR 0002 boundary gains
one narrow, asserted exception: `src/share-liveness.ts` may call `fetch`, once,
against the address the ingress registered for itself, and `GET /v1/health` is
the only path it ever asks for. No locator from a job, a payload, or the
database can reach it, and every other egress seam stays forbidden there —
`test/source-boundary.test.ts` holds both halves. Agentscrape remains the sole
fetcher of anything published.

An ingress that exits while its address is genuinely gone will restart, fail to
bind, and be retried by the service definition until the address returns —
visible in the log, which is the intended reading.
