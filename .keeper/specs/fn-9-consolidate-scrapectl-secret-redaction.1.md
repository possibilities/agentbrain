## Description

Source finding: F3 (audit of fn-2-integrate-queued-url-extraction). Evidence path:
apps/scrapectl/scrapectl/handlers/x.py:306-347 (`_EXTRACTION_SENSITIVE_QUERY_TOKENS`,
`_EXTRACTION_SENSITIVE_QUERY_NAMES`, `_EXTRACTION_SENSITIVE_COMPACT_NAMES`,
`_EXTRACTION_JWT_RE`, `_extraction_query_is_sensitive`) and
apps/scrapectl/scrapectl/run_fetch_markdown.py:21-73 (`_SENSITIVE_NAME_TOKENS`,
`_SENSITIVE_NAMES`, `_SENSITIVE_COMPACT_NAMES`, `_JWT_RE`, `_is_sensitive_name`).
Verified byte-identical across the two modules at commit 70543612.

Extract the shared, security-load-bearing redaction data into one module in the
scrapectl package (e.g. `apps/scrapectl/scrapectl/redaction.py`): the sensitive token
set, the sensitive query-name set, the compact-name set, and the JWT regex. Import
those single definitions from both `handlers/x.py` and `run_fetch_markdown.py` so the
two extraction paths can no longer diverge. Keep each module's own predicate wrappers
thin around the shared data; do not change what is classified as sensitive.

Files:
- apps/scrapectl/scrapectl/redaction.py (new shared module — exact name at author discretion)
- apps/scrapectl/scrapectl/handlers/x.py
- apps/scrapectl/scrapectl/run_fetch_markdown.py

## Acceptance

- [ ] The token/name/compact sets and JWT regex are defined once and imported by both paths.
- [ ] Existing offline redaction tests pass unchanged (no redaction behavior change).
- [ ] A guard test proves both paths reference the shared definitions so a one-sided edit cannot silently reopen a gap.

## Done summary

## Evidence
