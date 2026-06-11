/**
 * Constraint-aware schedule generation engine.
 *
 * Matches workers to jobs by:
 *   1. Required certifications
 *   2. Availability windows (day-of-week + hour range)
 *   3. Travel zone
 *   4. Predictive scheduling law compliance (CA, OR, Chicago, NYC)
 *   5. Weekly hours limits
 *
 * Produces a crew_schedule_snapshot with full constraint inputs for audit.
 * Schedules that trigger overtime require manager confirmation before publish
 * (per liability_assessor human_in_loop_required_for).
 */

import { Pool } from "pg";
import {
  detectJurisdiction,
  runAllComplianceChecks,
  JURISDICTION_RULES,
} from "./compliance-rules";
import type {
  ComplianceViolation,
  Jurisdiction,
  AvailabilityWindow,
} from "./compliance-rules";

// Lazy-initialized pool — avoids module-load errors in Next.js edge contexts
let _pool: Pool | null = null;

function getPool(): Pool {
  if (!_pool) {
    _pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10,
    });
  }
  return _pool;
}

// ── Domain types ───────────────────────────────────────────────────────────

export interface Worker {
  id: string;
  name: string;
  email: string;
  certifications: string[];
  travelZone: string;
  weeklyHoursLimit: number;
  jurisdiction: Jurisdiction | null;
  state: string;
  city: string;
  isActive: boolean;
}

export interface Job {
  id: string;
  title: string;
  requiredCertifications: string[];
  location: string;
  travelZone: string;
  durationHours: number;
  scheduledStart: Date;
  scheduledEnd: Date;
}

export interface ShiftAssignment {
  workerId: string;
  workerName: string;
  jobId: string;
  jobTitle: string;
  scheduledStart: Date;
  scheduledEnd: Date;
  durationHours: number;
  violations: ComplianceViolation[];
  requiresConfirmation: boolean;
}

export interface CrewScheduleSnapshot {
  id: string;
  generatedAt: Date;
  weekStartDate: string;
  assignments: ShiftAssignment[];
  totalViolations: number;
  totalEstimatedFinesUsd: number;
  requiresManagerConfirmation: boolean;
  constraintInputs: Record<string, unknown>;
  status: "draft" | "pending_confirmation" | "published" | "rejected";
  managerId: string;
}

export interface ScheduleGenerationRequest {
  weekStartDate: string; // ISO date string, e.g. "2026-06-15"
  jobIds: string[];
  preferredWorkerIds?: string[];
  managerId: string;
}

export interface ScheduleGenerationResult {
  snapshot: CrewScheduleSnapshot;
  unassignedJobs: Array<{ id: string; title: string; reason: string }>;
  warnings: string[];
}

// ── Worker fetch ───────────────────────────────────────────────────────────

async function fetchWorkers(
  db: Pool,
  preferredIds: string[],
): Promise<Worker[]> {
  const result = await db.query<{
    id: string;
    name: string;
    email: string;
    certifications: string[] | null;
    travel_zone: string | null;
    weekly_hours_limit: number | null;
    state: string | null;
    city: string | null;
    is_active: boolean;
  }>(
    `SELECT id, name, email, certifications, travel_zone, weekly_hours_limit, state, city, is_active
     FROM dispatch_workers
     WHERE is_active = true
     ORDER BY (id = ANY($1::uuid[])) DESC, name ASC`,
    [preferredIds.length > 0 ? preferredIds : []],
  );

  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    certifications: row.certifications ?? [],
    travelZone: row.travel_zone ?? "",
    weeklyHoursLimit: row.weekly_hours_limit ?? 40,
    jurisdiction: detectJurisdiction(row.state ?? "", row.city ?? ""),
    state: row.state ?? "",
    city: row.city ?? "",
    isActive: row.is_active,
  }));
}

// ── Job fetch ──────────────────────────────────────────────────────────────

async function fetchJobs(
  db: Pool,
  jobIds: string[],
  weekStartDate: string,
): Promise<Job[]> {
  const result = await db.query<{
    id: string;
    title: string;
    required_certifications: string[] | null;
    location: string | null;
    travel_zone: string | null;
    duration_hours: number;
    scheduled_start: Date;
    scheduled_end: Date;
  }>(
    `SELECT id, title, required_certifications, location, travel_zone, duration_hours, scheduled_start, scheduled_end
     FROM dispatch_jobs
     WHERE id = ANY($1::uuid[])
       AND scheduled_start >= $2::date
       AND scheduled_start < ($2::date + INTERVAL '7 days')
       AND status != 'cancelled'
     ORDER BY scheduled_start ASC`,
    [jobIds, weekStartDate],
  );

  return result.rows.map((row) => ({
    id: row.id,
    title: row.title,
    requiredCertifications: row.required_certifications ?? [],
    location: row.location ?? "",
    travelZone: row.travel_zone ?? "",
    durationHours: row.duration_hours,
    scheduledStart: new Date(row.scheduled_start),
    scheduledEnd: new Date(row.scheduled_end),
  }));
}

// ── Existing commitment fetch ──────────────────────────────────────────────

interface WorkerWeekState {
  weeklyHoursUsed: number;
  lastShiftEnd: Date | null;
  availabilityWindows: AvailabilityWindow[];
}

async function buildWorkerStateMap(
  db: Pool,
  workerIds: string[],
  weekStartDate: string,
): Promise<Map<string, WorkerWeekState>> {
  const stateMap = new Map<string, WorkerWeekState>();
  for (const wid of workerIds) {
    stateMap.set(wid, { weeklyHoursUsed: 0, lastShiftEnd: null, availabilityWindows: [] });
  }

  // Existing confirmed shifts this week
  const shiftsResult = await db.query<{
    worker_id: string;
    scheduled_end: Date;
    duration_hours: number;
  }>(
    `SELECT worker_id, scheduled_end, duration_hours
     FROM dispatch_shift_assignments
     WHERE worker_id = ANY($1::uuid[])
       AND scheduled_start >= $2::date
       AND scheduled_start < ($2::date + INTERVAL '7 days')
       AND status != 'cancelled'`,
    [workerIds, weekStartDate],
  );

  for (const row of shiftsResult.rows) {
    const state = stateMap.get(row.worker_id);
    if (!state) continue;
    state.weeklyHoursUsed += row.duration_hours;
    const shiftEnd = new Date(row.scheduled_end);
    if (!state.lastShiftEnd || shiftEnd > state.lastShiftEnd) {
      state.lastShiftEnd = shiftEnd;
    }
  }

  // Availability windows
  const availResult = await db.query<{
    worker_id: string;
    day_of_week: number;
    start_hour: number;
    end_hour: number;
  }>(
    `SELECT worker_id, day_of_week, start_hour, end_hour
     FROM dispatch_worker_availability
     WHERE worker_id = ANY($1::uuid[])`,
    [workerIds],
  );

  for (const row of availResult.rows) {
    const state = stateMap.get(row.worker_id);
    if (!state) continue;
    state.availabilityWindows.push({
      dayOfWeek: row.day_of_week,
      startHour: row.start_hour,
      endHour: row.end_hour,
    });
  }

  return stateMap;
}

// ── Constraint checks ──────────────────────────────────────────────────────

function workerMeetsCertificationConstraint(worker: Worker, job: Job): boolean {
  if (job.requiredCertifications.length === 0) return true;
  const workerCerts = new Set(worker.certifications);
  return job.requiredCertifications.every((cert) => workerCerts.has(cert));
}

function workerMeetsTravelZoneConstraint(worker: Worker, job: Job): boolean {
  if (!job.travelZone || !worker.travelZone) return true;
  return worker.travelZone === job.travelZone;
}

function workerMeetsAvailabilityConstraint(
  windows: AvailabilityWindow[],
  job: Job,
): boolean {
  if (windows.length === 0) return true; // No constraints = always available

  const dayOfWeek = job.scheduledStart.getDay();
  const startHour = job.scheduledStart.getHours();
  const endHour = job.scheduledEnd.getHours();

  return windows.some(
    (w) =>
      w.dayOfWeek === dayOfWeek &&
      w.startHour <= startHour &&
      w.endHour >= endHour,
  );
}

function workerMeetsHoursConstraint(
  worker: Worker,
  state: WorkerWeekState,
  jobDurationHours: number,
): boolean {
  return state.weeklyHoursUsed + jobDurationHours <= worker.weeklyHoursLimit;
}

// ── Core schedule generation ───────────────────────────────────────────────

export async function generateSchedule(
  request: ScheduleGenerationRequest,
): Promise<ScheduleGenerationResult> {
  const db = getPool();
  const now = new Date();
  const warnings: string[] = [];
  const unassignedJobs: Array<{ id: string; title: string; reason: string }> = [];
  const assignments: ShiftAssignment[] = [];

  const workers = await fetchWorkers(db, request.preferredWorkerIds ?? []);
  const jobs = await fetchJobs(db, request.jobIds, request.weekStartDate);

  if (jobs.length === 0) {
    warnings.push("No jobs found for the specified week and job IDs.");
  }

  const workerIds = workers.map((w) => w.id);
  const stateMap = await buildWorkerStateMap(db, workerIds, request.weekStartDate);

  // Assign workers to jobs — greedy constraint-satisfaction pass
  for (const job of jobs) {
    let assigned: Worker | null = null;
    let assignedRejectionReason = "No eligible worker found";

    for (const worker of workers) {
      if (!workerMeetsCertificationConstraint(worker, job)) {
        assignedRejectionReason = `Missing required certifications: ${job.requiredCertifications.join(", ")}`;
        continue;
      }
      if (!workerMeetsTravelZoneConstraint(worker, job)) {
        assignedRejectionReason = `Travel zone mismatch (worker: ${worker.travelZone}, job: ${job.travelZone})`;
        continue;
      }

      const state = stateMap.get(worker.id) ?? {
        weeklyHoursUsed: 0,
        lastShiftEnd: null,
        availabilityWindows: [],
      };

      if (!workerMeetsAvailabilityConstraint(state.availabilityWindows, job)) {
        assignedRejectionReason = "Worker unavailable during shift window";
        continue;
      }
      if (!workerMeetsHoursConstraint(worker, state, job.durationHours)) {
        assignedRejectionReason = `Would exceed weekly hours limit (${worker.weeklyHoursLimit}h)`;
        continue;
      }

      // All hard constraints pass — run compliance checks
      const violations = runAllComplianceChecks({
        workerId: worker.id,
        shiftId: job.id,
        shiftStart: job.scheduledStart,
        shiftEnd: job.scheduledEnd,
        shiftDurationHours: job.durationHours,
        previousShiftEnd: state.lastShiftEnd,
        projectedWeeklyHours: state.weeklyHoursUsed + job.durationHours,
        jurisdiction: worker.jurisdiction,
        schedulePublishedAt: now,
      });

      // Update tracking for subsequent job iterations
      state.weeklyHoursUsed += job.durationHours;
      if (!state.lastShiftEnd || job.scheduledEnd > state.lastShiftEnd) {
        state.lastShiftEnd = job.scheduledEnd;
      }
      stateMap.set(worker.id, state);

      assignments.push({
        workerId: worker.id,
        workerName: worker.name,
        jobId: job.id,
        jobTitle: job.title,
        scheduledStart: job.scheduledStart,
        scheduledEnd: job.scheduledEnd,
        durationHours: job.durationHours,
        violations,
        requiresConfirmation: violations.some((v) => v.requiresManagerConfirmation),
      });

      assigned = worker;
      break;
    }

    if (!assigned) {
      unassignedJobs.push({ id: job.id, title: job.title, reason: assignedRejectionReason });
      warnings.push(`Job "${job.title}" could not be assigned: ${assignedRejectionReason}`);
    }
  }

  const totalViolations = assignments.reduce((acc, a) => acc + a.violations.length, 0);
  const totalFines = assignments.reduce(
    (acc, a) => acc + a.violations.reduce((vAcc, v) => vAcc + v.estimatedFineUsd, 0),
    0,
  );
  const requiresManagerConfirmation = assignments.some((a) => a.requiresConfirmation);

  const snapshotId = crypto.randomUUID();
  const snapshot: CrewScheduleSnapshot = {
    id: snapshotId,
    generatedAt: now,
    weekStartDate: request.weekStartDate,
    assignments,
    totalViolations,
    totalEstimatedFinesUsd: totalFines,
    requiresManagerConfirmation,
    constraintInputs: {
      requestedJobIds: request.jobIds,
      preferredWorkerIds: request.preferredWorkerIds ?? [],
      managerId: request.managerId,
      generatedAt: now.toISOString(),
      totalWorkersEvaluated: workers.length,
      totalJobsRequested: request.jobIds.length,
      totalJobsScheduled: assignments.length,
      totalJobsUnassigned: unassignedJobs.length,
      jurisdictionsApplied: [
        ...new Set(
          workers
            .filter((w) => w.jurisdiction !== null)
            .map((w) => w.jurisdiction as string),
        ),
      ],
    },
    status: requiresManagerConfirmation ? "pending_confirmation" : "draft",
    managerId: request.managerId,
  };

  // Persist the snapshot for audit and confirmation workflow
  await db.query(
    `INSERT INTO dispatch_schedule_snapshots
       (id, generated_at, week_start_date, assignments, total_violations,
        total_estimated_fines_usd, requires_manager_confirmation,
        constraint_inputs, status, manager_id)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8::jsonb, $9, $10)`,
    [
      snapshot.id,
      snapshot.generatedAt,
      snapshot.weekStartDate,
      JSON.stringify(snapshot.assignments),
      snapshot.totalViolations,
      snapshot.totalEstimatedFinesUsd,
      snapshot.requiresManagerConfirmation,
      JSON.stringify(snapshot.constraintInputs),
      snapshot.status,
      snapshot.managerId,
    ],
  );

  return { snapshot, unassignedJobs, warnings };
}

// ── Snapshot confirmation / rejection ─────────────────────────────────────

export async function confirmSchedule(
  snapshotId: string,
  managerId: string,
): Promise<void> {
  const db = getPool();

  const updateResult = await db.query(
    `UPDATE dispatch_schedule_snapshots
     SET status = 'published', confirmed_by = $1, confirmed_at = NOW()
     WHERE id = $2
       AND status IN ('draft', 'pending_confirmation')`,
    [managerId, snapshotId],
  );

  if ((updateResult.rowCount ?? 0) === 0) {
    throw new Error(
      "Schedule snapshot not found or already finalized. Reload and try again.",
    );
  }

  // Materialise the shift assignments from the snapshot into the assignments table
  const snapshotRow = await db.query<{ assignments: string }>(
    `SELECT assignments FROM dispatch_schedule_snapshots WHERE id = $1`,
    [snapshotId],
  );

  if (snapshotRow.rows.length === 0) {
    throw new Error("Snapshot disappeared after update — data integrity error.");
  }

  const materializedAssignments: ShiftAssignment[] = JSON.parse(
    snapshotRow.rows[0].assignments,
  );

  for (const assignment of materializedAssignments) {
    await db.query(
      `INSERT INTO dispatch_shift_assignments
         (id, snapshot_id, worker_id, job_id, scheduled_start, scheduled_end,
          duration_hours, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'scheduled')
       ON CONFLICT (worker_id, job_id, scheduled_start) DO NOTHING`,
      [
        crypto.randomUUID(),
        snapshotId,
        assignment.workerId,
        assignment.jobId,
        assignment.scheduledStart,
        assignment.scheduledEnd,
        assignment.durationHours,
      ],
    );
  }
}

export async function rejectSchedule(
  snapshotId: string,
  managerId: string,
  reason: string,
): Promise<void> {
  const db = getPool();

  const result = await db.query(
    `UPDATE dispatch_schedule_snapshots
     SET status = 'rejected', rejected_by = $1, rejected_at = NOW(), rejection_reason = $3
     WHERE id = $2
       AND status IN ('draft', 'pending_confirmation')`,
    [managerId, snapshotId, reason],
  );

  if ((result.rowCount ?? 0) === 0) {
    throw new Error(
      "Schedule snapshot not found or already finalized. Reload and try again.",
    );
  }
}

// ── Snapshot queries ───────────────────────────────────────────────────────

export async function getScheduleSnapshot(
  snapshotId: string,
): Promise<CrewScheduleSnapshot | null> {
  const db = getPool();

  const result = await db.query<{
    id: string;
    generated_at: Date;
    week_start_date: string;
    assignments: string;
    total_violations: number;
    total_estimated_fines_usd: string;
    requires_manager_confirmation: boolean;
    constraint_inputs: string;
    status: string;
    manager_id: string;
  }>(
    `SELECT id, generated_at, week_start_date, assignments, total_violations,
            total_estimated_fines_usd, requires_manager_confirmation,
            constraint_inputs, status, manager_id
     FROM dispatch_schedule_snapshots
     WHERE id = $1`,
    [snapshotId],
  );

  if (result.rows.length === 0) return null;
  const row = result.rows[0];

  return {
    id: row.id,
    generatedAt: new Date(row.generated_at),
    weekStartDate: row.week_start_date,
    assignments: JSON.parse(row.assignments),
    totalViolations: row.total_violations,
    totalEstimatedFinesUsd: parseFloat(row.total_estimated_fines_usd),
    requiresManagerConfirmation: row.requires_manager_confirmation,
    constraintInputs: JSON.parse(row.constraint_inputs),
    status: row.status as CrewScheduleSnapshot["status"],
    managerId: row.manager_id,
  };
}

export async function listScheduleSnapshots(
  weekStartDate?: string,
): Promise<
  Array<{
    id: string;
    generatedAt: Date;
    weekStartDate: string;
    totalViolations: number;
    totalEstimatedFinesUsd: number;
    requiresManagerConfirmation: boolean;
    status: string;
    assignmentCount: number;
  }>
> {
  const db = getPool();

  const result = weekStartDate
    ? await db.query(
        `SELECT id, generated_at, week_start_date, total_violations,
                total_estimated_fines_usd, requires_manager_confirmation, status,
                jsonb_array_length(assignments::jsonb) AS assignment_count
         FROM dispatch_schedule_snapshots
         WHERE week_start_date = $1
         ORDER BY generated_at DESC`,
        [weekStartDate],
      )
    : await db.query(
        `SELECT id, generated_at, week_start_date, total_violations,
                total_estimated_fines_usd, requires_manager_confirmation, status,
                jsonb_array_length(assignments::jsonb) AS assignment_count
         FROM dispatch_schedule_snapshots
         ORDER BY generated_at DESC
         LIMIT 20`,
      );

  return result.rows.map((row) => ({
    id: row.id,
    generatedAt: new Date(row.generated_at),
    weekStartDate: row.week_start_date,
    totalViolations: row.total_violations,
    totalEstimatedFinesUsd: parseFloat(row.total_estimated_fines_usd ?? "0"),
    requiresManagerConfirmation: row.requires_manager_confirmation,
    status: row.status,
    assignmentCount: row.assignment_count ?? 0,
  }));
}

// ── Available jobs (for the generate form) ────────────────────────────────

export async function fetchUnscheduledJobs(
  weekStartDate: string,
): Promise<Array<{ id: string; title: string; location: string; scheduledStart: Date; durationHours: number }>> {
  const db = getPool();

  const result = await db.query<{
    id: string;
    title: string;
    location: string | null;
    scheduled_start: Date;
    duration_hours: number;
  }>(
    `SELECT j.id, j.title, j.location, j.scheduled_start, j.duration_hours
     FROM dispatch_jobs j
     WHERE j.scheduled_start >= $1::date
       AND j.scheduled_start < ($1::date + INTERVAL '7 days')
       AND j.status = 'unassigned'
       AND j.status != 'cancelled'
     ORDER BY j.scheduled_start ASC
     LIMIT 100`,
    [weekStartDate],
  );

  return result.rows.map((row) => ({
    id: row.id,
    title: row.title,
    location: row.location ?? "",
    scheduledStart: new Date(row.scheduled_start),
    durationHours: row.duration_hours,
  }));
}
