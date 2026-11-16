# ElimuWrite

**Write better. Understand your sources. Submit with confidence.**

ElimuWrite is a writing studio, source-similarity checker, citation manager and assignment workflow for students, researchers, educators and institutions in Tanzania and East Africa. The interface is available in English and Kiswahili. "ElimuWrite" is a provisional name: the brand name, tagline, colours and domain are all set through environment variables.

This repository holds the **Phase 1 MVP**. It covers both user journeys (personal and institutional) and works without any external AI or similarity credentials. Optional providers show as "Not configured" until they are connected; nothing is faked.

| Document | What it covers |
|---|---|
| [docs/HANDOVER.md](docs/HANDOVER.md) | What is implemented, what needs external configuration, and what is planned |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Stack, data model, row-level security, job queue, assumptions |
| [docs/SIMILARITY_METHOD.md](docs/SIMILARITY_METHOD.md) | How similarity is calculated and what it cannot detect |
| [docs/API.md](docs/API.md) | REST API reference |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Production requirements and operating-cost drivers |

## Quick start (local)

Requirements: Node.js 22+, PostgreSQL 14+ (16 recommended).

```bash
# 1. Database roles and databases (once, as a PostgreSQL superuser)
psql -U postgres -f server/scripts/init-db.sql

# 2. Install and configure
npm install
cp .env.example .env          # defaults match init-db.sql

# 3. Migrate and load the fictional demo data
npm run migrate
npm run seed

# 4. Run
npm run dev                   # API on :3000, web on :5173 (proxied to the API)
# or a production-style single process:
npm run build && npm start    # serves the built web app and API on :3000
```

Open http://localhost:5173 (dev) or http://localhost:3000 (start).

### Demo accounts

All demo data is fictional. Every demo organization is flagged `is_demo` and named "(Demo)", and every demo email uses the reserved `.test` domain. The password for all accounts is `Demo-Pass-2026`.

| Email | Role |
|---|---|
| `amina@demo.elimuwrite.test` | Personal workspace: essay, sources, similarity and writing reports |
| `registrar@demo.elimuwrite.test` | Institution admin, Kilimanjaro Institute of Learning (Demo) |
| `lecturer@demo.elimuwrite.test` | Instructor for EDU101, with an assignment, inbox and a released grade |
| `student1@demo.elimuwrite.test` … `student3@` | Students (student 1's submission reuses a repository passage) |
| `billing@demo.elimuwrite.test` | Institution billing admin |
| `admin@demo.elimuwrite.test` | Platform admin. Has no automatic access to documents. |

## Tests

```bash
npm test
```

The tests run against `elimuwrite_test`, which is wiped and migrated at the start of every run. There are 66 tests covering the 14 acceptance criteria:
- personal and institutional journeys;
- cross-tenant URL, API and raw-SQL isolation;
- assistance-policy enforcement;
- similarity scoring rules;
- honest empty, failed and unsupported states;
- frozen submissions;
- rewrite preservation checks;
- citation statuses;
- idempotent analysis, submissions, usage and payments;
- version conflicts;
- export round-trips;
- deletion and retention;
- demo separation.

External services (Crossref, DNS, the LLM) are mocked. To use different databases, override `TEST_DATABASE_URL` and `TEST_OWNER_DATABASE_URL`.

## Repository layout

```
server/              Fastify API, analysis worker, migrations, seed, tests
  migrations/        SQL migrations (schema, RLS policies, triggers)
  src/engines/       similarity, writing rules, rewrite, citations, assistance policy
  src/jobs/          Postgres-backed job queue, retention sweep
  src/routes/        HTTP routes by area
  src/reports/       PDF report rendering
  seed/              fictional demo data (loaded through the real API)
  test/              vitest suites
web/                 React + Vite single-page app (TipTap editor, i18n en/sw)
docs/                architecture, method, API, deployment, handover
```

## Operations

- `npm run migrate` applies pending SQL migrations as the owner role.
- `npm run retention -w server` deletes submissions older than each institution's `retention_days`. Schedule it daily.
- The analysis worker runs inside the API process by default. Set `RUN_WORKER=false` and run a second process to scale it separately (see DEPLOYMENT.md).
