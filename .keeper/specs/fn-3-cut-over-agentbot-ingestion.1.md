## Description
**Size:** S
**Files:** src/behaviors/save-links.ts, test/behavior_core.test.ts

### Approach

THE FIX IS NOT ON THE LANE YET — the existing lane commit (87e27fb, the original cutover) is BROKEN and a prior worker wrongly re-marked this task done by trusting it. Do not repeat that: the close audit fatal-halted twice on this exact defect. Two surgical changes in src/behaviors/save-links.ts: (1) the agentbrain submit argv MUST include --json (without it agentbrain emits human output and the parse throws); (2) the success/duplicate status and metadata live under the JSON envelope's data field — parse payload.data.status, not payload.status. Update the argv-asserting tests to match. Before running keeper plan done: verify `grep -- --json src/behaviors/save-links.ts` hits, run the behavior test suite, and commit via keeper commit-work — a done-mark with empty commit evidence will be treated as failure by the supervisor.
## Acceptance
- [ ] Agentbot invokes only the installed Agentbrain CLI for saved-link admission.
- [ ] The agentbrain submit argv includes --json, and the behavior parses status/metadata from the JSON envelope's data field (not top level) — the close-audit fatal found every invocation throwing on the human-output default.
- [ ] Queued and duplicate URLs both produce successful user acknowledgement and correct metadata counts.
- [ ] Malformed, incompatible, or failed Agentbrain output fails the behavior clearly without claiming the URL was saved.
- [ ] Tests assert exact argv (including --json) and the data-field envelope shape, and require no live Telegram, Agentbrain database, Scrapectl, or network.
- [ ] Agentbot documentation contains no live Linkctl dependency.
## Done summary
Fixed the broken Agentbrain submit contract in save-links: added --json to the CLI argv and parse status/metadata from payload.data instead of top-level payload; hardened against malformed envelopes; updated tests and docs accordingly.
## Evidence
