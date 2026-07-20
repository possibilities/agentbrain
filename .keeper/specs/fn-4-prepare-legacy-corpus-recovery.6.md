## Description

**Size:** M
**Files:** ~/.local/share/agentbrain/recovery/tools/scan_agentbot_secretary_live.ts, ~/.local/share/agentbrain/recovery/tools/build_agentbot_secretary_link_index.py, ~/.local/share/agentbrain/recovery/telegram/, ~/.local/share/agentbrain/recovery/manifests/, ~/.local/share/agentbrain/recovery/SHA256SUMS, ~/docs/agentbrain-telegram-link-recovery-summary-2026-07-18.json

### Approach

Treat the completed body-free Agentbot database scan and bounded live Secretary pass as immutable inputs, not an invitation to contact Telegram again. Validate their hashes, permissions, fixed upper cutoff, hard caps, and `history_exhausted` marker; then deterministically union observations, preserve the original 1,075 candidate IDs, append 13 exact-URI IDs, and atomically publish a hash-addressed 1,088-candidate generation, an immutable online allowlist containing exactly the two approved opaque candidate evidence row IDs, and a safe count-only summary. Exact DM submission is normal saved-link ingress; only message/session metadata remains private unless a URL is intrinsically sensitive.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `~/.local/share/agentbrain/recovery/tools/scan_agentbot_secretary_live.ts:24-245` — cutoff, hard-cap, body-free extraction, and completion metadata.
- `~/.local/share/agentbrain/recovery/tools/build_agentbot_secretary_link_index.py:127-450` — private atomic writes, observation union, disposition policy, and count/hash summary.
- `~/.local/share/agentbrain/recovery/telegram/secretary-link-summary-2026-07-18.json:1` — verified count-only input and file hashes.
- `docs/adr/0010-legacy-recovery-import-contract.md:13-35` — locked 1,088-candidate/cohort contract.
- `docs/adr/0012-local-security-and-sensitive-ingestion.md:14-27` — transport privacy and redaction boundary.

**Optional** (reference as needed):
- `~/docs/agentbrain-recovery-manifest-2026-07-15.jsonl:1` — immutable baseline candidate generation.
- `~/.local/share/agentbrain/recovery/SHA256SUMS:1` — protected fixity inventory.

### Risks

A moving Telegram window, overwritten input, candidate-ID churn, aggressive normalization, mixed-generation publication, wrong permissions, or leaked identifiers can make the result incomplete or unsafe. Exact URLs may themselves contain sensitive values even though DM transport alone is not sensitive.

### Test notes

Use small synthetic SQLite/JSONL fixtures to prove active and soft-deleted rows, hidden entity URLs, live/DB overlap, live-only evidence, exact versus comparison collisions, deterministic ordering, interrupted publication, wrong mode/hash, and balanced dispositions. Tests must not load the real session, database, index, URLs, Keychain, Telegram, Scrapectl, or network.

### Detailed phases

1. Verify the captured live cutoff/termination, input hashes, modes, schemas, and absence of retained session working copies.
2. Define one body-free observation per exact URL and message locator, union DB/live evidence, and preserve exact URL identity separately from comparison forms.
3. Merge 118 provenance matches without changing disposition; append 13 deterministic candidates split into six test exclusions, two approved-online human submissions, and five bot-output reviews.
4. Bind the generation digest and exactly the two approved opaque candidate evidence row IDs into a private immutable online allowlist; reject duplicate, missing, extra, or wrong-disposition entries.
5. Stage manifest, allowlist, inventory, private reconciliation, and public count-only summary under one generation ID; verify every balance and checksum before atomic publication.

### Alternatives

Re-running live Telegram later is rejected because the captured pass is complete through a fixed cutoff. Importing raw Agentbot rows is rejected because message bodies and unnecessary identifiers are not recovery content.

### Non-functional targets

Offline after capture, deterministic, streaming/bounded, atomic, idempotent, `0700` directories, `0600` private files, no exact URL or raw identifier in ordinary output, and byte-identical output for identical inputs.

### Rollout

Preserve the baseline manifest and current private evidence unchanged. Publish a new generation only after full validation; on any mismatch retain the last complete generation and stop downstream work.

## Acceptance

- [ ] The authoritative live input proves a fixed upper cutoff, 20,000-message and ten-minute hard caps, natural history exhaustion, 119 visible messages, and no retained credential-bearing session copy.
- [ ] Reconciliation proves 294 message-level URL observations, 131 exact URLs, 118 provenance merges, 13 exact-new candidates, eight comparison-new URLs, and one live-only URL without printing private locators or exact URLs.
- [ ] All original 1,075 candidate IDs and dispositions remain stable; 13 collision-free deterministic IDs produce exactly 1,088 candidate outcomes regardless of comparison-URI convergence.
- [ ] The 13 additions reconcile as six probable-test exclusions, two approved controlled-online human submissions, and five bot-output review candidates; no item is fetched in this epic.
- [ ] A private immutable online allowlist binds the generation digest to exactly two distinct approved human candidate evidence row IDs; any duplicate, missing, extra, or wrong-disposition entry fails generation publication.
- [ ] Human Secretary submissions and resulting public resources remain normal sensitivity unless the URL or explicit policy is sensitive; message bodies, credentials, sessions, and unnecessary Telegram identifiers never enter the generation or public summary.
- [ ] A generation ID binds input hashes, cutoff metadata, candidate manifest, private reconciliation, count-only summary, tool/schema versions, and checksum inventory; interrupted generation cannot replace the last complete pointer.
- [ ] Synthetic validation is deterministic and offline, and all frozen private files verify as `0600` beneath `0700` directories.

## Done summary
Verified the frozen live-scan/DB-scan inputs and published a hash-addressed 1,088-candidate recovery generation (sha256-c16991f1...) under ~/.local/share/agentbrain/recovery/manifests/, with 118 provenance merges, 13 deterministic new candidates split into 6 test-exclusions/2 approved-online/5 bot-review, a private allowlist binding exactly the 2 approved candidate evidence row IDs, and a count-only public summary at ~/docs/agentbrain-telegram-link-recovery-summary-2026-07-18.json. All numbers match ADR 0010's locked contract; no repo-tracked files changed, so no source commit was required.
## Evidence
