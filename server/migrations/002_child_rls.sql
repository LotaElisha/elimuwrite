-- Row-level security for tables whose rows belong to a parent that is already protected.
-- Each policy defers to the parent's policy through an EXISTS subquery, which is itself
-- filtered by RLS, so a row is visible exactly when its parent is.
-- (report_shares stays application-checked: it is looked up by token hash before any user context exists.)

alter table similarity_matches enable row level security;
create policy matches_access on similarity_matches
  using (exists (select 1 from reports r where r.id = report_id))
  with check (exists (select 1 from reports r where r.id = report_id));

alter table report_exclusions enable row level security;
create policy exclusions_access on report_exclusions
  using (exists (select 1 from reports r where r.id = report_id))
  with check (exists (select 1 from reports r where r.id = report_id));

alter table suggestions enable row level security;
create policy suggestions_access on suggestions
  using (exists (select 1 from documents d where d.id = document_id))
  with check (exists (select 1 from documents d where d.id = document_id));

alter table document_events enable row level security;
create policy events_access on document_events
  using (exists (select 1 from documents d where d.id = document_id)
         or exists (select 1 from submissions s where s.document_id = document_events.document_id))
  with check (exists (select 1 from documents d where d.id = document_id));

-- Grades and feedback: visible to whoever can see the submission (the student and the course's
-- staff); release to the student is enforced by the application. Only staff may write grades.
alter table grades enable row level security;
create policy grades_read on grades for select
  using (exists (select 1 from submissions s where s.id = submission_id));
create policy grades_write on grades for all
  using (exists (select 1 from submissions s where s.id = submission_id and app_teaches_assignment(s.assignment_id)))
  with check (exists (select 1 from submissions s where s.id = submission_id and app_teaches_assignment(s.assignment_id)));

alter table feedback_responses enable row level security;
create policy responses_access on feedback_responses
  using (exists (select 1 from submissions s where s.id = submission_id))
  with check (exists (select 1 from submissions s where s.id = submission_id));

alter table comments enable row level security;
create policy comments_access on comments
  using ((submission_id is not null and exists (select 1 from submissions s where s.id = submission_id))
         or (document_id is not null and exists (select 1 from documents d where d.id = document_id)))
  with check ((submission_id is not null and exists (select 1 from submissions s where s.id = submission_id))
         or (document_id is not null and exists (select 1 from documents d where d.id = document_id)));
