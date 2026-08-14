# Runbook: share ingress for Chrome and Android

One-tap link saving from a browser and a phone into the same durable ingestion
ledger the CLI uses. Decision record:
[ADR 0017](../adr/0017-authenticated-share-ingress.md). Wire format:
[share-ingest-v1](../contracts/share-ingest-v1.md).

## 1. Create the token

```bash
agentbrain share token init --json
agentbrain share token show --reveal      # print it again later
agentbrain share token path               # where it lives
```

The token is written `0600` under `~/.local/share/agentbrain/share-token`. It is
a real credential: anyone holding it can queue ingestion jobs from anywhere on
the tailnet. Rotate with `agentbrain share token init --force`, then update every
device — a rotation that misses one device leaves it silently unable to share.

## 2. Bind an address

```bash
tailscale ip -4          # e.g. 100.101.102.103
tailscale status --self  # MagicDNS name, e.g. mac-mini.tailnet-name.ts.net
```

Prefer the MagicDNS name: the bundled Android network config already permits
cleartext to `*.ts.net`, and the name survives address changes.

```bash
agentbrain share serve                                    # 127.0.0.1, the default
agentbrain share serve --host 100.101.102.103 --port 8787 # accept device shares
```

The default bind is `127.0.0.1`; you must name the tailnet address to accept
device shares. Binding `0.0.0.0` additionally requires `--allow-any-interface`,
which is refused by default on purpose.

Port precedence is `--port`, then `PORT`, then 8787. `PORT` exists so a
supervisor that allocates a free port can hand one over; 8787 is what every
device client is configured against. A `PORT` outside 1–65535 is refused rather
than quietly falling back, because a supervisor that asked for one port and got
another would forward to a socket nothing is listening on.

`GET /v1/health` and `POST /v1/share` both require `Authorization: Bearer
<token>`; the wire format is in
[share-ingest-v1](../contracts/share-ingest-v1.md). A first POST returns
`"status":"queued"`, and repeating it returns `"status":"duplicate"` with the
same `job_id` — re-sharing is safe, not additive.

### Running it resident

The ingress is a separate long-running process from the Worker. Its LaunchAgent
belongs to AgentStart, which owns every fleet service, and it is installed only
when you name the address to bind:

```bash
AGENTSTART_INSTALL_SHARE_HOST=100.101.102.103 \
  ~/code/agentstart/scripts/install-launchagents --install
```

On this machine the address is normally discovered for you, from `tailscale ip
-4`, so naming it explicitly is only needed off the tailnet.

Naming the address is the whole point: ADR 0017 admits no configuration in which
the ingress is exposed by default, so an unset variable installs no listener at
all. An unset variable on a later run leaves an ingress you already asked for
alone; removing one is the explicit `AGENTSTART_INSTALL_SHARE_HOST=none`.
`0.0.0.0`, `::`, and addresses carrying shell or option syntax are refused before
anything is written, rather than by a service that starts, is refused, and is
restarted forever by `KeepAlive`.

The token is never written into the service description. The ingress reads the
`0600` token file as usual, so `launchctl print` discloses how to reach the
listener but not how to authenticate to it.

A share is durable the moment it is admitted. Materialization still waits for
the resident Worker, so run both.

### Named URLs for desktop development

`bun run dev:share` is `agentbrain share serve --portless`: it runs the server
behind the Portless proxy under a name derived from the checkout's absolute
path, so two worktrees that both want 8787 each get a stable
`https://<name>.localhost` instead of one losing. The derived name survives a
branch rename and a detached HEAD, which Portless's own inferred name does not;
`AGENTBRAIN_PORTLESS_NAME` overrides it when two *clones* collide.

Portless is a machine prerequisite, not a package dependency (`npm i -g
portless`, Node ≥ 24); without it `dev:share` exits `portless_unavailable`
rather than starting an unnamed server, and Agentbrain never installs it, starts
its daemon, or touches the trust store. Security is unchanged: every route still
requires the bearer token, the bind is still `127.0.0.1`, and `--portless` is
refused alongside `--port` (Portless allocates it and passes it in `PORT`) or a
non-loopback `--host`. A `.localhost` name is loopback-only by RFC 6761, so it
can never receive a share from a device — phones use the tailnet address.

## 3. Install the Chrome extension

Load `clients/chrome/` unpacked from `chrome://extensions` with Developer mode
on, then in its Options enter the server URL and token and click **Save & grant
access**. The extension requests permission for that one origin rather than
declaring broad host access up front, so skipping the prompt leaves it unable to
reach the server. Send from the toolbar button, the right-click menu, or
`Ctrl+Shift+S`; a selection is sent as text, so the server extracts a URL from
it when there is one.

- **The shortcut may arrive unassigned.** Chrome does not override an existing
  binding, and a collision leaves the command with no key. Rebind at
  `chrome://extensions/shortcuts`. `Ctrl+Alt` combinations are not permitted.
- **There is no Chrome extension platform on Android** — which is precisely why
  the Android share target exists. On desktop the extension works in any
  Chromium browser that loads MV3 unpacked.
- **`chrome://` pages and the Web Store cannot be shared**; the extension
  refuses them rather than queueing a job that would fail later.

### Sharing while the ingress is down

A share taken when the server is unreachable is **held on the device**, not
lost, and redelivered on a backoff (one minute, then two, five, fifteen, thirty,
then hourly) until the ingress admits it. The toolbar badge shows an amber count
of what is waiting, and the Options page lists it with **Send now** and
**Discard held shares**. Delivery also retries when Chrome restarts, after any
successful share, and after a successful **Test connection**. Decision record:
[ADR 0020](../adr/0020-client-share-outbox.md).

Held is not saved: nothing exists in Agentbrain until the ingress admits it, so
a held share has no job id and will not appear in `agentbrain jobs list`.
Redelivery needs no idempotency key — a share the server did receive before the
connection dropped comes back as `duplicate` with the same job.

The outbox holds 200 shares for 7 days. Past either bound the oldest are dropped
with a notification, as is a payload the ingress rejects outright — a 4xx other
than 401 means the payload is wrong and resending it unchanged cannot help. A
401 keeps retrying, so fixing the token drains what accumulated meanwhile.

The Android share target holds shares the same way; see below.

## 4. Install the Android share target

```bash
cd clients/android
./gradlew :app:installDebug     # requires the Android SDK and a connected device
```

Use the checked-in `./gradlew`, which pins Gradle 8.7, rather than a system
`gradle`: AGP 8.5.2 does not accept the Gradle 9 line Homebrew currently
installs. The build also needs JDK 17 and SDK Platform 34 with Build-Tools
34.0.0. See [the client README](../../clients/android/README.md) for the full
matrix. A device across the tailnet works as well as a cabled one via
`adb connect`.

Open **Agentbrain Share**, enter the same server URL and token, and press **Test
connection**. "Share → Agentbrain" then appears in any app that shares
`text/plain`.

- **Cleartext HTTP** is blocked by Android unless permitted. The bundled
  `network_security_config.xml` permits it for `*.ts.net` MagicDNS names.
  Addressing the server by raw tailnet IP means adding that literal and
  rebuilding; HTTPS avoids the issue entirely.
- **The token is stored in `EncryptedSharedPreferences`**, not plain prefs.

### Sharing from Android while the ingress is down

Same policy as Chrome — held on the device, redelivered on the same backoff,
bounded at 200 shares and 7 days — carried by WorkManager, which persists its
queue across a reboot and waits for a network rather than waking without one. A
share is written to the outbox *before* it is attempted, so killing the app the
instant the share sheet dismisses cannot lose it.

The toast says **held**, not saved, and names how many are waiting. Open
**Agentbrain Share** to see the count, force a round with **Send now**, or drop
what is held. Anything the app gives up on — expired, evicted, or rejected
outright — is listed by name under "Not delivered" there. Android has no
notification permission in this app, so that screen is where a loss is
disclosed; nothing is dropped silently.

**Held is not saved.** A held share has no job id and will not appear in
`agentbrain jobs list` until the ingress admits it.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `unauthorized` / 401 | Token mismatch | Re-copy from `share token show --reveal`; confirm you rotated every device |
| Client says "cannot reach" | Ingress not running, wrong host, or tailnet down | `tailscale status`; confirm `share serve` is bound to the tailnet address, not `127.0.0.1` |
| Chrome badge shows an amber number | Shares are held, undelivered | Bring the ingress up; press **Send now** in Options to stop waiting for the backoff |
| A held Chrome share never arrives | Token rejected, or the ingress stayed down | Options → **Test connection**; a held share is abandoned after 7 days |
| Android reaches nothing but curl works | Cleartext blocked | Add the host to `network_security_config.xml`, or use the MagicDNS name |
| Chrome shortcut does nothing | Unassigned due to a conflict | Rebind at `chrome://extensions/shortcuts` |
| Extension errors with a permission message | Host permission not granted | Reopen Options and click **Save & grant access** |
| Share succeeds but nothing is searchable | Worker not running, or extraction failed | `agentbrain jobs list --state failed --json`; check the Worker and that `agentscrape` is on its `PATH` |
| Everything returns `duplicate` | Working as intended | The intent is already queued; check `agentbrain jobs show <id> --json` |
| `EADDRINUSE` on 8787 | Another checkout already holds the port | `bun run dev:share`, or pass `--port` |
| A phone shows "Held to send later" | Ingress unreachable when shared | It is not lost; open Agentbrain Share and press **Send now** once the ingress is up |
| A phone cannot reach the `.localhost` URL | Working as intended | `.localhost` is loopback-only; devices use the tailnet address |
