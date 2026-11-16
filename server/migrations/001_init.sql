-- ElimuWrite initial schema. Run as the schema owner (elimu_owner).
-- The application connects as elimu_app, which is NOT the table owner, so
-- row-level security policies below are enforced for every app query.

create extension if not exists pgcrypto;
create extension if not exists citext;

-- ---------------------------------------------------------------- context
-- Each request/job sets these transaction-local settings:
--   app.user_id   uuid of the authenticated user (empty for guests)
--   app.job_org   org uuid a background job is scoped to ('' = personal job)
--   app.job_user  requester uuid of a background job
create or replace function app_uid() returns uuid language sql stable as
$$ select nullif(current_setting('app.user_id', true), '')::uuid $$;
create or replace function app_job_user() returns uuid language sql stable as
$$ select nullif(current_setting('app.job_user', true), '')::uuid $$;
create or replace function app_job_org() returns uuid language sql stable as
$$ select nullif(current_setting('app.job_org', true), '')::uuid $$;

-- ---------------------------------------------------------------- identity
create table users (
  id uuid primary key default gen_random_uuid(),
  email citext not null unique,
  name text not null,
  password_hash text not null,
  locale text not null default 'en' check (locale in ('en','sw')),
  english_variant text not null default 'en-US' check (english_variant in ('en-US','en-GB')),
  academic_level text,
  writing_goals text[] not null default '{}',
  is_platform_admin boolean not null default false,
  is_demo boolean not null default false,
  created_at timestamptz not null default now()
);

create table sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  kind text not null default 'university',
  logo_url text,
  timezone text not null default 'Africa/Dar_es_Salaam',
  seat_limit integer,
  trial_ends_at timestamptz,
  is_demo boolean not null default false,
  settings jsonb not null default '{
    "anonymous_marking": false,
    "repository_inclusion": "opt_in",
    "cross_institution_comparison": false,
    "retention_days": 1825,
    "offline_drafts_allowed": false,
    "default_assistance_preset": "guided_learning"
  }'::jsonb,
  created_at timestamptz not null default now()
);

create table org_domains (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  domain citext not null,
  verification_token text not null,
  verified_at timestamptz,
  provisioning_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  unique (org_id, domain)
);

-- roles: student, instructor, reviewer, org_admin, billing_admin
create table memberships (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  roles text[] not null,
  status text not null default 'active' check (status in ('active','suspended')),
  created_at timestamptz not null default now(),
  unique (org_id, user_id),
  check (roles <@ array['student','instructor','reviewer','org_admin','billing_admin']::text[])
);

create table invitations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  email citext,
  roles text[] not null,
  token_hash text not null unique,
  expires_at timestamptz not null,
  max_uses integer not null default 1,
  uses integer not null default 0,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);

create table departments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

create table courses (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  department_id uuid references departments(id) on delete set null,
  code text not null,
  title text not null,
  term text,
  cohort text,
  created_at timestamptz not null default now()
);

create table course_members (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  course_id uuid not null references courses(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null check (role in ('student','instructor','reviewer')),
  created_at timestamptz not null default now(),
  unique (course_id, user_id, role)
);

create table rubrics (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  title text not null,
  criteria jsonb not null, -- [{id,title,description,max_points}]
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);

create table assignments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  course_id uuid not null references courses(id) on delete cascade,
  title text not null,
  instructions text not null default '',
  due_at timestamptz,
  accepted_types text[] not null default array['editor','txt','docx','pdf'],
  max_attempts integer not null default 3,
  similarity_settings jsonb not null default '{"exclude_quotes":true,"exclude_bibliography":true,"min_match_words":8,"compare_within_class":true,"include_repository":true}'::jsonb,
  assistance_preset text not null default 'guided_learning',
  assistance_policy jsonb not null,
  policy_version integer not null default 1,
  feedback_release text not null default 'manual' check (feedback_release in ('manual')),
  rubric_id uuid references rubrics(id),
  template_text text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table assignment_policy_versions (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references assignments(id) on delete cascade,
  version integer not null,
  preset text not null,
  policy jsonb not null,
  created_at timestamptz not null default now(),
  unique (assignment_id, version)
);

-- ---------------------------------------------------------------- documents
create table folders (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references users(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

create table documents (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references users(id) on delete cascade,
  org_id uuid references organizations(id) on delete cascade, -- null = personal workspace
  assignment_id uuid references assignments(id) on delete set null,
  folder_id uuid references folders(id) on delete set null,
  title text not null,
  language text not null default 'en',
  english_variant text not null default 'en-US',
  current_version_id uuid,
  current_version_no integer not null default 0,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (assignment_id is null or org_id is not null)
);

create table document_versions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents(id) on delete cascade,
  owner_user_id uuid not null references users(id) on delete cascade,
  org_id uuid references organizations(id) on delete cascade,
  version_no integer not null,
  content_html text not null,
  content_text text not null,
  content_hash text not null,
  word_count integer not null,
  origin text not null default 'edit' check (origin in ('edit','import','suggestion','restore','rewrite')),
  frozen boolean not null default false, -- true once referenced by a submission or report
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (document_id, version_no)
);
alter table documents add constraint documents_current_version_fk
  foreign key (current_version_id) references document_versions(id) deferrable initially deferred;

-- Prevent edits to frozen versions at the database level.
create or replace function forbid_frozen_update() returns trigger language plpgsql as $$
begin
  if old.frozen and (new.content_html is distinct from old.content_html
                     or new.content_text is distinct from old.content_text
                     or new.content_hash is distinct from old.content_hash) then
    raise exception 'document version % is frozen', old.id using errcode = 'P0001';
  end if;
  if old.frozen and not new.frozen then
    raise exception 'document version % cannot be unfrozen', old.id using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger document_versions_frozen before update on document_versions
  for each row execute function forbid_frozen_update();

create table document_events (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents(id) on delete cascade,
  version_id uuid references document_versions(id) on delete cascade,
  user_id uuid references users(id) on delete set null,
  kind text not null check (kind in ('import','paste','suggestion_accepted','suggestion_rejected','rewrite_accepted','summary_inserted','restore','submission','export')),
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table files (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references users(id) on delete cascade,
  org_id uuid references organizations(id) on delete cascade,
  storage_key text not null unique,
  filename text not null,
  mime text not null,
  size_bytes integer not null,
  sha256 text not null,
  created_at timestamptz not null default now()
);

create table imports (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references users(id) on delete cascade,
  document_id uuid references documents(id) on delete cascade,
  file_id uuid not null references files(id) on delete cascade,
  status text not null check (status in ('extracting','needs_review','needs_ocr','failed','completed')),
  detected_type text,
  extracted_html text,
  extracted_text text,
  warnings jsonb not null default '[]'::jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table comments (
  id uuid primary key default gen_random_uuid(),
  document_id uuid references documents(id) on delete cascade,
  submission_id uuid,
  org_id uuid references organizations(id) on delete cascade,
  author_id uuid not null references users(id) on delete cascade,
  body text not null,
  quote text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- writing
create table suggestions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents(id) on delete cascade,
  version_id uuid not null references document_versions(id) on delete cascade,
  report_id uuid,
  category text not null,
  rule_id text not null,
  start_offset integer not null,
  end_offset integer not null,
  original text not null,
  replacement text,
  explanation text not null,
  status text not null default 'open' check (status in ('open','accepted','rejected','ignored','outdated')),
  decided_at timestamptz,
  created_at timestamptz not null default now()
);

create table personal_dictionary (
  user_id uuid not null references users(id) on delete cascade,
  word citext not null,
  primary key (user_id, word)
);

create table org_terminology (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  term text not null,
  preferred text,
  note text,
  unique (org_id, term)
);

create table learning_events (
  id bigserial primary key,
  user_id uuid not null references users(id) on delete cascade,
  rule_id text not null,
  category text not null,
  outcome text not null, -- flagged | accepted | rejected | practiced
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- sources & similarity
create table sources (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid references users(id) on delete cascade,
  org_id uuid references organizations(id) on delete cascade,
  scope text not null check (scope in ('personal','institution_repository','assignment_template','submission','demo')),
  title text not null,
  url text,
  author text,
  content_text text not null,
  token_count integer not null,
  submission_id uuid,
  assignment_id uuid references assignments(id) on delete cascade,
  student_id uuid references users(id) on delete cascade,
  lineage_id uuid,
  inclusion_reason text, -- why this source is in the repository (explicit policy)
  created_at timestamptz not null default now()
);

create table fingerprints (
  source_id uuid not null references sources(id) on delete cascade,
  owner_user_id uuid,
  org_id uuid,
  hash bigint not null,
  pos integer not null
);
create index fingerprints_hash_idx on fingerprints (hash);
create index fingerprints_source_idx on fingerprints (source_id);

create table analysis_jobs (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('similarity','writing','citations')),
  document_id uuid references documents(id) on delete cascade,
  version_id uuid not null references document_versions(id) on delete cascade,
  submission_id uuid,
  org_id uuid references organizations(id) on delete cascade,
  owner_user_id uuid not null references users(id) on delete cascade,
  requested_by uuid not null references users(id) on delete cascade,
  status text not null default 'queued' check (status in ('queued','processing','completed','partial','failed','cancelled')),
  idempotency_key text not null unique,
  settings jsonb not null default '{}'::jsonb,
  attempts integer not null default 0,
  max_attempts integer not null default 3,
  progress integer not null default 0,
  error text,
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create index analysis_jobs_status_idx on analysis_jobs (status, created_at);

create table reports (
  id uuid primary key default gen_random_uuid(),
  report_number text not null unique,
  job_id uuid references analysis_jobs(id) on delete set null,
  kind text not null,
  document_id uuid references documents(id) on delete cascade,
  version_id uuid not null references document_versions(id) on delete cascade,
  submission_id uuid,
  org_id uuid references organizations(id) on delete cascade,
  owner_user_id uuid not null references users(id) on delete cascade,
  status text not null, -- completed | no_sources | insufficient_text | unsupported_language | failed
  settings jsonb not null,
  result jsonb not null,
  engine text not null,
  engine_version text not null,
  created_at timestamptz not null default now()
);

create table similarity_matches (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references reports(id) on delete cascade,
  source_id uuid references sources(id) on delete set null,
  doc_char_start integer not null,
  doc_char_end integer not null,
  doc_token_start integer not null,
  doc_token_end integer not null, -- exclusive
  source_char_start integer not null,
  source_char_end integer not null,
  length_tokens integer not null,
  auto_excluded_reason text
);

create table report_exclusions (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references reports(id) on delete cascade,
  target_type text not null check (target_type in ('source','match')),
  target_id uuid not null,
  reason text not null,
  reviewer_id uuid not null references users(id),
  created_at timestamptz not null default now(),
  reverted_at timestamptz,
  reverted_by uuid references users(id)
);

create table report_shares (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references reports(id) on delete cascade,
  token_hash text not null unique,
  created_by uuid not null references users(id),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- citations
create table refs (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid references users(id) on delete cascade,
  org_id uuid references organizations(id) on delete cascade,
  csl jsonb not null,
  doi text,
  url text,
  isbn text,
  tags text[] not null default '{}',
  notes text,
  -- three separate questions (spec §9): existence, metadata accuracy, claim support
  existence_status text not null default 'unverified' check (existence_status in ('unverified','verified','not_found','lookup_unavailable')),
  metadata_status text not null default 'user_entered' check (metadata_status in ('user_entered','from_registry','user_corrected','incomplete')),
  support_status text not null default 'not_assessed' check (support_status in ('not_assessed','user_confirmed','disputed')),
  verified_via text,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (owner_user_id is not null or org_id is not null)
);

create table document_refs (
  document_id uuid not null references documents(id) on delete cascade,
  ref_id uuid not null references refs(id) on delete cascade,
  primary key (document_id, ref_id)
);

-- ---------------------------------------------------------------- assessment
create table submissions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  assignment_id uuid not null references assignments(id) on delete cascade,
  student_id uuid not null references users(id) on delete cascade,
  document_id uuid not null references documents(id) on delete restrict,
  version_id uuid not null references document_versions(id) on delete restrict,
  attempt_no integer not null,
  lineage_id uuid not null, -- shared by all attempts of a student on an assignment
  content_hash text not null,
  received_at timestamptz not null default now(),
  policy_version integer not null,
  is_late boolean not null,
  disclosure text,
  idempotency_key text not null unique,
  created_at timestamptz not null default now(),
  unique (assignment_id, student_id, attempt_no)
);

create or replace function forbid_submission_update() returns trigger language plpgsql as $$
begin
  if new.version_id <> old.version_id or new.content_hash <> old.content_hash
     or new.received_at <> old.received_at or new.policy_version <> old.policy_version then
    raise exception 'submissions are immutable' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger submissions_immutable before update on submissions
  for each row execute function forbid_submission_update();

create table grades (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  submission_id uuid not null unique references submissions(id) on delete cascade,
  rubric_scores jsonb not null default '{}'::jsonb,
  total numeric,
  max_total numeric,
  feedback text not null default '',
  status text not null default 'draft' check (status in ('draft','approved','released','revision_requested')),
  ai_assisted boolean not null default false,
  graded_by uuid references users(id),
  approved_by uuid references users(id),
  approved_at timestamptz,
  released_at timestamptz,
  updated_at timestamptz not null default now()
);

create table feedback_snippets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  owner_id uuid not null references users(id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now()
);

create table feedback_responses (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  submission_id uuid not null references submissions(id) on delete cascade,
  author_id uuid not null references users(id),
  kind text not null check (kind in ('response','appeal')),
  body text not null,
  status text not null default 'open' check (status in ('open','upheld','changed','closed')),
  decision text,
  decided_by uuid references users(id),
  decided_at timestamptz,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- billing
create table plans (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  audience text not null,
  -- {"USD":{"monthly":null,"annual":null},"TZS":{...}}; null = price not yet approved
  prices jsonb not null default '{"USD":{"monthly":null,"annual":null},"TZS":{"monthly":null,"annual":null}}'::jsonb,
  limits jsonb not null, -- {documents, storage_mb, words_per_month, similarity_checks_per_month, seats}
  features jsonb not null,
  active boolean not null default true,
  updated_at timestamptz not null default now()
);

create table subscriptions (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid references users(id) on delete cascade,
  org_id uuid references organizations(id) on delete cascade,
  plan_id uuid not null references plans(id),
  status text not null check (status in ('trialing','active','past_due','cancelled')),
  billing_interval text not null default 'monthly' check (billing_interval in ('monthly','annual')),
  seats integer,
  current_period_start timestamptz not null default now(),
  current_period_end timestamptz not null default now() + interval '1 month',
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  check ((owner_user_id is null) <> (org_id is null))
);

create table usage_records (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid references users(id) on delete cascade,
  org_id uuid references organizations(id) on delete cascade,
  kind text not null check (kind in ('similarity_check','writing_check','rewrite_words','summary_words')),
  quantity integer not null,
  job_id uuid,
  idempotency_key text not null unique, -- retries/duplicates cannot double charge
  period text not null, -- YYYY-MM
  created_at timestamptz not null default now()
);

create table invoices (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  subscription_id uuid references subscriptions(id),
  number text not null unique,
  amount numeric not null,
  currency text not null check (currency in ('TZS','USD')),
  status text not null default 'open' check (status in ('draft','open','paid','void')),
  due_at timestamptz,
  paid_at timestamptz,
  reconciliation jsonb,
  created_at timestamptz not null default now()
);

create table payment_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  provider_event_id text not null,
  type text not null,
  payload jsonb not null,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (provider, provider_event_id)
);

-- ---------------------------------------------------------------- platform
create table audit_events (
  id bigserial primary key,
  org_id uuid,
  actor_id uuid,
  action text not null,
  target_type text,
  target_id text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_events_org_idx on audit_events (org_id, created_at desc);

create table support_access_grants (
  id uuid primary key default gen_random_uuid(),
  platform_admin_id uuid not null references users(id),
  document_id uuid not null references documents(id) on delete cascade,
  justification text not null check (length(justification) >= 20),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at <= created_at + interval '24 hours')
);

create table feature_flags (
  key text primary key,
  enabled boolean not null default false,
  description text not null
);

-- ---------------------------------------------------------------- authorization helpers
-- SECURITY DEFINER so policies can consult memberships without recursion.
create or replace function app_org_roles(p_org uuid) returns text[] language sql stable security definer set search_path = public as
$$ select coalesce((select roles from memberships where org_id = p_org and user_id = app_uid() and status = 'active'), '{}'::text[]) $$;

create or replace function app_teaches_assignment(p_assignment uuid) returns boolean language sql stable security definer set search_path = public as
$$ select exists (
     select 1 from assignments a
     join course_members cm on cm.course_id = a.course_id and cm.user_id = app_uid() and cm.role in ('instructor','reviewer')
     where a.id = p_assignment)
   or exists (select 1 from assignments a where a.id = p_assignment and 'org_admin' = any(app_org_roles(a.org_id))) $$;

create or replace function app_support_grant(p_doc uuid) returns boolean language sql stable security definer set search_path = public as
$$ select exists (select 1 from support_access_grants g where g.document_id = p_doc and g.platform_admin_id = app_uid()
                  and g.revoked_at is null and g.expires_at > now()) $$;

create or replace function app_can_read_version(p_version uuid) returns boolean language sql stable security definer set search_path = public as
$$ select exists (select 1 from submissions s where s.version_id = p_version and app_teaches_assignment(s.assignment_id)) $$;

-- Background job scope: a job may read rows of its own tenant only.
create or replace function app_job_scope(p_org uuid, p_owner uuid) returns boolean language sql stable as
$$ select app_job_user() is not null and (
     (app_job_org() is not null and p_org = app_job_org())
     or (p_org is null and p_owner = app_job_user())) $$;

-- ---------------------------------------------------------------- row-level security
alter table documents enable row level security;
create policy documents_access on documents using (
  owner_user_id = app_uid()
  or app_support_grant(id)
  or app_job_scope(org_id, owner_user_id)
) with check (owner_user_id = app_uid() or app_job_scope(org_id, owner_user_id));

alter table document_versions enable row level security;
create policy versions_access on document_versions using (
  owner_user_id = app_uid()
  or app_can_read_version(id)
  or app_support_grant(document_id)
  or app_job_scope(org_id, owner_user_id)
) with check (owner_user_id = app_uid() or app_job_scope(org_id, owner_user_id));
-- freezing a submitted version is done by the owner (student) within the submit transaction

alter table sources enable row level security;
create policy sources_access on sources using (
  (scope = 'demo')
  or (scope = 'personal' and owner_user_id = app_uid())
  or (org_id is not null and scope in ('institution_repository','assignment_template') and app_org_roles(org_id) && array['org_admin','instructor','reviewer'])
  or (scope = 'assignment_template' and assignment_id is not null and app_teaches_assignment(assignment_id))
  or (scope = 'submission' and (student_id = app_uid() or app_teaches_assignment(assignment_id)))
  or app_job_scope(org_id, owner_user_id)
) with check (
  (scope = 'personal' and owner_user_id = app_uid() and org_id is null)
  or (org_id is not null and 'org_admin' = any(app_org_roles(org_id)))
  or (scope = 'assignment_template' and app_teaches_assignment(assignment_id))
  or app_job_scope(org_id, owner_user_id)
  or (scope = 'submission' and student_id = app_uid())
);

alter table fingerprints enable row level security;
create policy fingerprints_access on fingerprints using (
  exists (select 1 from sources s where s.id = source_id)
) with check (exists (select 1 from sources s where s.id = source_id));

alter table reports enable row level security;
create policy reports_access on reports using (
  owner_user_id = app_uid()
  or (submission_id is not null and exists (select 1 from submissions s where s.id = submission_id and app_teaches_assignment(s.assignment_id)))
  or app_job_scope(org_id, owner_user_id)
) with check (app_job_scope(org_id, owner_user_id) or owner_user_id = app_uid());

alter table submissions enable row level security;
create policy submissions_access on submissions using (
  student_id = app_uid()
  or app_teaches_assignment(assignment_id)
  or app_job_scope(org_id, student_id)
) with check (student_id = app_uid());

alter table refs enable row level security;
create policy refs_access on refs using (
  (org_id is null and owner_user_id = app_uid())
  or (org_id is not null and cardinality(app_org_roles(org_id)) > 0)
) with check (
  (org_id is null and owner_user_id = app_uid())
  or (org_id is not null and 'org_admin' = any(app_org_roles(org_id)))
);

-- Resolves the tenant of a report ONLY when a live share link exists for it.
create or replace function report_shares_lookup(p_report uuid) returns table(owner_user_id uuid, org_id uuid)
language sql stable security definer set search_path = public as
$$ select r.owner_user_id, r.org_id from reports r where r.id = p_report
   and exists (select 1 from report_shares s where s.report_id = p_report and s.revoked_at is null and s.expires_at > now()) $$;

-- Lets a platform admin confirm a document exists (and its tenant) without reading content.
create or replace function support_lookup_document(p_doc uuid) returns table(org_id uuid)
language sql stable security definer set search_path = public as
$$ select d.org_id from documents d where d.id = p_doc $$;

insert into feature_flags(key, enabled, description) values
  ('guest_demo', true, 'Rate-limited guest demonstration on the homepage'),
  ('offline_drafts', true, 'Allow offline drafting in personal workspaces'),
  ('swahili_analysis_beta', false, 'Swahili writing analysis (requires evaluation before enabling)'),
  ('ai_detection', false, 'AI-text detection integration (Phase 3, provider required)');

-- ---------------------------------------------------------------- grants
grant usage on schema public to elimu_app;
grant select, insert, update, delete on all tables in schema public to elimu_app;
grant usage, select on all sequences in schema public to elimu_app;
grant execute on all functions in schema public to elimu_app;
