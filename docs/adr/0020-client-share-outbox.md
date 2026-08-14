# ADR 0020: Device clients hold undelivered shares in a client outbox

- Status: Accepted
- Date: 2026-08-14

## Context

[ADR 0017](0017-authenticated-share-ingress.md) made the clients deliberately
thin: they report what the device observed and the server decides everything
else. Thin was read as stateless, and a share the ingress never answered was
therefore reported as a failure and discarded. That reproduces the exact loss
0017 set out to remove — a link read away from a terminal is lost — only now it
is lost while the user is looking at a browser that says so.

The ingress is not always up. It is a separate resident process from the Worker,
opt-in per machine, reachable only across a tailnet, and the laptop doing the
sharing is frequently asleep, tethered, or off the tailnet entirely. Reachability
at the moment of the share is not something the user can be asked to check first.

Nothing on the server can fix this: the payload only exists on the device until
it is delivered.

## Decision

- **The client holds undelivered intent; the server still owns everything
  else.** A retryable failure enqueues the payload unchanged in a Share outbox
  in `chrome.storage.local` and redelivers it on a backoff until the ingress
  answers. The client gains durability for what it has not sent, and no
  resolution, parsing, or job identity of its own.
- **Holding is never reported as saving.** Nothing is in Agentbrain until
  Admission answers, so the outbox badges and notifies as *held*, and the
  Options page says so in as many words.
- **No client idempotency key.** The ingress derives the key from the intent,
  so a share that was in fact received before the connection dropped returns
  `duplicate` naming the same job. A key minted per outbox entry would defeat
  exactly that.
- **Retryable is the contract's definition.** A connection failure, a timeout,
  or a 5xx is retried; a 4xx other than 401 means the payload is wrong and is
  dropped with notice rather than retried forever. 401 is retried, because a
  rejected token is a repairable configuration fault and discarding the user's
  shares while it is wrong is the outcome this ADR exists to prevent.
- **Bounded.** At most 200 entries and 7 days. Both limits drop the oldest
  first, and every drop notifies: silent loss is what was wrong with the
  previous behavior.

## Consequences

The Chrome client now carries state that can disagree with the ledger — shares
the user took that Agentbrain has no record of. That is inherent to offline
capture, and is why the outbox is inspectable and drainable from the Options
page rather than invisible.

The extension requires the `alarms` permission.

**Both clients implement this**, with the same policy — the same backoff, the
same bounds, the same reading of which failures may be retried — and each
platform's own durable mechanism: `chrome.storage.local` plus `chrome.alarms`
in Chrome, a JSON file in app-private storage plus WorkManager on Android.
WorkManager carries its own persistence across reboot and a network constraint,
so an Android device with no connectivity is not woken merely to fail; Chrome
has no equivalent and wakes on the schedule regardless.

The one deliberate divergence is how a drop is disclosed. Chrome notifies.
Android has no notification permission and asking for one to report a failure
is disproportionate, so every abandoned share is recorded and named in the app's
settings screen instead. Neither drops silently.

*Amended the same day this ADR was accepted: as first written, this section
said the Android target still discarded an unreachable share, which it did for
the few hours between the two changes.*
