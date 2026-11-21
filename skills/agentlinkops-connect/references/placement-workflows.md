# Project selection and placement checks

Use these workflows when connecting a project or checking a supplied publisher page. Read [the connection skill's main reference](agentlinkops.md) first. Discover the connected command and current schema before calling it; registered commands can still be unavailable in the selected environment.

## Choose the project

Read workspace identity, membership, limits and accessible projects. Page through the returned project list as needed. Return actual names and identifiers, and use the project selected for this task. Do not guess an ID, create another project or start monitoring as a connection test. If access is missing, identify the workspace/project or connection step that needs attention.

## Inspect a supplied placement

Inputs are the exact publisher URL, expected destination, exact-page or website scope, and whether the user wants a one-time check or recurring monitoring. Preserve the supplied scope rather than silently broadening it.

For a one-time local check, use the maintained accountless CLI path and read its structured observation. A returned result or exit zero does not establish presence. Report the state, date, reason, acquisition method and completeness; blocked or incomplete evidence remains unknown.

For hosted monitoring, first read the selected project's allowance and current command contract. Quote the schedule with `estimate_usage` (action `monitor`) and explain the target scope, schedule, expected check use and what remains. Enroll only within the user's task or standing authority. Retain the watch and job identifiers. Saving a watch can queue its initial check; follow that job and reuse applicable fresh evidence instead of requesting a duplicate. Never silently resume a paused watch.

Read back the saved project, source, destination, scope, schedule and resulting observation. Report the record's `reach` reason and next step in its own words. Site gone and Page not found describe the publisher page and never mean the link was removed. `marked_fine` is never check evidence. A successful job may still produce unknown evidence. Keep the observation separate from source-response completeness, historical presence and confirmed loss. A browser inspection is separate dated evidence, not a replacement for the hosted verifier's result.

Return the actual saved identity and dated evidence, or name the missing access, unavailable operation, allowance or unresolved job. Local checking alone creates no recurring hosted watch.

## Report a link's status

Read the link's `state` and its `reach` field together. `reach` holds the latest check's `reason`, `reason_class`, one sentence and a `next_step`; give the person the sentence and the next step.

| What the check found | Reason or class | Report it as |
| --- | --- | --- |
| The link is on the page | `link_found` | Live |
| The page was read and the link is gone, after an earlier check saw it | `not_on_page`, confirmed by a second complete check | Missing (lost) |
| The page was read and the link was never seen live | `not_on_page` on a link with no live history | Not yet verified (never counted as lost) |
| The page now links to another page of the same site | `wrong_landing_page` | Points to another page. It stays in the Missing count because the watched address is no longer linked, but Changes does not count it as lost. Ask whether that page is acceptable |
| The site is gone | `site_gone` (parked, for sale, expired, default server page, placeholder, suspended; hostname gone on hosted monitored links) | Site gone (never Missing) |
| The site answers the page with 404 or 410 | `page_gone` | Page not found (never Missing) |
| The page couldn't be read | `scripts`, `blocked`, `robots`, `login`, `rate_limited`, `slow`, `site_error`, `redirect`, `not_a_page`, `check_failed` | Can't reach, with the sentence and next step |

A person or agent can mark a non-Live link as fine with `update_link_watch` and `markedFine: true`. Say who marked it and when. The mark never counts as a check: it changes no status count, and the next check that reads the page clears it (`marked_fine.active` becomes false). Save context for later readers in `note`.
