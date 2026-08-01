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
| `Settings.kt` | Server URL and token in `EncryptedSharedPreferences` |
| `SettingsActivity.kt` | Setup screen and connection test |
| `res/xml/network_security_config.xml` | Cleartext policy for tailnet hosts |

## What the client decides

Only one thing: whether `EXTRA_TEXT` is a bare URL (sent as `url`) or anything
else (sent as `text`). Recovering a URL from prose is the server's job, so the
rules live in one place and are tested once. See
[`docs/contracts/share-ingest-v1.md`](../../docs/contracts/share-ingest-v1.md).

`EXTRA_SUBJECT` becomes the title when it is present and differs from the body.

## Build

```bash
./gradlew :app:installDebug   # requires the Android SDK
./gradlew :app:testDebugUnitTest
```

No Gradle wrapper is checked in. Generate one with `gradle wrapper`, or open
this directory in Android Studio.

Minimum SDK 26, target 34.
