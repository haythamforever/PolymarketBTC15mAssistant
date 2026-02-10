/**
 * PostgreSQL Connection Pool
 * Uses DATABASE_URL env var. Returns null if not configured (file-based fallback).
 */

import pg from 'pg';
const { Pool } = pg;

let pool = null;
let dbAvailable = false;

export function getPool() { return pool; }
export function isDbAvailable() { return dbAvailable; }

export async function initPool() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log('  [db] DATABASE_URL not set — using file-based storage');
    return false;
  }

  try {
    pool = new Pool({
      connectionString: url,
      ssl: url.includes('localhost') || url.includes('127.0.0.1') ? false : { rejectUnauthorized: false },
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });

    // Test the connection
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();

    dbAvailable = true;
    console.log('  [db] PostgreSQL connected');
    return true;
  } catch (err) {
    console.error(`  [db] PostgreSQL connection failed: ${err.message}`);
    console.log('  [db] Falling back to file-based storage');
    pool = null;
    dbAvailable = false;
    return false;
  }
}

export async function query(text, params) {
  if (!pool) throw new Error('DB pool not initialized');
  return pool.query(text, params);
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
    dbAvailable = false;
  }
}
