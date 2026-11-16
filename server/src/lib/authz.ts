/**
 * Application-layer authorization. Row-level security in Postgres is the second line
 * of defence; these checks are the first and produce clear errors.
 */
import type { Db } from '../db.js';
import { one } from '../db.js';
import { forbidden, notFound, HttpError } from './misc.js';
import { resolvePolicy, type Capability } from '../engines/policy.js';

export type OrgRole = 'student' | 'instructor' | 'reviewer' | 'org_admin' | 'billing_admin';

export async function orgRoles(db: Db, orgId: string, userId: string): Promise<OrgRole[]> {
  const r = await one(db, `select roles from memberships where org_id=$1 and user_id=$2 and status='active'`, [orgId, userId]);
  return r?.roles ?? [];
}

/** Non-members get 404 (cannot learn the org exists); members lacking the role get 403. */
export async function requireOrgRole(db: Db, orgId: string, userId: string, allowed: OrgRole[] | 'any'): Promise<OrgRole[]> {
  const roles = await orgRoles(db, orgId, userId);
  if (!roles.length) throw notFound('Organization');
  if (allowed !== 'any' && !roles.some((r) => allowed.includes(r))) throw forbidden();
  return roles;
}

export async function courseRole(db: Db, courseId: string, userId: string) {
  const c = await one(db, `select id, org_id from courses where id=$1`, [courseId]);
  if (!c) throw notFound('Course');
  const roles = await orgRoles(db, c.org_id, userId);
  if (!roles.length) throw notFound('Course');
  const cm = await db.query(`select role from course_members where course_id=$1 and user_id=$2`, [courseId, userId]);
  const courseRoles: string[] = cm.rows.map((r) => r.role);
  return {
    orgId: c.org_id as string,
    orgRoles: roles,
    isInstructor: courseRoles.includes('instructor') || courseRoles.includes('reviewer') || roles.includes('org_admin'),
    isStudent: courseRoles.includes('student'),
  };
}

export async function requireTeaches(db: Db, assignmentId: string) {
  const r = await one(db, `select app_teaches_assignment($1) as ok, (select org_id from assignments where id=$1) as org_id`, [assignmentId]);
  if (!r?.org_id) throw notFound('Assignment');
  if (!r.ok) throw notFound('Assignment');
  return r.org_id as string;
}

/** Loads a document the caller owns. RLS hides others' documents, so absence => 404. */
export async function ownDocument(db: Db, docId: string, userId: string) {
  const d = await one(db, `select * from documents where id=$1 and deleted_at is null`, [docId]);
  if (!d || d.owner_user_id !== userId) throw notFound('Document');
  return d;
}

/**
 * Server-side assistance-policy enforcement for work in an assignment context.
 * A personal subscription never overrides it: this runs before any entitlement check.
 */
export async function enforceCapability(db: Db, doc: { assignment_id: string | null } | null, cap: Capability) {
  if (!doc?.assignment_id) return null;
  const a = await one(db, `select assistance_preset, assistance_policy, policy_version, title from assignments where id=$1`, [doc.assignment_id]);
  if (!a) return null;
  const policy = resolvePolicy(a.assistance_preset, a.assistance_policy);
  if (!policy[cap]) {
    throw new HttpError(403, 'policy_blocked', `The assignment "${a.title}" does not allow ${cap} assistance.`, { capability: cap, policy_version: a.policy_version });
  }
  return policy;
}
