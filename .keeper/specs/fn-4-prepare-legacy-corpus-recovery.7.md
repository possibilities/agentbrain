## Description

**Size:** S
**Files:** test/jobs-cli.test.ts, test/chunking.test.ts

### Approach

Four jobs-cli suites (redaction of intent bodies/unsafe URLs, Artifact
reveal + inspection audit, jobs stats content-safety, operator-command
audits) fail in full-suite order once the structural-chunking suite
exists, yet pass 4/4 in isolation on the same tree — order-dependent
shared state landing on content-safety guards. Diagnose the pollution
channel (module state, tmp/db reuse, global config bleed), fix it at the
source (isolate the leaking state, never reorder or waive tests), and
prove full-suite green. Reproduce on the epic base lane, which carries
both suites.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- test/jobs-cli.test.ts:98 — the first failing exit (runCli jobs list --json exits 1 full-suite-only)
- test/chunking.test.ts — the suite whose presence triggers the order dependence

### Risks

- The guards involved are content-safety posture; a wrong fix that masks rather than isolates weakens redaction coverage

### Test notes

Full-suite runs prove the fix; isolation runs stay green; baselines: pre-chunking tree full-suite green, merged tree 5 fail (4 here + the schema pin).

## Acceptance

- [ ] The pollution channel is named with evidence in the Done summary
- [ ] All four jobs-cli suites pass in full-suite order with the chunking suite present, without test reordering or waivers
- [ ] Isolation runs remain green

## Done summary

## Evidence
