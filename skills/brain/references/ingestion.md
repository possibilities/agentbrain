# Ingestion and recovery

Use this reference when answering “did that source land?” or investigating a
stalled admission. Discover the current Agentbrain MCP tools and schemas in
Executor; operator-only repair commands are deliberately outside that surface.

## Follow the durable record

`jobs_show` takes the returned `job-id` and reports attempts and transitions.
`jobs_list` filters by state or run; `jobs_stats` distinguishes queued, running,
retry-waiting, blocked, failed, completed, excluded, and cancelled work. A Run
groups admissions from a recurring source; `jobs_run` reads that Run.

Completed indexing is the outcome to verify. A failed/blocked job carrying a
failure classification is stranded ingestion. Excluded and cancelled work
has an explicit disposition; it is not an extraction failure. An admission
awaiting review before any attempt is another distinct state.

Ordinary job inspection omits the durable intent body. `reveal-content` reads
stored artifact bodies and appends an audit record; use it only when that
content is needed for the investigation. Job metadata is usually sufficient
to identify the failing stage.

Do not retry or discard jobs merely to clear a health report. Repair the
underlying issue within the requested scope, then use the owner's supported
recovery operation. Report a missing MCP operation honestly rather than
inventing one from a CLI command name.

## Admission details

An explicit idempotency key identifies an intent. Reusing it for a different
intent is a conflict; changing keys repeatedly is not a retry strategy.
`force` requests rematerialization of an already indexed URL, so use it when
fresh extraction is wanted, not to suppress a healthy duplicate response.

Directory admissions snapshot bounded local material. Keep secret filtering
enabled and choose the directory and limits deliberately. Use collection/tag
arrays according to the live schema; avoid a later index-wide retag merely
because submission metadata was omitted.

## Locate the failing boundary

Agentbrain has several ingress paths. The browser extension and phone share
target may retain an unsent share locally; if no job exists, the problem may
precede admission. Recurring sources admit Runs on a cadence. The worker leases
jobs, asks Agentscrape to extract network content, then commits outcomes.

Inspect source configuration/status through `sources_list`, `sources_show`,
and `sources_status`. A missing Agentscrape executable or a broken browser
provider affects URL extraction while local text/file ingestion can still
work. AgentStart owns the worker and health service lifecycle. Use its supported
installation path for an authorized repair; do not start a competing service.

Agentbrain's CLI remains available to operators and diagnostics. Its `guide`
contract describes that broader surface as well as the MCP operations; an
operator-only command in the guide is not an undiscovered agent tool.
