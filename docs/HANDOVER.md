# ElimuWrite Phase 1 handover

**Scope delivered:** the Phase 1 MVP from the master development prompt. It covers the personal and institutional journeys, local-corpus similarity, the submission and grading workflow, and reports. All of it works without external AI or similarity credentials. Phases 2 and 3 were not started.

**Quality gates:**
- 66 automated tests pass (`npm test`), covering all 14 acceptance criteria. See the mapping at the end.
- The server typechecks cleanly and the web app builds cleanly.
- An 18-screen browser walkthrough was run on desktop and mobile widths.

## Status by area

| Area | Implemented | Requires external configuration | Planned (later phases) |
|---|---|---|---|
| **Accounts and workspaces** | Email/password sign-up and login. Sessions are hashed tokens. Personal and institution workspaces with a switcher. Invitations. Profile. Full data export. English and Kiswahili interface, light/dark theme, adjustable text size, skip link, keyboard-operable report highlights. | Transactional email (invitations currently return a shareable link) | SSO (SAML/OIDC), MFA, password reset by email |
| **Writing studio** | TipTap editor with autosave and 120 s version coalescing. Version history, restore, word-level compare. Optimistic concurrency with a conflict screen. Offline drafts kept in the browser. Comments. Import of TXT, DOCX and text PDFs with a review step. Export to DOCX, PDF, TXT and HTML with a bibliography. | OCR for scanned PDFs (`OCR_ENDPOINT`). Until it is set, these are held as "needs OCR", never treated as empty. Malware scanning (`MALWARE_SCAN_ENDPOINT`). | Real-time co-editing, track changes, footnotes, images in imports |
| **Writing feedback** | Rule-based English checks (US/UK): grammar, punctuation, wordiness, clarity, tone. Each comes with an explanation, a mini-lesson and a practice item. Accept, reject, ignore and undo, bound to the exact version, so a stale suggestion is refused. Readability score. Personal dictionary, institution terminology, progress tracking of recurring issues. | None | Swahili checks (beta after evaluation by Swahili linguists), statistical or ML-based checks |
| **Rewriting and summaries** | Local Concise and Simple modes, with quotes, citations, numbers and locked terms protected. Preservation checker that flags changed numbers, quotes, citations, names, negation and locked terms on every alternative. Extractive summaries that never generate new claims. | LLM provider (`ANTHROPIC_API_KEY`) for the Standard, Academic, Formal and Fluent modes, translation and the writing tutor. They show "Not configured" until it is set. | Provider choice per institution, Swahili paraphrase |
| **Similarity** | Local fingerprint engine against personal sources, the institution repository, assignment templates and other students in the class. Each token is counted once. Quotations and bibliography are excluded from both sides of the percentage. Template and own-draft matches are automatically excluded. Reviewer exclusions require a reason and can be reverted. Original and adjusted results are shown side by side. Honest `no_sources` and `insufficient_text` states. Highlighted report, source excerpts limited to what the viewer may see, PDF report, comparison of two reports, expiring and revocable share links. | Licensed internet and publisher similarity service (`EXTERNAL_SIMILARITY_*`). This needs a commercial agreement. | Paraphrase and translation detection, cross-institution consortium repository, AI-writing indicators (deliberately not shipped: no reliable detector exists) |
| **Citations** | Reference library (CSL-JSON), add by DOI, ISBN or manually. Three separate checks: exists, metadata, supports-claim (the last is set only by the user). Verification reports differences rather than overwriting the user's entry. APA, MLA, Chicago, Harvard and IEEE output. BibTeX and RIS export. In-document citation check: missing reference, uncited entry, inconsistent style, possible attribution need, incomplete entry. | Outbound network access to `api.crossref.org` and Open Library. These were blocked in the build environment, so the UI showed "lookup unavailable". `CROSSREF_MAILTO` is recommended. | More styles (for example the house styles of Tanzanian universities), Zotero and Mendeley sync |
| **Institutions** | Org onboarding, departments, roles (student, instructor, reviewer, org_admin, billing_admin), invitations. CSV roster import with a preview-then-commit step. Email-domain verification by DNS TXT record, with provisioning only as student. Institution repository with a rights confirmation and an inclusion reason. Terminology lists. Aggregate analytics, with groups under 3 students suppressed. Audit log. Submissions CSV export. Retention sweep. | DNS access for domain verification. A scheduler for `npm run retention`. | LMS integration (LTI 1.3 with Moodle and others), SIS sync, department-level dashboards |
| **Assignments and grading** | Courses, rubrics, assignments with due dates, attempts, template text and similarity settings. Four assistance-policy presets, enforced by the server and versioned on every submission. Disclosure requirement. Idempotent submission that freezes the exact version, with a receipt showing server time in Africa/Dar_es_Salaam, the content hash and the policy version. Late flag. Instructor inbox with anonymous-marking labels. Full re-check of an assignment. Rubric grading with a draft → approve → release flow (nothing is visible before release). Reusable feedback snippets, revision requests, student responses and appeals. Authorship-activity counts with a caveat. | None | Peer review, moderation and second marking, grade export to an LMS |
| **Billing** | Plans with editable limits. Prices are left blank until approved. Usage metering charged exactly once per completed scan. Quota check with a clear 402 response. Trial subscription for institutions. Seats. Invoice requests, admin-issued invoices and bank reconciliation. Signature-verified, idempotent payment webhook, which is the only way paid access is activated. Cancel at the end of the period. | Payment provider and merchant account (`PAYMENT_PROVIDER`, `PAYMENT_WEBHOOK_SECRET`). Confirm Tanzanian card and mobile-money support (M-Pesa, Tigo Pesa, Airtel Money) first. Approved prices in TZS and USD. | Provider-specific checkout adapter, automatic dunning, tax invoices that meet TRA requirements |
| **Platform admin** | Service status (database, queue, providers). Plans, orgs, feature flags, invoices. Support access: justified, at most 24 hours, revocable, audited, and enforced by RLS. Global audit log. | None | Status page, alerting |
| **Security and privacy** | Row-level security on every content table, including child tables, verified by raw-SQL tests. 404 for anything the caller cannot see. Rate limits on authentication, the demo and imports. Uploads checked by magic bytes and size-limited. HTML sanitised. Prompt-injection guard on LLM calls. Demo data flagged and separated. | Production secrets, TLS, backups, a regional host (see DEPLOYMENT.md) | External penetration test, DPIA under the Tanzania PDPA 2022 |

## What needs a person's decision or input

1. **Brand.** "ElimuWrite" is provisional. Set `BRAND_NAME`, `BRAND_TAGLINE`, the colours and `PUBLIC_URL`.
2. **Swahili interface strings** in `web/src/lib/i18n.tsx` are a first draft. They need review by a native speaker before launch.
3. **Prices.** All plan prices are `null` until approved. Edit them under Platform admin → Plans.
4. **Payment provider choice and merchant onboarding.**
5. **External similarity licence.** Decide whether one is needed, and with whom.
6. **Hosting region and data-protection review.**
7. **Calibration study** for similarity thresholds (see SIMILARITY_METHOD.md, "Validation status").

## Assumptions made

- Lateness uses server receipt time. Due dates are entered and shown in the institution's timezone (default `Africa/Dar_es_Salaam`).
- Within-class comparison uses each other student's **latest** attempt. A student's own earlier attempts are excluded by default.
- Template and own-draft matches are treated like the quotation setting: they are shown to reviewers but never counted. "Original" means before *reviewer* exclusions.
- Students see their similarity report only if the instructor enables it for the assignment.
- Writing reports and citation checks also freeze the version they describe, so every report points at the exact text analysed.
- The assistance policy governs tools used inside assignment documents. It cannot stop a student from using tools elsewhere (see ARCHITECTURE.md).
- AI-writing detection is intentionally absent. The platform shows observed in-platform activity counts with a caveat instead.

## Known limitations

- Lexical matching only. Paraphrase and translation are not detected.
- Writing feedback is rule-based English. Expect more false negatives than commercial ML checkers.
- The Studio's large editor bundle (~480 KB, ~150 KB gzipped) loads only when the Studio opens.
- The file store is local disk. Swap it for S3-compatible storage before running multiple app servers.
- No email sending yet.

## Acceptance criteria → tests

| # | Criterion | Where |
|---|---|---|
| 1 | Personal journey end to end | `personal.test.ts`: personal journey |
| 2 | Institutional journey end to end | `institution.test.ts`: institutional journey |
| 3 | Cross-tenant access blocked (URLs, API, database) | `institution.test.ts`: tenant isolation (including raw SQL on the app role). `platform.test.ts`: admin support access. |
| 4 | Assistance policy enforced through direct API calls | `institution.test.ts`: assistance policy |
| 5 | Overlap counted once, exclusions, drafts, class matches | `engines.test.ts`: similarity scoring. `institution.test.ts`: class comparison and reviewer exclusions. |
| 6 | Empty corpus, failed extraction, Swahili and missing provider never shown as clean | `engines.test.ts`, `personal.test.ts`: imports and empty corpus. `platform.test.ts`: providers. |
| 7 | Edits mark analysis outdated; submitted version unchanged | `personal.test.ts`: outdated analysis. `institution.test.ts`: frozen submission. |
| 8 | Rewrite preservation flags | `engines.test.ts`: rewrite preservation. `platform.test.ts`: provider rewrite flags. |
| 9 | Citation existence vs metadata vs support | `engines.test.ts`, `platform.test.ts`: citations |
| 10 | Idempotent analysis, payments, submissions and usage | `personal.test.ts`, `institution.test.ts`, `platform.test.ts`: payments |
| 11 | Version conflict and save behaviour | `personal.test.ts`: versions and conflicts |
| 12 | Exports and PDF readability | `personal.test.ts`: exports (DOCX/PDF/TXT parsed back). `platform.test.ts`: sharing. |
| 13 | Deletion and retention | `personal.test.ts`: deletion and export. `institution.test.ts`: retention. |
| 14 | Demo flags and not-configured providers | `platform.test.ts`: demo data and providers |
