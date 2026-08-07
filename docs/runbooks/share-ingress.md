# Runbook: share ingress for Chrome and Android

Sets up one-tap link saving from a browser and a phone into the same durable
ingestion ledger the CLI uses. Decision record:
[ADR 0017](../adr/0017-authenticated-share-ingress.md). Wire format:
[share-ingest-v1](../contracts/share-ingest-v1.md).

## 1. Create the token

On the machine that owns the database:

```bash
agentbrain share token init --json
agentbrain share token show --reveal      # print it again later
agentbrain share token path               # where it lives
```

The token is written `0600` under `~/.local/share/agentbrain/share-token`. It is
a real credential: anyone holding it can queue ingestion jobs from anywhere on
the tailnet. Rotate with `agentbrain share token init --force`, then update every
device.

## 2. Find the tailnet address

```bash
tailscale ip -4          # e.g. 100.101.102.103
tailscale status --self  # MagicDNS name, e.g. mac-mini.tailnet-name.ts.net
```

Prefer the MagicDNS name: the bundled Android network config already permits
cleartext to `*.ts.net`, and the name survives address changes.

## 3. Start the ingress

```bash
# Local only (default) — useful for a first smoke test.
agentbrain share serve

# Accept shares from your devices.
agentbrain share serve --host 100.101.102.103 --port 8787
```

The default bind is `127.0.0.1`; you must name the tailnet address to accept
device shares. Binding `0.0.0.0` additionally requires `--allow-any-interface`,
which is refused by default on purpose.

Verify:

```bash
TOKEN=$(agentbrain share token show --reveal)
curl -sS -H "Authorization: Bearer $TOKEN" http://100.101.102.103:8787/v1/health

curl -sS -X POST http://100.101.102.103:8787/v1/share \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"client":"chrome-extension","url":"https://example.com/post"}'
```

The first POST returns `"status":"queued"`; repeating it returns
`"status":"duplicate"` with the same `job_id`.

### Running it resident

The ingress is a separate long-running process from the Worker. To keep it up
across logins on macOS, install a LaunchAgent alongside `agentbrain.worker`,
modeled on `system/Library/LaunchAgents/agentbrain.worker.plist`, whose
`ProgramArguments` are the absolute `agentbrain` path plus
`share serve --host <tailnet-ip>`. Keep `Umask 63` so any state it writes stays
owner-only.

A share is durable the moment it is admitted. Materialization still waits for
the resident Worker, so run both.

### Choosing the port

`--port`, then `PORT`, then 8787. The flag is highest precedence; `PORT` is
there so a supervisor that allocates a free port can hand one over; 8787 is the
direct default every device client is configured against, so leave it alone
unless you have a reason. A `PORT` that is not an integer in 1–65535 is refused
rather than quietly falling back, because a supervisor that asked for one port
and got another would forward to a socket nothing is listening on.

### Named URLs for desktop development

**This section is for working on Agentbrain on the machine itself. It does not
apply to phones, and it does not replace anything above.** A `.localhost` name
resolves only on the machine that serves it — RFC 6761 reserves the whole suffix
for loopback — so it cannot receive a share from a device. Devices continue to
use the tailnet address from step 2.

Two checkouts both want 8787, and the second one loses. To give each checkout a
stable URL of its own instead:

```bash
bun run dev:share            # → https://<name>.localhost
agentbrain share serve       # the direct path, unchanged, on 127.0.0.1:8787
```

`dev:share` is `agentbrain share serve --portless`. It re-runs the command
behind the `portless` CLI in *direct named mode* (`portless --name <name> --
<command>`), passing a name derived from the checkout's absolute path: the
directory name plus six hex of that path. That name identifies the worktree and
only the worktree, so it survives a branch rename and a detached HEAD, and two
sibling worktrees can never land on the same URL. Portless's own inferred name
would not: it comes from the branch's last segment and is withheld entirely for
a detached HEAD, which is the usual state of an Orca worktree. Override the
derived name with `AGENTBRAIN_PORTLESS_NAME` — two clones of the repository, as
opposed to two worktrees of one, are both main checkouts and would otherwise
share a name.

Portless is a **machine prerequisite**, not a dependency of this package:
`npm i -g portless`, Node ≥ 24. Without it `dev:share` exits with
`portless_unavailable` and tells you so, rather than starting an unnamed server
under a command that promised a name. Installing and first running it is the
operator's decision: serving over HTTPS generates a local CA and offers to add
it to the trust store, and it runs a resident proxy. Agentbrain neither installs
it, starts its daemon, nor touches the trust store, and still binds exactly one
listener of its own — the proxy is separate software in front of it.

Nothing about the ingress's security changes: every route still requires the
bearer token, the bind is still `127.0.0.1`, and `--portless` is refused
alongside `--port` (Portless allocates the port and passes it in `PORT`) or a
non-loopback `--host` (a `.localhost` name cannot front a tailnet address).

## 4. Install the Chrome extension

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select `clients/chrome/`.
3. Open the extension's **Options**, enter the server URL
   (`http://100.101.102.103:8787` or the MagicDNS equivalent) and the token,
   then click **Save & grant access** and accept the host-permission prompt.
   The extension requests permission for that one origin rather than declaring
   broad host access up front.
4. Click **Test connection**.

Three ways to send, all going through the same endpoint:

- **Toolbar button** — sends the current tab.
- **Right-click** — "Send this page/link/selection to Agentbrain". A selection is
  sent as text, so the server extracts a URL from it when there is one.
- **Keyboard** — `Ctrl+Shift+S` (`Command+Shift+S` on macOS).

The badge flashes `OK` for a new save, `DUP` for one Agentbrain already had, and
`ERR` with a notification carrying the reason.

### Platform limitations

- **The shortcut may arrive unassigned.** Chrome does not override an existing
  browser or extension binding, and a collision leaves the command with no key.
  Check and rebind at `chrome://extensions/shortcuts`. Chrome also assigns at
  most four suggested shortcuts per extension; this extension declares one.
  `Ctrl+Alt` combinations are not permitted by Chrome.
- **There is no Chrome extension platform on Android.** Chrome for Android does
  not support extensions at all, which is precisely why the Android share target
  exists. On desktop the extension works in Chrome and other Chromium browsers
  that load MV3 unpacked (Edge, Brave, Vivaldi).
- **`chrome://` pages, the Web Store, and other privileged pages cannot be
  shared**; the extension refuses them rather than queueing a job that would
  fail later.
- The extension is loaded unpacked, so Chrome shows a developer-mode notice on
  each launch. Packing it into a `.crx` or publishing privately would remove
  that but is not required.

## 5. Install the Android share target

Build and install:

```bash
cd clients/android
./gradlew :app:installDebug     # requires the Android SDK and a connected device
```

Use the checked-in `./gradlew`, which pins Gradle 8.7, rather than a system
`gradle`: AGP 8.5.2 does not accept the Gradle 9 line that Homebrew currently
installs. The build also needs JDK 17 and SDK Platform 34 with Build-Tools
34.0.0 — `sdkmanager "platforms;android-34" "build-tools;34.0.0"`. See
[the client README](../../clients/android/README.md) for the full matrix.

A device on the far side of the tailnet works as well as a cabled one:
`adb connect <tailnet-ip>:<port>`, taking the port from the phone's
**Wireless debugging** screen, which reassigns it on each toggle.

Then open **Agentbrain Share**, enter the same server URL and token, and press
**Test connection**.

Now "Share → Agentbrain" appears in any app that shares `text/plain`, which in
practice is nearly everything: Chrome, Firefox, Reddit, Mastodon, YouTube,
podcast apps, and plain notes.

### Platform notes

- **Cleartext HTTP** is blocked by Android unless permitted. The bundled
  `network_security_config.xml` permits it for `*.ts.net` MagicDNS names. If you
  address the server by a raw tailnet IP, add that literal to that file and
  rebuild. Serving over HTTPS avoids the issue entirely.
- **The token is stored in `EncryptedSharedPreferences`**, not plain prefs.
- Sharing shows a toast and dismisses immediately; the outcome arrives as a
  second toast once the server answers.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `unauthorized` / 401 | Token mismatch | Re-copy from `share token show --reveal`; confirm you rotated every device |
| Client says "cannot reach" | Ingress not running, wrong host, or tailnet down | `tailscale status`; confirm `share serve` is bound to the tailnet address, not `127.0.0.1` |
| Android reaches nothing but curl works | Cleartext blocked | Add the host to `network_security_config.xml`, or use the MagicDNS name |
| Chrome shortcut does nothing | Unassigned due to a conflict | Rebind at `chrome://extensions/shortcuts` |
| Extension errors with a permission message | Host permission not granted | Reopen Options and click **Save & grant access** |
| Share succeeds but nothing is searchable | Worker not running, or extraction failed | `agentbrain jobs list --state failed --json`; check the Worker and that `agentscrape` is on its `PATH` |
| Everything returns `duplicate` | Working as intended | The intent is already queued; check `agentbrain jobs show <id> --json` |
| `EADDRINUSE` on 8787 | Another checkout already holds the port | Use `bun run dev:share` for a named URL of this checkout's own, or pass `--port` |
| `dev:share` fails with `portless_unavailable` | Portless is not installed | `npm i -g portless` (Node ≥ 24), or use `agentbrain share serve` directly |
| A phone cannot reach the `.localhost` URL | Working as intended | `.localhost` is loopback-only; devices use the tailnet address from step 2 |

Inspect what arrived:

```bash
agentbrain jobs list --json
agentbrain jobs stats --json
agentbrain search "some phrase" --collection saved-links --json
```
