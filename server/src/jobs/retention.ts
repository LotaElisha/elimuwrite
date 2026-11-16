/**
 * Retention sweep. Removes submissions (and their frozen versions, sources, fingerprints,
 * reports, grades) older than each institution's retention_days. Runs with the owner
 * connection because it acts on behalf of the institution's configured policy.
 */
import pg from 'pg';
import { config } from '../config.js';

export async function runRetention(url = config.ownerDatabaseUrl) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query('begin');
    const expired = await c.query(
      `select s.id, s.document_id, s.version_id from submissions s join organizations o on o.id=s.org_id
       where s.received_at < now() - ((o.settings->>'retention_days')::int || ' days')::interval`);
    for (const s of expired.rows) {
      await c.query(`delete from sources where submission_id=$1`, [s.id]);
      await c.query(`delete from reports where submission_id=$1`, [s.id]);
      await c.query(`delete from submissions where id=$1`, [s.id]);
      // the frozen version stays only if another submission still references it
      await c.query(`delete from document_versions v where v.id=$1 and not exists (select 1 from submissions x where x.version_id=v.id)
                     and v.id <> (select current_version_id from documents where id=v.document_id)`, [s.version_id]);
    }
    await c.query(`insert into audit_events(action, detail) values ('retention.sweep', $1)`, [JSON.stringify({ submissions_removed: expired.rowCount })]);
    await c.query('commit');
    return { submissions_removed: expired.rowCount };
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    await c.end();
  }
}
