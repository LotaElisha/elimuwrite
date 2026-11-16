# Architecture

## Stack

| Layer | Choice | Why |
|---|---|---|
| API | Node.js 22, TypeScript, Fastify 5, zod validation | One language across the stack, fast JSON handling, schema validation on every input |
| Database | PostgreSQL 16 | Row-level security (RLS) for tenant isolation, JSONB for flexible settings, reliable transactions |
| Jobs | Postgres-backed queue (`analysis_jobs`, `FOR UPDATE SKIP LOCKED`) | No extra infrastructure in Phase 1. Swappable for a dedicated broker later. |
| File storage | Local disk adapter (`src/lib/storage.ts`) | Same interface as an S3-compatible store, which production should use |
| Web | React 19, Vite, react-router, TipTap (ProseMirror) | Rich-text editor with stable positions for suggestion anchoring. The editor bundle is lazy-loaded for low-bandwidth users. |
| Documents | mammoth (DOCX in), pdf.js (PDF in), docx (DOCX out), pdfkit (PDF out) | All run locally, with no external services |
| Citations | citation-js with vendored CSL styles (APA, MLA, Chicago author-date, Harvard, IEEE) | Standard CSL formatting, plus BibTeX and RIS import/export |

## Request flow

1. The browser calls `/api/...` with the `ew_session` cookie. API clients use `Authorization: Bearer <token>`. Sessions are random tokens, stored hashed, that expire after `SESSION_DAYS`.
2. Each handler calls `req.db(fn)`. This opens a transaction and sets `app.user_id` with `set_config(..., true)`, then runs `fn`. Every query therefore runs as the `elimu_app` role with RLS context for the current user.
3. Authorization is checked twice:
   - **In code:** `requireOrgRole`, `requireTeaches`, `ownDocument` and `enforceCapability` in `src/lib/authz.ts`. Any resource the caller cannot see returns **404** rather than 403, so its existence is not leaked.
   - **In the database:** RLS policies. A bug in route code still cannot return another tenant's rows.
4. Expensive work is queued. Similarity scans, citation checks and writing reports are inserted into `analysis_jobs` with an idempotency key, and a worker claims them.

## Tenancy and roles

- **Personal workspace:** rows with `org_id IS NULL` and `owner_user_id` = the user.
- **Institution:** an `organizations` row. `memberships.roles` is an array of `student`, `instructor`, `reviewer`, `org_admin` and `billing_admin`. Course roles (`instructor`, `reviewer`, `student`) are held in `course_members`.
- **Platform admin:** `users.is_platform_admin`. Admins get **no** implicit access to content. Reading a document requires a `support_access_grants` row with these properties:
  - a justification of at least 20 characters;
  - expiry within 24 hours;
  - it can be revoked;
  - granting, viewing and revoking are all written to `audit_events`.

  The RLS policy on `documents` and `document_versions` admits a platform admin only while such a grant is live.
- **Email-domain provisioning** only happens for domains verified by a DNS TXT record and with provisioning switched on. It only ever grants the `student` role.

## Data model (main tables)

```
users ─┬─ sessions
       ├─ memberships ── organizations ─┬─ org_domains, departments, invitations
       │                                ├─ courses ── course_members
       │                                │      └─ assignments ── assignment_policy_versions
       │                                ├─ rubrics, feedback_snippets, org_terminology
       │                                └─ subscriptions, invoices, usage_records, audit_events
       ├─ folders ── documents ── document_versions (frozen when analysed or submitted)
       │                 ├─ document_events, comments, suggestions, document_refs ── refs
       │                 └─ analysis_jobs ── reports ─┬─ similarity_matches
       │                                              ├─ report_exclusions
       │                                              └─ report_shares
       ├─ submissions (immutable) ── grades, feedback_responses
       ├─ sources ── fingerprints        (scopes: personal, institution_repository,
       │                                  assignment_template, submission, demo)
       └─ files, imports, personal_dictionary, learning_events
plans, payment_events, feature_flags, support_access_grants
```

The full schema is in `server/migrations/001_init.sql`. Child-table RLS is in `002_child_rls.sql`.

### Integrity rules enforced by the database

- **Frozen versions.** A version referenced by a report or a submission is marked `frozen`, and a trigger rejects changes to it. Editing afterwards creates a new version. Restoring an old version also creates a new version, so history is never rewritten.
- **Immutable submissions.** A trigger rejects updates to the content hash, version, receipt time and policy version of a submission.
- **Exactly-once usage.** `usage_records.idempotency_key` is unique, and a similarity check is charged with key `job:{id}` only when the job completes.
- **Exactly-once payments.** `payment_events (provider, provider_event_id)` is unique.
- **Exactly-once submissions.** `submissions.idempotency_key` is unique per student and client-supplied key.
- Support grants are capped at 24 hours, and a justification is required.

## Row-level security

The app connects as `elimu_app`, which owns no tables, so RLS always applies. Policies use small `SECURITY DEFINER` helper functions:
- `app_uid()`;
- `app_org_roles(org)`;
- `app_teaches_assignment(a)`;
- `app_can_read_version(v)`;
- `app_support_grant(doc)`;
- `app_job_scope(org, owner)`.

| Table(s) | Visible to |
|---|---|
| documents, document_versions | Owner. Course staff, for versions that were submitted to their assignment. A platform admin with a live support grant. The worker, within the job's tenant. |
| submissions | The student, and staff who teach that assignment |
| reports | The owner (personal), or staff of the assignment (submissions). The worker within its tenant. Students see their report only if the assignment allows it, which is checked in code. |
| sources, fingerprints | Personal: owner. Repository and templates: org admins, instructors and reviewers of that org. Submissions: the student and the assignment's staff. Demo: everyone. |
| refs | Owner (personal), or members of the org |
| similarity_matches, report_exclusions | Whoever can see the parent report |
| grades, feedback_responses, comments | Whoever can see the parent submission or document. Only staff of the assignment can write grades. Release to the student is checked in code. |
| suggestions, document_events | Whoever can see the parent document. Staff can also see events of a submitted document. |

Tests in `server/test/institution.test.ts` connect as `elimu_app` with raw SQL and assert that another tenant sees zero rows in every protected table.

## Analysis jobs

- **Enqueue.** A personal run uses the key `kind:versionId:settingsHash`, and a submission scan uses `sub:{id}:similarity`. Repeating a request for the same version and settings returns the existing job, so there is no second charge. Quota is checked before enqueueing and returns HTTP 402 with a plain explanation.
- **Claim.** The worker uses `FOR UPDATE SKIP LOCKED` and leases each job with `locked_until`, so a crashed worker's job is picked up again. Each job gets up to 3 attempts.
- **Run.** The worker runs inside `withDb({ jobUser, jobOrg })`, so it can only read sources in its own tenant. The corpus is chosen as follows:
  - Personal scans use the user's own sources, or the source ids they chose.
  - Submissions use the institution repository and the assignment template, plus, when within-class comparison is on, the **latest** submission of every other student in the assignment.
  - The student's own earlier attempts are auto-excluded unless `include_own_drafts` is set.
  - The worker never reads other institutions' data or the demo sources.
- **Complete.** The worker writes the report and its matches, freezes the analysed version, records usage once, and marks the job completed. Failed and cancelled jobs are never charged.

## Assistance policy

Each assignment has a preset plus optional overrides, resolved by `resolvePolicy()`:

| Preset | Behaviour |
|---|---|
| `proofreading_only` | Grammar checks only |
| `guided_learning` | Grammar, summary and tutor |
| `permitted_with_disclosure` | Everything allowed, but the student must write a disclosure before submitting |
| `assistance_disabled` | Nothing allowed |

Each policy change bumps `policy_version`, and that version is recorded on each submission. `enforceCapability()` runs inside every tool endpoint when the request names an assignment document, and returns 403 `policy_blocked`. The UI hides blocked tools, but the server is the enforcement point.

*Limitation:* a student can still use the general tools without naming the assignment document, for example by pasting text in a personal workspace. No web product can prevent that. The policy governs assistance inside the assignment workspace and is recorded for academic-integrity review.

## Key assumptions

- **Timezone.** Due dates are stored in UTC and displayed in the institution's timezone, which defaults to `Africa/Dar_es_Salaam`. Lateness is decided by server receipt time.
- **Within-class comparison** uses the latest attempt of each other student. Rechecking an assignment re-scans every latest submission against the same full set, so submission order does not change how anyone is treated.
- **Anonymous marking** (an org setting) hides names and emails in the inbox and the review view.
- **Writing analysis** is rule-based English (US and UK variants). Swahili text is detected and returned as "not yet supported", never as "no issues".
- **Swahili interface strings** are a first draft and need review by a native speaker before launch.
- **Plan prices** are deliberately `null` (not approved). Plan limits can be edited by the platform admin.
