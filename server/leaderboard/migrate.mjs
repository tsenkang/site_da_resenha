#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const MIGRATION_NAME = /^\d{3}_[a-z0-9_]+\.sql$/;
const here = dirname(fileURLToPath(import.meta.url));

export async function readMigrations(directory = join(here, 'migrations')) {
  const names = (await readdir(directory)).filter(name => MIGRATION_NAME.test(name)).sort();
  if (names.length === 0) throw new Error('No leaderboard migrations found');
  return Promise.all(names.map(async name => {
    const sql = await readFile(join(directory, name), 'utf8');
    return { name, sql, sha256: createHash('sha256').update(sql).digest('hex') };
  }));
}

export async function applyMigrations(connection, migrations) {
  await connection.query(`CREATE TABLE IF NOT EXISTS game_lb_schema_migrations (
    name VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
    sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
  )`);
  const [rows] = await connection.query('SELECT name,sha256 FROM game_lb_schema_migrations');
  const applied = new Map(rows.map(row => [row.name, row.sha256]));
  const available = new Set(migrations.map(migration => migration.name));
  for (const name of applied.keys()) {
    if (!available.has(name)) throw new Error(`Applied migration ${name} is missing from the project`);
  }
  for (const migration of migrations) {
    const previous = applied.get(migration.name);
    if (previous && previous !== migration.sha256) {
      throw new Error(`Migration ${migration.name} changed after it was applied`);
    }
    if (previous) continue;
    await connection.query(migration.sql);
    await connection.execute(
      'INSERT INTO game_lb_schema_migrations (name,sha256) VALUES (?,?)',
      [migration.name, migration.sha256],
    );
  }
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('Project DATABASE_URL is required');
  const connection = await mysql.createConnection({
    uri: process.env.DATABASE_URL,
    multipleStatements: true,
    connectTimeout: 5000,
  });
  try {
    await applyMigrations(connection, await readMigrations());
    console.log('Leaderboard database migrations are current');
  } finally {
    await connection.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
