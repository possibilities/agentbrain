# Architecture decision records

Numbered, append-only. A decision is revised by writing a new ADR, never by
editing an old one — so an ADR's text is what was true when it was written, not
necessarily what is true now. Read the chains below before trusting an old one.

## Supersession chains

- **0001 → 0003.** [0001](superseded/0001-agentbrain-owns-research-index.md)
  claimed the research index; [0003](0003-agentbrain-owns-durable-ingestion.md)
  replaced it with durable ingestion and moved 0001 to `superseded/`.
  [0002](0002-agentscrape-owns-url-extraction.md) refined the extraction half
  and still stands.
- **0011 → 0016.** [0011](0011-single-worker-source-scheduling.md) put source
  scheduling inside the worker;
  [0016](0016-external-source-trigger-contract.md) superseded its trigger
  portions with an external scheduler contract. The single-worker decision
  itself still stands.
- **0003 → 0014 (partial).** [0014](0014-agentbrain-database-namespace.md)
  supersedes only the database-location deferral in 0003.

## Records

| # | Decision |
|---|----------|
| [0002](0002-agentscrape-owns-url-extraction.md) | Agentscrape owns URL extraction |
| [0003](0003-agentbrain-owns-durable-ingestion.md) | Agentbrain owns durable ingestion |
| [0004](0004-durable-ingestion-job-lifecycle.md) | Durable ingestion job lifecycle |
| [0005](0005-public-ingestion-admission-contract.md) | Public ingestion admission contract |
| [0006](0006-conservative-resource-identity.md) | Conservative resource identity |
| [0007](0007-synchronous-agentscrape-extraction-contract.md) | Synchronous Agentscrape extraction contract |
| [0008](0008-content-addressed-artifact-storage.md) | Content-addressed artifact storage |
| [0009](0009-durable-source-fanout-and-checkpoints.md) | Durable source fanout and checkpoints |
| [0010](0010-legacy-recovery-import-contract.md) | Legacy recovery import contract |
| [0011](0011-single-worker-source-scheduling.md) | Single worker with source scheduling |
| [0012](0012-local-security-and-sensitive-ingestion.md) | Local security and sensitive ingestion |
| [0013](0013-structural-tag-derivation.md) | Structural tag derivation and the `retag` mutation |
| [0014](0014-agentbrain-database-namespace.md) | Agentbrain database namespace |
| [0015](0015-parser-derived-content-classification.md) | Persist parser-derived content classification |
| [0016](0016-external-source-trigger-contract.md) | External trigger contract for recurring Sources |
| [0017](0017-authenticated-share-ingress.md) | Authenticated share ingress for personal devices |
| [0018](0018-stranded-ingestion-is-reported.md) | Stranded ingestion is unhealthy and notifies the operator |
| [0019](0019-deletion-purges-the-resource.md) | Deletion purges the resource and redacts its locator |
| [0020](0020-client-share-outbox.md) | Device clients hold undelivered shares in a client outbox |
| [0021](0021-ingress-liveness-is-proved-not-assumed.md) | A share ingress proves it can serve, and exits when it cannot |
| [0001](superseded/0001-agentbrain-owns-research-index.md) | Agentbrain owns the research index — superseded |
