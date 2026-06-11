/**
 * Real-Time Reassignment Engine
 *
 * When a cancellation, no-show, or job overrun is detected, selects the
 * nearest available qualified worker within seconds. Candidates ranked by
 * proximity, certification match, and reliability score. Overtime-triggering
 * reassignments are flagged for manager confirmation.
 *
 * All events logged to crew_dispatch_events for audit and RL training data.
 */

import crypto from "crypto";

// ---------------------------------------------------------------------------
// DB pool (raw pg — no ORM)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _pool: any = null;

function getPool(): {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
} {
  if (_pool) return _pool;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Pool: PgPool } = require("pg") as {
    Pool: new (cfg: Record<string, unknown>) => {
      query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
    };
  };
  _pool = new PgPool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
  });
  return _pool;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DispatchWorker {
  id: string;
  name: string;
  lat: number;
  lng: number;
  certifications: string[];
  reliability_score: number;
  hours_this_week: number;
  is_available: boolean;
  org_id: string;
}

export interface DispatchJob {
  id: string;
  title: string;
  lat: number;
  lng: number;
  required_certifications: string[];
  start_time: string;
  end_time: string;
  scheduled_worker_id: string | null;
  status: string;
  org_id: string;
}

export interface ReassignmentCandidate {
  worker: DispatchWorker;
  score: number;
  distance_km: number;
  cert_match: boolean;
  overtime_risk: boolean;
}

export interface ReassignmentResult {
  job_id: string;
  event_id: string;
  status: "reassigned" | "pending_confirmation" | "no_candidates";
  selected_worker_id: string | null;
  candidates_evaluated: number;
  requires_manager_confirmation: boolean;
  event_type: string;
  logged_at: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Haversine great-circle distance in km. */
function haversineKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Fraction of required certifications held by worker (0–1). */
function certMatchScore(
  required: string[],
  held: string[],
): number {
  if (required.length === 0) return 1;
  const heldSet = new Set(held.map((c) => c.toLowerCase()));
  const matched = required.filter((c) => heldSet.has(c.toLowerCase())).length;
  return matched / required.length;
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * Log an event to crew_dispatch_events. Returns the new event's UUID.
 * Creates the table if it does not exist so the engine is self-bootstrapping.
 */
export async function logDispatchEvent(
  jobId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS crew_dispatch_events (
      id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      job_id           UUID,
      event_type       TEXT        NOT NULL,
      payload          JSONB       NOT NULL DEFAULT '{}',
      worker_id        UUID,
      status           TEXT        NOT NULL DEFAULT 'logged',
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const eventId = crypto.randomUUID();
  const workerId = (payload.selected_worker_id as string | undefined) ?? null;
  await pool.query(
    `INSERT INTO crew_dispatch_events (id, job_id, event_type, payload, worker_id, status)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [eventId, jobId ?? null, eventType, JSON.stringify(payload), workerId, payload.status ?? "logged"],
  );
  return eventId;
}

/**
 * Fetch available workers in the same org as the job, enriched with
 * hours-this-week from dispatch_worker_hours.
 */
async function fetchAvailableWorkers(orgId: string): Promise<DispatchWorker[]> {
  const pool = getPool();

  // Ensure tables exist so the engine is self-bootstrapping in dev/test.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dispatch_workers (
      id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id              UUID        NOT NULL,
      name                TEXT        NOT NULL,
      lat                 DOUBLE PRECISION NOT NULL DEFAULT 0,
      lng                 DOUBLE PRECISION NOT NULL DEFAULT 0,
      certifications      TEXT[]      NOT NULL DEFAULT '{}',
      reliability_score   DOUBLE PRECISION NOT NULL DEFAULT 1.0,
      is_available        BOOLEAN     NOT NULL DEFAULT TRUE
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dispatch_worker_hours (
      worker_id  UUID        NOT NULL,
      week_start DATE        NOT NULL,
      hours_worked DOUBLE PRECISION NOT NULL DEFAULT 0,
      PRIMARY KEY (worker_id, week_start)
    )
  `);

  // Monday of current ISO week
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun
  const diffToMon = (day === 0 ? -6 : 1 - day);
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() + diffToMon);
  const weekStart = monday.toISOString().slice(0, 10);

  const rows = (await pool.query(
    `SELECT w.id, w.org_id, w.name, w.lat, w.lng, w.certifications,
            w.reliability_score, w.is_available,
            COALESCE(h.hours_worked, 0) AS hours_this_week
     FROM   dispatch_workers w
     LEFT JOIN dispatch_worker_hours h
            ON h.worker_id = w.id AND h.week_start = $2
     WHERE  w.org_id = $1 AND w.is_available = TRUE`,
    [orgId, weekStart],
  )).rows as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    id: String(r.id),
    org_id: String(r.org_id),
    name: String(r.name),
    lat: Number(r.lat),
    lng: Number(r.lng),
    certifications: Array.isArray(r.certifications)
      ? (r.certifications as string[])
      : [],
    reliability_score: Number(r.reliability_score),
    hours_this_week: Number(r.hours_this_week),
    is_available: Boolean(r.is_available),
  }));
}

/**
 * Fetch a job record by ID. Returns null if not found.
 */
export async function fetchJob(jobId: string): Promise<DispatchJob | null> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dispatch_jobs (
      id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id                  UUID        NOT NULL,
      title                   TEXT        NOT NULL,
      lat                     DOUBLE PRECISION NOT NULL DEFAULT 0,
      lng                     DOUBLE PRECISION NOT NULL DEFAULT 0,
      required_certifications TEXT[]      NOT NULL DEFAULT '{}',
      start_time              TIMESTAMPTZ NOT NULL,
      end_time                TIMESTAMPTZ NOT NULL,
      scheduled_worker_id     UUID,
      status                  TEXT        NOT NULL DEFAULT 'open'
    )
  `);

  const rows = (await pool.query(
    `SELECT id, org_id, title, lat, lng, required_certifications,
            start_time, end_time, scheduled_worker_id, status
     FROM   dispatch_jobs WHERE id = $1`,
    [jobId],
  )).rows as Array<Record<string, unknown>>;

  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: String(r.id),
    org_id: String(r.org_id),
    title: String(r.title),
    lat: Number(r.lat),
    lng: Number(r.lng),
    required_certifications: Array.isArray(r.required_certifications)
      ? (r.required_certifications as string[])
      : [],
    start_time: String(r.start_time),
    end_time: String(r.end_time),
    scheduled_worker_id: r.scheduled_worker_id ? String(r.scheduled_worker_id) : null,
    status: String(r.status),
  };
}

/**
 * Rank available workers for a job.
 *
 * Score = 0.4 * (1 – normalized_distance) + 0.3 * cert_match + 0.3 * reliability
 * Distance capped at 100 km for normalization.
 */
export function rankCandidates(
  job: DispatchJob,
  workers: DispatchWorker[],
): ReassignmentCandidate[] {
  const MAX_DIST_KM = 100;
  const OVERTIME_WEEKLY_HOURS = 40;

  const candidates: ReassignmentCandidate[] = workers
    .filter((w) => w.id !== job.scheduled_worker_id) // exclude incumbent
    .map((w) => {
      const distKm = haversineKm(job.lat, job.lng, w.lat, w.lng);
      const normDist = Math.min(distKm, MAX_DIST_KM) / MAX_DIST_KM;
      const certMatch = certMatchScore(job.required_certifications, w.certifications);

      // Job duration in hours
      const jobStart = new Date(job.start_time).getTime();
      const jobEnd = new Date(job.end_time).getTime();
      const jobHours = Math.max(0, (jobEnd - jobStart) / 3_600_000);
      const overtimeRisk = w.hours_this_week + jobHours > OVERTIME_WEEKLY_HOURS;

      // Penalize overtime by 0.2 in the score
      const score =
        0.4 * (1 - normDist) +
        0.3 * certMatch +
        0.3 * Math.min(1, Math.max(0, w.reliability_score)) -
        (overtimeRisk ? 0.2 : 0);

      return { worker: w, score, distance_km: distKm, cert_match: certMatch === 1, overtime_risk: overtimeRisk };
    });

  // Sort descending by score
  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

/**
 * Returns true when assigning this job to the worker would push weekly hours
 * past 40 (standard overtime threshold).
 */
export async function isOvertimeTriggering(
  workerId: string,
  jobDurationHours: number,
): Promise<boolean> {
  const pool = getPool();

  const now = new Date();
  const day = now.getUTCDay();
  const diffToMon = day === 0 ? -6 : 1 - day;
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() + diffToMon);
  const weekStart = monday.toISOString().slice(0, 10);

  const rows = (await pool.query(
    `SELECT COALESCE(hours_worked, 0) AS hours_worked
     FROM   dispatch_worker_hours
     WHERE  worker_id = $1 AND week_start = $2`,
    [workerId, weekStart],
  )).rows as Array<Record<string, unknown>>;

  const currentHours = rows.length > 0 ? Number(rows[0].hours_worked) : 0;
  return currentHours + jobDurationHours > 40;
}

/**
 * Assign a worker to a job in the DB and update their weekly hours.
 */
async function persistAssignment(
  job: DispatchJob,
  workerId: string,
): Promise<void> {
  const pool = getPool();

  await pool.query(
    `UPDATE dispatch_jobs
     SET    scheduled_worker_id = $1, status = 'assigned'
     WHERE  id = $2`,
    [workerId, job.id],
  );

  // Upsert weekly hours
  const jobStart = new Date(job.start_time).getTime();
  const jobEnd = new Date(job.end_time).getTime();
  const jobHours = Math.max(0, (jobEnd - jobStart) / 3_600_000);

  const now = new Date();
  const day = now.getUTCDay();
  const diffToMon = day === 0 ? -6 : 1 - day;
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() + diffToMon);
  const weekStart = monday.toISOString().slice(0, 10);

  await pool.query(
    `INSERT INTO dispatch_worker_hours (worker_id, week_start, hours_worked)
     VALUES ($1, $2, $3)
     ON CONFLICT (worker_id, week_start)
     DO UPDATE SET hours_worked = dispatch_worker_hours.hours_worked + EXCLUDED.hours_worked`,
    [workerId, weekStart, jobHours],
  );
}

/**
 * Main entry point: reassign a job when a triggering event occurs.
 *
 * Workflow:
 * 1. Fetch job + available workers from the same org.
 * 2. Rank candidates.
 * 3. If top candidate triggers overtime → mark pending_confirmation for manager.
 * 4. Otherwise assign immediately and persist.
 * 5. Log everything to crew_dispatch_events.
 */
export async function reassignJob(
  jobId: string,
  triggerEventType: string,
): Promise<ReassignmentResult> {
  const job = await fetchJob(jobId);
  if (!job) {
    const eventId = await logDispatchEvent(jobId, triggerEventType, {
      error: "job_not_found",
      status: "error",
    });
    return {
      job_id: jobId,
      event_id: eventId,
      status: "no_candidates",
      selected_worker_id: null,
      candidates_evaluated: 0,
      requires_manager_confirmation: false,
      event_type: triggerEventType,
      logged_at: new Date().toISOString(),
    };
  }

  const workers = await fetchAvailableWorkers(job.org_id);
  const ranked = rankCandidates(job, workers);

  if (ranked.length === 0) {
    const eventId = await logDispatchEvent(jobId, triggerEventType, {
      status: "no_candidates",
      org_id: job.org_id,
    });
    return {
      job_id: jobId,
      event_id: eventId,
      status: "no_candidates",
      selected_worker_id: null,
      candidates_evaluated: 0,
      requires_manager_confirmation: false,
      event_type: triggerEventType,
      logged_at: new Date().toISOString(),
    };
  }

  const top = ranked[0];

  // Overtime gate: if assigning this worker would trigger overtime, require
  // manager confirmation before persisting (liability_assessor requirement).
  if (top.overtime_risk) {
    const eventId = await logDispatchEvent(jobId, triggerEventType, {
      status: "pending_confirmation",
      selected_worker_id: top.worker.id,
      selected_worker_name: top.worker.name,
      distance_km: top.distance_km,
      score: top.score,
      candidates_evaluated: ranked.length,
      requires_manager_confirmation: true,
      reason: "overtime_threshold_exceeded",
    });
    return {
      job_id: jobId,
      event_id: eventId,
      status: "pending_confirmation",
      selected_worker_id: top.worker.id,
      candidates_evaluated: ranked.length,
      requires_manager_confirmation: true,
      event_type: triggerEventType,
      logged_at: new Date().toISOString(),
    };
  }

  // Immediate reassignment
  await persistAssignment(job, top.worker.id);

  const eventId = await logDispatchEvent(jobId, triggerEventType, {
    status: "reassigned",
    selected_worker_id: top.worker.id,
    selected_worker_name: top.worker.name,
    distance_km: top.distance_km,
    cert_match: top.cert_match,
    score: top.score,
    candidates_evaluated: ranked.length,
    previous_worker_id: job.scheduled_worker_id,
    requires_manager_confirmation: false,
  });

  console.log(JSON.stringify({
    level: "info",
    msg: "dispatch.reassignment.completed",
    job_id: jobId,
    worker_id: top.worker.id,
    event_id: eventId,
    trigger: triggerEventType,
  }));

  return {
    job_id: jobId,
    event_id: eventId,
    status: "reassigned",
    selected_worker_id: top.worker.id,
    candidates_evaluated: ranked.length,
    requires_manager_confirmation: false,
    event_type: triggerEventType,
    logged_at: new Date().toISOString(),
  };
}

/**
 * Fetch active jobs that may need reassignment (open/assigned status,
 * future start time). Used by the schedule-health cron.
 */
export async function fetchJobsNeedingReassignment(): Promise<DispatchJob[]> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dispatch_jobs (
      id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id                  UUID        NOT NULL,
      title                   TEXT        NOT NULL,
      lat                     DOUBLE PRECISION NOT NULL DEFAULT 0,
      lng                     DOUBLE PRECISION NOT NULL DEFAULT 0,
      required_certifications TEXT[]      NOT NULL DEFAULT '{}',
      start_time              TIMESTAMPTZ NOT NULL,
      end_time                TIMESTAMPTZ NOT NULL,
      scheduled_worker_id     UUID,
      status                  TEXT        NOT NULL DEFAULT 'open'
    )
  `);

  const rows = (await pool.query(
    `SELECT id, org_id, title, lat, lng, required_certifications,
            start_time, end_time, scheduled_worker_id, status
     FROM   dispatch_jobs
     WHERE  status IN ('cancelled', 'no_show', 'overrun')
       AND  start_time > NOW() - INTERVAL '24 hours'
     ORDER BY start_time ASC
     LIMIT  50`,
    [],
  )).rows as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    id: String(r.id),
    org_id: String(r.org_id),
    title: String(r.title),
    lat: Number(r.lat),
    lng: Number(r.lng),
    required_certifications: Array.isArray(r.required_certifications)
      ? (r.required_certifications as string[])
      : [],
    start_time: String(r.start_time),
    end_time: String(r.end_time),
    scheduled_worker_id: r.scheduled_worker_id
      ? String(r.scheduled_worker_id)
      : null,
    status: String(r.status),
  }));
}
