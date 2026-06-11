import { Pool, PoolClient } from 'pg';

export type JobStatus = 'pending' | 'assigned' | 'in_progress' | 'completed' | 'cancelled';
export type JobPriority = 'low' | 'medium' | 'high' | 'urgent';

export interface Job {
  id: string;
  title: string;
  customerName: string;
  customerEmail: string | null;
  customerPhone: string | null;
  locationAddress: string;
  locationLat: number | null;
  locationLng: number | null;
  requiredCertifications: string[];
  scheduledStart: Date | null;
  scheduledEnd: Date | null;
  priority: JobPriority;
  status: JobStatus;
  notes: string | null;
  orgId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Assignment {
  id: string;
  jobId: string;
  workerId: string;
  workerName: string;
  assignedAt: Date;
  status: 'active' | 'completed' | 'cancelled';
  notes: string | null;
  createdAt: Date;
}

export interface JobWithAssignment extends Job {
  assignment: Assignment | null;
}

export interface CreateJobInput {
  title: string;
  customerName: string;
  customerEmail?: string;
  customerPhone?: string;
  locationAddress: string;
  requiredCertifications?: string[];
  scheduledStart?: string;
  scheduledEnd?: string;
  priority?: JobPriority;
  notes?: string;
  orgId?: string;
}

declare global {
  // eslint-disable-next-line no-var
  var _dispatchPool: Pool | undefined;
}

function getPool(): Pool {
  if (!global._dispatchPool) {
    global._dispatchPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30000,
    });
  }
  return global._dispatchPool as Pool;
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
}

function rowToJob(row: Record<string, unknown>): Job {
  const certs = row.required_certifications;
  const certArr: string[] = Array.isArray(certs)
    ? (certs as string[])
    : typeof certs === 'string'
    ? (JSON.parse(certs) as string[])
    : [];
  return {
    id: row.id as string,
    title: row.title as string,
    customerName: (row.customer_name as string) || '',
    customerEmail: (row.customer_email as string | null) ?? null,
    customerPhone: (row.customer_phone as string | null) ?? null,
    locationAddress: (row.location_address as string) || '',
    locationLat: row.location_lat != null ? Number(row.location_lat) : null,
    locationLng: row.location_lng != null ? Number(row.location_lng) : null,
    requiredCertifications: certArr,
    scheduledStart: row.scheduled_start ? new Date(row.scheduled_start as string) : null,
    scheduledEnd: row.scheduled_end ? new Date(row.scheduled_end as string) : null,
    priority: ((row.priority as string) || 'medium') as JobPriority,
    status: ((row.status as string) || 'pending') as JobStatus,
    notes: (row.notes as string | null) ?? null,
    orgId: (row.org_id as string | null) ?? null,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

function rowToAssignment(row: Record<string, unknown>): Assignment {
  return {
    id: row.id as string,
    jobId: row.job_id as string,
    workerId: row.worker_id as string,
    workerName: row.worker_name as string,
    assignedAt: new Date(row.assigned_at as string),
    status: ((row.status as string) || 'active') as Assignment['status'],
    notes: (row.notes as string | null) ?? null,
    createdAt: new Date(row.created_at as string),
  };
}

export async function getJobs(filters?: {
  status?: JobStatus;
  orgId?: string;
}): Promise<Job[]> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await ensureTables(client);
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;
    if (filters?.status) {
      conditions.push(`status = $${paramIdx++}`);
      params.push(filters.status);
    }
    if (filters?.orgId) {
      conditions.push(`org_id = $${paramIdx++}`);
      params.push(filters.orgId);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await client.query(
      `SELECT * FROM dispatch_jobs ${where} ORDER BY created_at DESC`,
      params,
    );
    return result.rows.map((r) => rowToJob(r as Record<string, unknown>));
  } catch (err) {
    console.error('[dispatch] getJobs error:', JSON.stringify(err));
    return [];
  } finally {
    client.release();
  }
}

export async function getJobById(id: string): Promise<Job | null> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await ensureTables(client);
    const result = await client.query(
      'SELECT * FROM dispatch_jobs WHERE id = $1',
      [id],
    );
    if (result.rows.length === 0) return null;
    return rowToJob(result.rows[0] as Record<string, unknown>);
  } catch (err) {
    console.error('[dispatch] getJobById error:', JSON.stringify(err));
    return null;
  } finally {
    client.release();
  }
}

export async function createJob(input: CreateJobInput): Promise<Job> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await ensureTables(client);
    const result = await client.query(
      `INSERT INTO dispatch_jobs (
        title, customer_name, customer_email, customer_phone,
        location_address, required_certifications,
        scheduled_start, scheduled_end, priority, notes, org_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING *`,
      [
        input.title,
        input.customerName,
        input.customerEmail ?? null,
        input.customerPhone ?? null,
        input.locationAddress,
        JSON.stringify(input.requiredCertifications ?? []),
        input.scheduledStart ? new Date(input.scheduledStart) : null,
        input.scheduledEnd ? new Date(input.scheduledEnd) : null,
        input.priority ?? 'medium',
        input.notes ?? null,
        input.orgId ?? null,
      ],
    );
    return rowToJob(result.rows[0] as Record<string, unknown>);
  } finally {
    client.release();
  }
}

export async function getAssignments(jobIds?: string[]): Promise<Assignment[]> {
  if (jobIds !== undefined && jobIds.length === 0) return [];
  const pool = getPool();
  const client = await pool.connect();
  try {
    await ensureTables(client);
    let query = `SELECT * FROM dispatch_assignments WHERE status = 'active'`;
    const params: unknown[] = [];
    if (jobIds && jobIds.length > 0) {
      query += ` AND job_id = ANY($1)`;
      params.push(jobIds);
    }
    query += ` ORDER BY assigned_at DESC`;
    const result = await client.query(query, params);
    return result.rows.map((r) => rowToAssignment(r as Record<string, unknown>));
  } catch (err) {
    console.error('[dispatch] getAssignments error:', JSON.stringify(err));
    return [];
  } finally {
    client.release();
  }
}

export async function getJobsWithAssignments(orgId?: string): Promise<JobWithAssignment[]> {
  const jobs = await getJobs(orgId ? { orgId } : undefined);
  if (jobs.length === 0) return [];
  const jobIds = jobs.map((j) => j.id);
  const assignments = await getAssignments(jobIds);
  const assignmentMap = new Map<string, Assignment>();
  for (const a of assignments) {
    assignmentMap.set(a.jobId, a);
  }
  return jobs.map((job) => ({
    ...job,
    assignment: assignmentMap.get(job.id) ?? null,
  }));
}
