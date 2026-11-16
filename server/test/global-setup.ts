import pg from 'pg';

const OWNER = process.env.TEST_OWNER_DATABASE_URL ?? 'postgres://elimu_owner:elimu_owner@localhost:5432/elimuwrite_test';

export default async function setup() {
  if (!/_test\b/.test(OWNER)) throw new Error('Refusing to reset a database whose name does not end in _test');
  const c = new pg.Client({ connectionString: OWNER });
  await c.connect();
  await c.query('drop owned by elimu_owner cascade');
  await c.end();
  process.env.OWNER_DATABASE_URL = OWNER;
  const { migrate } = await import('../src/migrate.js');
  await migrate(OWNER);
  const s = new pg.Client({ connectionString: OWNER });
  await s.connect();
  const plans: [string, string, object][] = [
    ['free', 'Free', { documents: 20, storage_mb: 50, words_per_month: 20000, similarity_checks_per_month: 3, seats: 1 }],
    ['personal_pro', 'Personal Pro', { documents: null, storage_mb: 2000, words_per_month: 300000, similarity_checks_per_month: 50, seats: 1 }],
    ['institution', 'Institution', { documents: null, storage_mb: null, words_per_month: null, similarity_checks_per_month: 5000, seats: 500 }],
  ];
  for (const [code, name, limits] of plans) await s.query(`insert into plans(code, name, audience, limits, features) values ($1,$2,'test',$3,'{}')`, [code, name, JSON.stringify(limits)]);
  await s.end();
}
