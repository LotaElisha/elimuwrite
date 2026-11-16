import pg from 'pg';
import { readdirSync, readFileSync } from 'node:fs';
import { config } from './config.js';

export async function migrate(url = config.ownerDatabaseUrl) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz default now())');
  const dir = new URL('../migrations/', import.meta.url).pathname;
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    const done = await client.query('select 1 from schema_migrations where name=$1', [f]);
    if (done.rowCount) continue;
    await client.query('begin');
    await client.query(readFileSync(dir + f, 'utf8'));
    await client.query('insert into schema_migrations(name) values ($1)', [f]);
    await client.query('commit');
    console.log('applied', f);
  }
  await client.end();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate().catch((e) => { console.error(e); process.exit(1); });
}
