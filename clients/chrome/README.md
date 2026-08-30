# Agentbrain Share (Chrome MV3)

Sends the current page, a right-clicked link, or a selection to the Agentbrain
share ingress.

Install and configure: [`docs/runbooks/share-ingress.md`](../../docs/runbooks/share-ingress.md).

## Files

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest: action, context menus, one named command |
| `background.js` | Service worker; the only place that decides what to send |
| `shared.js` | Config, permission checks, the POST transport, retry classification |
| `outbox.js` | Durable hold and redelivery of shares the ingress has not accepted |
| `history.js` / `status.js` | Bounded local recent history and its display states |
| `popup.html` / `popup.js` | Recent-share popover and its send/remove controls |
| `options.html` / `options.js` | Server URL, token, host-permission grant, health check, outbox |

## Offline shares

A share the ingress cannot accept right now is held in `chrome.storage.local`
and redelivered on a backoff driven by one `chrome.alarms` wake, plus service
worker startup, any successful share, and the Options page. Held is not saved:
no Agentbrain job exists until the ingress admits the payload, so nothing in the
outbox may be reported as queued. [ADR
0020](../../docs/adr/0020-client-share-outbox.md) is the decision;
`test/chrome-outbox.test.js` covers the delivery policy under `bun test`.

## Permissions

`optional_host_permissions` is used rather than a declared `host_permissions`
entry: the server address is user-configured, so the extension requests access
to that one origin from the Options page (a user gesture) instead of asking for
broad host access at install time.

`contextMenus`, `storage`, `notifications`, `activeTab`, and `alarms` are the
only declared permissions. `alarms` exists for outbox redelivery: an MV3 service
worker is torn down between events, so a timer cannot survive to retry.

## The popover

`action.default_popup` is `popup.html`: the toolbar button opens the share
history rather than sharing immediately. Chrome gives an action either an
`onClicked` listener or a popup, never both, so **Send this page** is the
popover's first control and `Ctrl+Shift+S` still shares without opening it.

`history.js` keeps the last 20 outcomes in `chrome.storage.local`, keyed by
outbox entry id so a share that was held and later delivered stays one row.
`status.js` derives what each row reads as; the ledger's word outranks the
client's memory of delivery, and nothing held is ever called saved. The popover
refreshes on `storage.onChanged` and polls `GET /v1/shares` every three seconds
while it is open — never in the background, where nobody is looking.

Each row can be removed from the local recent list, and **Clear list** removes
all visible rows. This does not cancel a held share or delete an admitted
Agentbrain Resource. A manually removed held row stays hidden when that share
is later delivered instead of reappearing.

## Keyboard shortcut

`Ctrl+Shift+S`, or `Command+Shift+S` on macOS, declared as a named command so it
appears with a description at `chrome://extensions/shortcuts`.

Chrome will not override an existing browser or extension binding, so a
collision leaves the command unassigned — rebind it there. Chrome assigns at
most four suggested shortcuts per extension; this one declares a single command.

Chrome for Android has no extension platform; use the Android share target
instead.
