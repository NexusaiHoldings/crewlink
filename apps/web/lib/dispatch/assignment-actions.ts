'use server';

import { Pool, PoolClient } from 'pg';
import { redirect } from 'next/navigation';

declare global {
  // eslint-disable-next-line no-var
  var _assignPool: Pool | undefined;
}

function getPool(): Pool {
  if (!global._assignPool) {
    global._assignPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30_000,
    });
  }
  return global._assignPool as Pool;
}

async function ensureTables(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS dispatch_jobs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title TEXT NOT NULL,
      customer_name TEXT NOT NULL DEFAULT '',
      customer_email TEXT,
      customer_phone TEXT,
      location_address TEXT NOT NULL DEFAULT '',
      location_lat NUMERIC(10, 7),
      location_lng NUMERIC(10, 7),
      required_certifications JSONB NOT NULL DEFAULT '[]',
      scheduled_start TIMESTAMPTZ,
      scheduled_end TIMESTAMPTZ,
      priority TEXT NOT NULL DEFAULT 'medium',
      status TEXT NOT NULL DEFAULT 'pending',
      notes TEXT,
      org_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS dispatch_assignments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      job_id UUID NOT NULL REFERENCES dispatch_jobs(id) ON DELETE CASCADE,
      worker_id TEXT NOT NULL,
      worker_name TEXT NOT NULL,
      assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      status TEXT NOT NULL DEFAULT 'active',
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS dispatch_workers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      phone TEXT,
      trade TEXT NOT NULL,
      certifications JSONB NOT NULL DEFAULT '[]',
      availability JSONB NOT NULL DEFAULT '{}',
      travel_zones JSONB NOT NULL DEFAULT '[]',
      reliability_score NUMERIC(5,2) NOT NULL DEFAULT 100,
      status TEXT NOT NULL DEFAULT 'active',
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export async function assignWorkerToJob(formData: FormData): Promise<void> {
  const jobId = (formData.get('jobId') as string)?.trim();
  const workerId = (formData.get('workerId') as string)?.trim();
  const notes = (formData.get('notes') as string)?.trim() || null;

  if (!jobId || !workerId) {
    throw new Error('jobId and workerId are required');
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await ensureTables(client);
    await client.query('BEGIN');

    const jobResult = await client.query(
      `SELECT id, status FROM dispatch_jobs WHERE id = $1`,
      [jobId],
    );
    if (jobResult.rows.length === 0) {
      await client.query('ROLLBACK');
      throw new Error('Job not found');
    }
    const jobStatus = (jobResult.rows[0] as Record<string, unknown>).status as string;
    if (jobStatus === 'completed' || jobStatus === 'cancelled') {
      await client.query('ROLLBACK');
      throw new Error(`Cannot assign a worker to a ${jobStatus} job`);
    }

    const workerResult = await client.query(
      `SELECT id, name, status FROM dispatch_workers WHERE id = $1`,
      [workerId],
    );
    if (workerResult.rows.length === 0) {
      await client.query('ROLLBACK');
      throw new Error('Worker not found');
    }
    const worker = workerResult.rows[0] as Record<string, unknown>;
    if (worker.status !== 'active') {
      await client.query('ROLLBACK');
      throw new Error('Worker is not active');
    }
    const workerName = worker.name as string;

    await client.query(
      `UPDATE dispatch_assignments SET status = 'cancelled' WHERE job_id = $1 AND status = 'active'`,
      [jobId],
    );

    await client.query(
      `INSERT INTO dispatch_assignments (job_id, worker_id, worker_name, notes)
       VALUES ($1, $2, $3, $4)`,
      [jobId, workerId, workerName, notes],
    );

    await client.query(
      `UPDATE dispatch_jobs SET status = 'assigned', updated_at = NOW() WHERE id = $1`,
      [jobId],
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  redirect(`/jobs/${jobId}`);
}
