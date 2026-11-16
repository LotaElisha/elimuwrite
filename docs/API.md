# API reference

All endpoints live under `/api`. Requests and responses are JSON unless noted.

**Authentication:** the `ew_session` cookie (set at login), or `Authorization: Bearer <token>`. The token comes back from `/auth/register` and `/auth/login`.

**Errors** look like this:

```json
{ "error": "<code>", "message": "<plain explanation>", "detail": … }
```

| Status | Meaning |
|---|---|
| 400 | `validation` |
| 401 | Not signed in |
| 402 | `quota_exceeded` |
| 403 | `policy_blocked` / `forbidden` |
| 404 | Not found, **or not yours**. Existence is not leaked. |
| 409 | `version_conflict`, `stale_suggestion`, `already_submitted`, `attempts_exhausted`, `use_submission`, `not_ready` |
| 415 | Unsupported upload type |
| 429 | Rate limited |

IDs are UUIDs. Times are ISO-8601 UTC. The client displays times in the institution's timezone.

## Public

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | Database check |
| GET | `/config` | Brand, provider statuses (`configured` / `not_configured`), citation styles, assistance presets, rewrite modes |
| GET | `/plans` | Plans and limits. A price of `null` means not yet approved. |
| GET | `/lessons/:rule` | Short lesson and practice item for a writing rule |
| POST | `/demo/check` | `{text}` (max 3,000 chars). Guest demo: in memory, rate-limited, demo sources only, nothing stored. |
| GET | `/shared/:token`, `/shared/:token/pdf` | Shared report (external audience) |

## Account

| Method | Path | Body / notes |
|---|---|---|
| POST | `/auth/register` | `{email, name, password ≥8, locale?, english_variant?, invitation_token?}` → `{id, token}`. Rate-limited. |
| POST | `/auth/login` | `{email, password}` → `{token}` |
| POST | `/auth/logout` | |
| GET / PATCH | `/me` | Profile and `workspaces[]` (`kind`, `roles`, `is_demo`) |
| GET | `/me/export` | All of the user's data as JSON |
| GET | `/invitations/:token`, POST `/invitations/:token/accept` | |
| GET | `/me/progress` | Recurring issues, decisions, activity |
| GET / POST / DELETE | `/me/dictionary[/:word]` | Personal dictionary |

## Documents and writing

| Method | Path | Notes |
|---|---|---|
| GET / POST | `/folders` | |
| GET | `/documents?folder=&q=` | |
| POST | `/documents` | `{title, html?, folder_id?}` |
| GET / PATCH / DELETE | `/documents/:id` | DELETE removes all versions, reports and stored files |
| PUT | `/documents/:id/content` | `{base_version_no, html}`. 409 `version_conflict` if `base_version_no` is stale. Saves within 120 s are merged into the same unfrozen version. |
| GET | `/documents/:id/versions`, `/documents/:id/versions/:no` | |
| POST | `/documents/:id/restore/:no` | Creates a new version |
| GET | `/documents/:id/compare?a=&b=` | Word diff |
| GET | `/documents/:id/events`, GET/POST `/documents/:id/comments` | |
| GET | `/documents/:id/export?format=docx\|pdf\|txt\|html&style=` | Includes the bibliography in the chosen style |
| POST | `/imports` | multipart `file` (TXT, DOCX, PDF). Returns `needs_review` with a preview, `needs_ocr`, or `failed`. |
| GET | `/imports/:id`, POST `/imports/:id/confirm` | `{title, as: document\|source, document_id?}` |
| GET / POST / DELETE | `/sources[/:id]` | Personal reference documents for similarity |
| POST | `/documents/:id/writing-check` | Explained suggestions with offsets, plus readability. Swahili returns `unsupported_language`. |
| POST | `/suggestions/:id/decision` | `{decision: accept\|reject\|ignore\|undo, current_version_id}`. 409 `stale_suggestion` if the text changed. |
| POST | `/tools/rewrite` | `{text, mode, document_id?, locked[]}`. Each alternative carries preservation `flags`. AI modes return `not_configured` without a provider. |
| POST | `/tools/summarize` | Extractive summary, `{length, format}` |
| POST | `/tools/translate`, `/tools/tutor` | Need an LLM provider |

When `document_id` names an assignment document, all tools check the assignment's assistance policy and return 403 `policy_blocked` if it disallows them.

## Analysis and reports

| Method | Path | Notes |
|---|---|---|
| POST | `/documents/:id/estimate` | Words, cost, allowance used |
| POST | `/documents/:id/analysis` | `{kind: similarity\|citations\|writing, source_ids?, exclude_quotes, exclude_bibliography, min_match_words}`. Returns 202 for a new job, or 200 with `duplicate: true`. |
| GET | `/documents/:id/jobs`, `/jobs/:id` | Each job includes `report_id` once complete |
| POST | `/jobs/:id/cancel` | Not charged |
| GET | `/reports`, `/reports/:id` | View depends on audience (`owner`, `staff`, `student`, `external`). Shows original and adjusted results, sources, matches, exclusions and limitations. |
| GET | `/reports/:id/pdf` | Branded PDF |
| GET | `/reports/compare?a=&b=` | Two reports side by side |
| POST | `/reports/:id/exclusions` | `{target_type: source\|match, target_id, reason ≥3}`. Owner or staff only. |
| POST | `/reports/:id/exclusions/:ex/revert` | |
| POST / GET | `/reports/:id/shares` | `{expires_in_days}` → `{token, path}` |
| DELETE | `/shares/:id` | Revoke |

## References

| Method | Path | Notes |
|---|---|---|
| GET | `/refs?tag=&document_id=` | |
| POST | `/refs` | `{doi?, isbn?, csl?, document_id?}`. `checks` = `{exists, metadata, supports_claim}`, kept separate. |
| PATCH / DELETE | `/refs/:id` | `support_status` is set only by the user |
| POST | `/refs/:id/verify` | Registry lookup. Reports `metadata_differences` and never overwrites the user's entry. |
| POST / DELETE | `/documents/:id/refs/:ref` | Link or unlink |
| GET | `/documents/:id/bibliography?style=apa\|mla\|chicago\|harvard\|ieee` | |
| POST | `/documents/:id/citation-check` | Missing references, uncited entries, style inconsistencies, possible attribution needs |
| GET | `/refs/export?format=bibtex\|ris` | |

## Institutions

| Method | Path | Role |
|---|---|---|
| POST | `/orgs` | Any user. The creator becomes `org_admin`, with a trial subscription. |
| GET / PATCH | `/orgs/:id` | Member / org_admin. Settings include `retention_days` and `anonymous_marking`. |
| POST | `/orgs/:id/departments` | org_admin |
| GET / PATCH | `/orgs/:id/members[/:uid]` | org_admin |
| POST | `/orgs/:id/invitations` | org_admin |
| POST | `/orgs/:id/members/import/preview` → `/commit` | org_admin. CSV is previewed first, and the commit requires the matching `preview_hash`. |
| GET / POST | `/orgs/:id/domains`, POST `/domains/:did/verify`, PATCH `/domains/:did` | org_admin. Verified by DNS TXT record. Provisioning grants only `student`. |
| GET / POST | `/orgs/:id/terminology` | |
| GET / POST / DELETE | `/orgs/:id/repository[/:sid]` | org_admin. Requires `rights_confirmed` and `inclusion_reason`. |
| GET | `/orgs/:id/analytics` | Aggregates only. Groups with fewer than 3 students are suppressed. |
| GET | `/orgs/:id/audit`, `/orgs/:id/exports/submissions.csv` | org_admin |
| GET / POST | `/orgs/:id/courses`, `/orgs/:id/rubrics`, `/orgs/:id/snippets` | |

## Teaching and submissions

| Method | Path | Notes |
|---|---|---|
| GET | `/courses/:id`, POST/DELETE `/courses/:id/members[/:uid]` | |
| POST | `/courses/:id/assignments` | Instructions, due date, rubric, assistance preset, attempts, template text, similarity settings |
| PATCH | `/assignments/:id` | Policy changes bump `policy_version` |
| GET | `/assignments/:id` | The view differs for staff and students |
| POST | `/assignments/:id/start` | Creates or returns the student's assignment document |
| POST | `/assignments/:id/submissions` | `{document_id, idempotency_key ≥8, disclosure?, expected_version_no?}`. Freezes the version and returns a receipt (server time, timezone, content hash, policy version, late flag). |
| GET | `/assignments/:id/submissions` | Instructor inbox (anonymous labels if the org enables them) |
| POST | `/assignments/:id/recheck` | Re-scan every latest submission against the full set |
| GET | `/submissions/:id` | Student: receipt, plus feedback once released. Staff: text, activity, attempts, reports, grade. |
| PUT | `/submissions/:id/grade` | Rubric scores and feedback (draft) |
| POST | `/submissions/:id/grade/approve`, `/grade/release`, `/request-revision` | Release requires approval |
| POST | `/assignments/:id/release-approved` | Bulk release |
| POST | `/submissions/:id/comments`, `/submissions/:id/responses` | Student response or appeal |
| POST | `/responses/:id/decide` | |
| GET | `/me/courses`, `/me/assignments` | |

## Billing

| Method | Path | Notes |
|---|---|---|
| GET | `/billing?org=` | Plan, limits, usage, invoices, provider status |
| POST | `/billing/checkout` | Returns `not_configured` until a provider is connected. **Never** grants access. |
| POST | `/billing/cancel` | Access continues to the end of the period |
| PUT | `/orgs/:id/seats`, POST `/orgs/:id/invoice-requests` | billing_admin |
| POST | `/webhooks/payments/:provider` | `x-signature` = hex HMAC-SHA256 of the body. Each event is processed once. This is the only route that activates paid access. |

## Platform administration (`is_platform_admin`)

The admin endpoints are:
- `GET /admin/health`;
- `GET|PATCH /admin/plans[/:code]`;
- `GET /admin/orgs`;
- `GET|PATCH /admin/flags[/:key]`;
- `GET|POST /admin/invoices`;
- `POST /admin/invoices/:id/reconcile`;
- `GET|POST /admin/support-access`;
- `DELETE /admin/support-access/:id`;
- `GET /admin/support/documents/:id` (only with a live grant);
- `GET /admin/audit`.
