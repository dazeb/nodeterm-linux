import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Pool } from 'pg'

const migrationsDir = join(__dirname, 'migrations')

export function createPool(connectionString: string): Pool {
  return new Pool({ connectionString })
}

export async function migrate(pool: Pool): Promise<void> {
  await pool.query('create table if not exists relay_schema_migrations (name text primary key)')
  const migrations = (await readdir(migrationsDir)).filter((name) => name.endsWith('.sql')).sort()
  for (const name of migrations) {
    const applied = await pool.query<{ name: string }>('select name from relay_schema_migrations where name = $1', [name])
    if (applied.rowCount) continue
    const sql = await readFile(join(migrationsDir, name), 'utf8')
    const client = await pool.connect()
    try {
      await client.query('begin')
      await client.query(sql)
      await client.query('insert into relay_schema_migrations(name) values($1)', [name])
      await client.query('commit')
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }
  }
}
