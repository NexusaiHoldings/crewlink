/**
 * Worker signal data layer — records accept/decline responses from field crew
 * and provides query helpers for the schedule and job-detail pages.
 *
 * Uses the same singleton-pool pattern as apps/web/lib/db.ts so pg is never
 * double-required. Tables are created on first call (CREATE TABLE IF NOT EXISTS)
 * so the app boots without a separate migration step.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _dispatchPool: any = null;
let _schemaReady = false;

function getDispatchPool(): {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
} {
  if (_dispatchPool) return _dispatchPool;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Pool: PgPool } = require("pg") as {
    Pool: new (cfg: Record<string, unknown>) => {
      query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
    };
  };
  _dispatchPool = new PgPool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
  });
  return _dispatchPool;
}

export type SignalType = "accept" | "decline";

export interface DispatchJob {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  customerName: string | null;
  customerPhone: string | null;
  notes: string | null;
  scheduledAt: Date | null;
  estimatedDurationMinutes: number | null;
  status: string;
  assignmentStatus: string | null;
  workerSignalType: SignalType | null;
}

export interface WorkerSignal {
  id: string;
  jobId: string;
  workerId: string;
  signalType: SignalType;
  reason: string | null;
  recordedAt: Date;
}

export interface WorkerReliabilityStats {
  workerId: string;
  totalAssigned: number;
  totalAccepted: number;
  totalDeclined: number;
  acceptanceRate: number;
}

export async function ensureDispatchSchema(): Promise<void> {
  if (_schemaReady) return;
  const pool = getDispatchPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dispatch_jobs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title TEXT NOT NULL,
      description TEXT,
      location TEXT,
      customer_name TEXT,
      customer_phone TEXT,
      notes TEXT,
      scheduled_at TIMESTAMPTZ,
      estimated_duration_minutes INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dispatch_job_assignments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      job_id UUID NOT NULL,
      worker_id TEXT NOT NULL,
      worker_email TEXT,
      status TEXT NOT NULL DEFAULT 'assigned',
      assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      responded_at TIMESTAMPTZ,
      UNIQUE(job_id, worker_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dispatch_worker_signals (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      job_id UUID NOT NULL,
      worker_id TEXT NOT NULL,
      assignment_id UUID,
      signal_type TEXT NOT NULL,
      reason TEXT,
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  _schemaReady = true;
}

export async function recordWorkerSignal(params: {
  jobId: string;
  workerId: string;
  signalType: SignalType;
  reason?: string;
}): Promise<WorkerSignal> {
  const pool = getDispatchPool();
  await pool.query(
    `UPDATE dispatch_job_assignments
     SET status = $1, responded_at = NOW()
     WHERE job_id = $2 AND worker_id = $3`,
    [params.signalType === "accept" ? "accepted" : "declined", params.jobId, params.workerId],
  );
  const result = await pool.query(
    `INSERT INTO dispatch_worker_signals (job_id, worker_id, signal_type, reason)
     VALUES ($1, $2, $3, $4)
     RETURNING id, job_id, worker_id, signal_type, reason, recorded_at`,
    [params.jobId, params.workerId, params.signalType, params.reason ?? null],
  );
  const rows = result.rows as Array<{
    id: string;
    job_id: string;
    worker_id: string;
    signal_type: string;
    reason: string | null;
    recorded_at: Date;
  }>;
  const row = rows[0];
  if (!row) throw new Error("Failed to insert worker signal");
  return {
    id: row.id,
    jobId: row.job_id,
    workerId: row.worker_id,
    signalType: row.signal_type as SignalType,
    reason: row.reason,
    recordedAt: row.recorded_at,
  };
}

export async function getJobsForWorker(workerId: string): Promise<DispatchJob[]> {
  const pool = getDispatchPool();
  const result = await pool.query(
    `SELECT
       j.id, j.title, j.description, j.location,
       j.customer_name, j.customer_phone, j.notes,
       j.scheduled_at, j.estimated_duration_minutes, j.status,
       a.status AS assignment_status,
       s.signal_type AS worker_signal_type
     FROM dispatch_jobs j
     INNER JOIN dispatch_job_assignments a ON a.job_id = j.id AND a.worker_id = $1
     LEFT JOIN LATERAL (
       SELECT signal_type FROM dispatch_worker_signals
       WHERE job_id = j.id AND worker_id = $1
       ORDER BY recorded_at DESC LIMIT 1
     ) s ON true
     ORDER BY j.scheduled_at ASC NULLS LAST`,
    [workerId],
  );
  const rows = result.rows as Array<{
    id: string; title: string; description: string | null;
    location: string | null; customer_name: string | null;
    customer_phone: string | null; notes: string | null;
    scheduled_at: Date | null; estimated_duration_minutes: number | null;
    status: string; assignment_status: string | null;
    worker_signal_type: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id, title: r.title, description: r.description,
    location: r.location, customerName: r.customer_name,
    customerPhone: r.customer_phone, notes: r.notes,
    scheduledAt: r.scheduled_at,
    estimatedDurationMinutes: r.estimated_duration_minutes,
    status: r.status, assignmentStatus: r.assignment_status,
    workerSignalType: r.worker_signal_type as SignalType | null,
  }));
}

export async function getJobById(
  jobId: string,
  workerId: string,
): Promise<DispatchJob | null> {
  const pool = getDispatchPool();
  const result = await pool.query(
    `SELECT
       j.id, j.title, j.description, j.location,
       j.customer_name, j.customer_phone, j.notes,
       j.scheduled_at, j.estimated_duration_minutes, j.status,
       a.status AS assignment_status,
       s.signal_type AS worker_signal_type
     FROM dispatch_jobs j
     LEFT JOIN dispatch_job_assignments a ON a.job_id = j.id AND a.worker_id = $2
     LEFT JOIN LATERAL (
       SELECT signal_type FROM dispatch_worker_signals
       WHERE job_id = j.id AND worker_id = $2
       ORDER BY recorded_at DESC LIMIT 1
     ) s ON true
     WHERE j.id = $1`,
    [jobId, workerId],
  );
  const rows = result.rows as Array<{
    id: string; title: string; description: string | null;
    location: string | null; customer_name: string | null;
    customer_phone: string | null; notes: string | null;
    scheduled_at: Date | null; estimated_duration_minutes: number | null;
    status: string; assignment_status: string | null;
    worker_signal_type: string | null;
  }>;
  if (!rows[0]) return null;
  const r = rows[0];
  return {
    id: r.id, title: r.title, description: r.description,
    location: r.location, customerName: r.customer_name,
    customerPhone: r.customer_phone, notes: r.notes,
    scheduledAt: r.scheduled_at,
    estimatedDurationMinutes: r.estimated_duration_minutes,
    status: r.status, assignmentStatus: r.assignment_status,
    workerSignalType: r.worker_signal_type as SignalType | null,
  };
}

export async function getWorkerReliabilityStats(
  workerId: string,
): Promise<WorkerReliabilityStats> {
  const pool = getDispatchPool();
  const result = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE status IN ('assigned', 'accepted', 'declined')) AS total_assigned,
       COUNT(*) FILTER (WHERE status = 'accepted') AS total_accepted,
       COUNT(*) FILTER (WHERE status = 'declined') AS total_declined
     FROM dispatch_job_assignments
     WHERE worker_id = $1`,
    [workerId],
  );
  const rows = result.rows as Array<{
    total_assigned: string;
    total_accepted: string;
    total_declined: string;
  }>;
  const r = rows[0] ?? { total_assigned: "0", total_accepted: "0", total_declined: "0" };
  const totalAssigned = parseInt(r.total_assigned, 10);
  const totalAccepted = parseInt(r.total_accepted, 10);
  const totalDeclined = parseInt(r.total_declined, 10);
  return {
    workerId,
    totalAssigned,
    totalAccepted,
    totalDeclined,
    acceptanceRate: totalAssigned > 0 ? totalAccepted / totalAssigned : 0,
  };
}
