# Deployment

## Minimum production setup

| Component | Recommendation | Notes |
|---|---|---|
| App server | 2 × small VMs or containers (2 vCPU, 4 GB) behind a load balancer | Stateless. Sessions live in Postgres. Runs `npm start`. |
| Analysis worker | 1+ process (`npm run worker -w server`), with `RUN_WORKER=false` on the API | Scale by adding processes. Jobs are claimed with `SKIP LOCKED`. |
| Database | Managed PostgreSQL 16 (2 vCPU, 8 GB to start), daily backups plus point-in-time recovery | The two roles from `server/scripts/init-db.sql`. The app must connect as `elimu_app` (not the owner). |
| Object storage | S3-compatible bucket with server-side encryption | Replace `LocalStore` in `src/lib/storage.ts` (same `put/get/delete` interface) |
| TLS | At the load balancer. Set `COOKIE_SECURE=true` and `PUBLIC_URL`. | |
| Scheduled jobs | Daily `npm run retention -w server` | Deletes submissions past each institution's `retention_days` |
| Email | Transactional email provider | **Not yet wired.** Invitations currently return a link for the admin to share. |

### Release steps

1. `npm ci && npm run build`
2. `npm run migrate`. Uses `OWNER_DATABASE_URL`, and is safe to run on every deploy.
3. Start the API and the workers.
4. Check that `GET /api/health` returns ok and that `GET /api/config` shows the expected provider statuses.

Do **not** run `npm run seed` in production. It creates demo accounts with a published password.

### Data residency

The application has no fixed hosting region. If institutions need data kept in Tanzania or East Africa, choose a regional provider or a South Africa / EU region with a documented data-processing agreement. Confirm this against the Tanzania Personal Data Protection Act (2022) obligations with counsel before onboarding institutions.

## Operating-cost drivers

| Driver | What scales it | Notes / levers |
|---|---|---|
| **Database storage** | Fingerprints. Each document stores about one row (~60 bytes plus index) per word, so 1 M submitted words ≈ 100–150 MB. | The largest growth item. Levers: retention policies, winnowing (store 1 in N shingles) for very large repositories, partitioning `fingerprints` by org. |
| **Database CPU** | Similarity scans (hash lookups plus alignment). Scans per month ≈ submissions × (1 + rechecks). | On demo-scale corpora a scan finishes in well under a second. Benchmark with a realistic repository size before launch. Scans are queued, so bursts near deadlines delay results rather than fail. |
| **LLM usage** (optional) | Paraphrase, translation and tutor requests × text length | Per-token pricing. Local Concise/Simple modes and extractive summaries cost nothing. Use plan limits on `words_per_month` to cap spend. |
| **External similarity service** (optional) | Per-document licensing fees | Requires a commercial agreement. The local-corpus engine has no per-scan cost. |
| **OCR** (optional) | Pages of scanned PDFs | Per-page pricing on most services |
| **Object storage and egress** | Original uploads and PDF report downloads | Small. Reports are generated on demand rather than stored. |
| **Payments** | Transaction fees (card or mobile money) | Choose a provider after confirming Tanzanian merchant support (M-Pesa, Tigo Pesa, Airtel Money). Bank-transfer invoicing is already supported. |
| **Support and moderation** | Institutions, appeals, support-access requests | Every support access is audited. Budget staff time for audit review. |

### Rough starting budget

A pilot with 1–3 institutions and up to 5k students is roughly:
- 2 small app VMs;
- 1 worker;
- a managed Postgres instance with 8 GB of RAM;
- object storage.

That is typically the cost of a few hundred US dollars per month at mainstream cloud prices, before optional AI, OCR or external-similarity usage. Get local hosting quotes before committing.

## Security checklist before launch

- [ ] Rotate both database passwords. Make sure `elimu_app` does not own tables and has no `BYPASSRLS`.
- [ ] `COOKIE_SECURE=true` and HTTPS only.
- [ ] Configure `MALWARE_SCAN_ENDPOINT`. Uploads are already type-checked by magic bytes and size-limited.
- [ ] Set `PAYMENT_WEBHOOK_SECRET` from the provider, and restrict the webhook route at the edge where possible.
- [ ] Restrict access to `/api/admin/*` (for example a VPN or IP allow-list) in addition to the role check.
- [ ] Test backup restores. Document the backup retention window, which is shown to users when they delete documents.
- [ ] Penetration test focused on tenant isolation and file upload.
