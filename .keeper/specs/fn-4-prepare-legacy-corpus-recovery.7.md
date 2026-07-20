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
Pollution channel named with evidence: there is NO in-process jobs-cli test pollution. The full-suite-only failures were external checkout mutation — a lane 'reset: moving to HEAD' landing MID-TEST-RUN (17:45:39, between resolver steps 17:44:55-17:46:10), swapping merged schema-v7 source back to HEAD's v6 and producing the exact 'research cache schema version 7 is newer than supported version 6' failure. Controlled causality probe: v7 parent/v7 child exits 0; v7 parent + on-disk reset to v6 makes the child exit 1 with that error. On an immutable merged reconstruction (both suites co-resident) all four jobs-cli suites passed 3/3 full-suite runs, chunking-then-jobs 10/10, isolation 5/5 + 5/5. No test changes needed or made (changing tests would mask checkout mutation). Root cause is the lane-reset defect fn-1379-hold-live-lanes-against-resets owns (#72); this diagnosis retires the in-process-pollution hypothesis.
## Evidence
