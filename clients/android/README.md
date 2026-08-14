# Agentbrain Share (Android)

A share target: any app that can share `text/plain` can send a link or a note to
Agentbrain.

Install and configure: [`docs/runbooks/share-ingress.md`](../../docs/runbooks/share-ingress.md).

## Files

| File | Role |
| --- | --- |
| `SharePayload.kt` | Wire payload plus `ShareIntentParser` — pure, JVM-testable |
| `ShareActivity.kt` | The share target; no UI, finishes immediately |
| `ShareClient.kt` | `HttpURLConnection` transport, no third-party dependency |
| `ShareOutbox.kt` | Durable hold and delivery policy for undelivered shares — takes a `File`, so JVM-testable |
| `ShareScheduler.kt` / `ShareUploadWorker.kt` | WorkManager wake-up and one delivery round |
| `Settings.kt` | Server URL and token in `EncryptedSharedPreferences` |
| `SettingsActivity.kt` | Setup screen, connection test, and the outbox |
| `res/xml/network_security_config.xml` | Cleartext policy for tailnet hosts |

## Offline shares

A share the ingress cannot accept is written to `share-outbox.json` in
app-private storage **before** it is attempted — the process can be killed the
moment the share sheet dismisses — and redelivered on a backoff until the server
admits it. WorkManager carries the wake-up: it persists across reboot and
constrains the round to `NetworkType.CONNECTED`, so a device with no
connectivity is not woken merely to fail.

Held is not saved: no Agentbrain job exists until the ingress admits the
payload, so the toast says held and names the count. Bounded at 200 shares and 7
days; anything abandoned is named under "Not delivered" in the settings screen,
because this app holds no notification permission to report it any other way.

[ADR 0020](../../docs/adr/0020-client-share-outbox.md) is the decision;
`ShareOutboxTest` covers the policy.

The token stays in `EncryptedSharedPreferences` and is never written to the
outbox, which holds only what the user chose to send to their own index.

## What the client decides

Two things: whether `EXTRA_TEXT` is a bare URL (sent as `url`) or anything else
(sent as `text`), and when to try again a share the server has not accepted.
Recovering a URL from prose is the server's job, so the rules live in one place
and are tested once. See
[`docs/contracts/share-ingest-v1.md`](../../docs/contracts/share-ingest-v1.md).

`EXTRA_SUBJECT` becomes the title when it is present and differs from the body.

## Build

```bash
./gradlew :app:installDebug   # requires the Android SDK
./gradlew :app:testDebugUnitTest
```

Minimum SDK 26, target 34.

### Toolchain

The Gradle wrapper is checked in and pins **Gradle 8.7**. Build through
`./gradlew`, not a system `gradle`: AGP 8.5.2 requires Gradle 8.7 or newer but
is not compatible with the Gradle 9 line, so a current Homebrew `gradle` fails
this project. The pin is the point of the wrapper — generating one with a
system Gradle 9 reproduces the incompatibility it exists to prevent.

| Component | Required |
| --- | --- |
| Gradle | 8.7 (wrapper-pinned) |
| Android Gradle Plugin | 8.5.2 |
| JDK | 17 |
| SDK Platform | 34 (`compileSdk`/`targetSdk`) |
| Build-Tools | 34.0.0 |

With the command-line tools installed, the two SDK components come from
`sdkmanager "platforms;android-34" "build-tools;34.0.0"`.
