## Description

Fixes finding F1 (folding in TG4). In src/worker.ts applyDocuments, the
foreign-owner merge branch (documentOwner is a different Resource than
recoveryResource) sets `resource = { id: documentOwner.id }` so the
materialized document lives under documentOwner, but
`firstResourceId = recoveryResource?.id ?? resource.id` (worker.ts:648)
resolves to recoveryResource.id, which in this branch is never assigned a
document_id. worker.ts:819-822 then writes that resource_id back onto the
job, so a downstream job->resource->document resolution returns NULL for
candidates that collided on document content. Confirm whether
candidate-identity continuity is intended; if not, set
`firstResourceId = resource.id` in the merge branch. Either way add the
regression test TG4 asks for, asserting the job->resource->document link
after a foreign-owner (cross-candidate content collision) merge.

Files: src/worker.ts, test/worker.test.ts (or test/recovery.test.ts).

## Acceptance

- [ ] job->resource->document resolves to the materialized document after a foreign-owner merge, or the candidate-identity-continuity divergence is documented as intended.
- [ ] Regression test asserts the job->resource->document link after a cross-candidate content collision.

## Done summary
Fixed the foreign-owner merge branch in applyDocuments to set firstResourceId = resource.id (the document-owning resource) instead of recoveryResource.id, restoring job->resource->document resolution after a cross-candidate content collision merge; added a regression test asserting the full link.
## Evidence
