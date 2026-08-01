# Agentbrain Share (Chrome MV3)

Sends the current page, a right-clicked link, or a selection to the Agentbrain
share ingress.

Install and configure: [`docs/runbooks/share-ingress.md`](../../docs/runbooks/share-ingress.md).

## Files

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest: action, context menus, one named command |
| `background.js` | Service worker; the only place that decides what to send |
| `shared.js` | Config, permission checks, and the POST transport |
| `options.html` / `options.js` | Server URL, token, host-permission grant, health check |

## Permissions

`optional_host_permissions` is used rather than a declared `host_permissions`
entry: the server address is user-configured, so the extension requests access
to that one origin from the Options page (a user gesture) instead of asking for
broad host access at install time.

`contextMenus`, `storage`, `notifications`, and `activeTab` are the only
declared permissions.

## Keyboard shortcut

`Ctrl+Shift+S`, or `Command+Shift+S` on macOS, declared as a named command so it
appears with a description at `chrome://extensions/shortcuts`.

Chrome will not override an existing browser or extension binding, so a
collision leaves the command unassigned — rebind it there. Chrome assigns at
most four suggested shortcuts per extension; this one declares a single command.

Chrome for Android has no extension platform; use the Android share target
instead.
