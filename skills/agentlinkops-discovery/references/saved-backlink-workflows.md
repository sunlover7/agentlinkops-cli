# Review saved backlinks and supplied imports

Use this reference for an existing backlink search or a supplied export. New supplier research is a separate choice. Read the discovery skill's qualification rules. Before product calls, use the installed connection skill or read [the AgentLinkOps connection reference](https://agentlinkops.com/SKILL.md). Missing access leaves a supplied-input review useful; it does not authorize a substitute hosted operation.

## Review a saved search

Inputs are the selected website and saved search/run identity. Read the saved search and all returned candidate pages, retaining original source URLs, supplier/retrieval dates, completed-check dates and monitoring IDs. Follow only the current traversal's cursors. A partial read is not the complete backlink profile.

Separate indexed supplier records, completed page observations and already monitored links. Group the evidence by publisher and destination. Identify repeated URL patterns, missing evidence and plausible outreach or reclamation opportunities, giving reasons rather than treating a score as a decision. A source from a competitor is a research candidate, not an earned link or a promise of editorial acceptance.

For a finished Find backlinks search, read the same rows by linking site or by anchor text with `list_domain_baseline_groups` (`by: referring_site` or `by: anchor`). Each group reports its link count, share of the rows, check results, follow counts, the highest retained domain strength (sites only) and the highest spam risk. The same filters work there and on `list_domain_baseline_candidates`: `follow`, `check`, `minAuthority`, `maxSpam`, `site`, `anchor` and `newSinceLastSearch`. A row without a score never passes a score filter. `newSinceLastSearch` compares this search with the latest earlier search of the same website and subdomain setting whose link list completed; `review.previous_search_rows` gives how many rows that search kept. Without one, the read is refused with `BASELINE_NO_PREVIOUS_SEARCH`. Both searches are samples of the index, so a row the earlier sample lacks is not proof that the link itself is new. Filters and groups read a finished search: while it runs they return `BASELINE_REVIEW_NOT_READY`.

A grouped read can return `anchor_pattern`: one anchor text, other than the website's own name (alone or with more words), a URL, an empty anchor or a generic phrase, on at least 20% of all retained rows from at least five sites (the response states its threshold, and filters do not change it). Treat it as a reason to open those linking pages. It is not a disavow decision, and the signal never proposes one.

Recommend a reviewable monitoring selection. Preserve the existing task and standing authority: another supplier lookup, a metered check, recurring monitoring and a disavow decision are different actions. Read their scope and cost before acting. Do not buy data, enroll links or change a disavow list merely because a review found a candidate.

Return the saved run, coverage and observation dates, grouped findings, proposed selection and unresolved evidence. State which pages were read. Missing provider rows and incomplete checks do not establish removal.

## Import a supplied export

Keep the original file and its source unchanged. Preserve supplier collection/export times, imported row dates and the import time separately; missing dates stay unknown. Parse CSV with quoted commas, escaped quotes and multiline fields intact. Use the maintained import contract and supported supplier/mapping rather than splitting lines or inventing columns.

Distinguish a local preview from a saved hosted import. Inspect accepted/rejected rows and keep the returned run and candidate IDs. Read the stored candidates before recommending checks. Importing today does not establish when a backlink appeared or whether it is present now.

Before verification, read the applicable check allowance. Confirm any part of the task outside the user’s existing authorization. Keep a stable original request and idempotency value for the chosen selection. Follow existing jobs and retain quota rejections and unknown outcomes. A replay recovers the original batch decisions; it does not admit rejected rows after allowance changes. A changed payload needs the contract's distinct request identity.

Return the original-file reference, saved run or local-preview status, rejected rows, selected checks and dated observations. Recurring monitoring and disavow review remain separate decisions. A local import preview saves no ledger or hosted records.
