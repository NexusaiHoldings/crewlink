/**
 * Agent tool handler: generate_schedule_from_constraints
 *
 * Confirm-gated mutation — runs the constraint-satisfaction scheduler against
 * crew_workers, crew_jobs, crew_compliance_rules, and worker availability to
 * produce a ranked list of valid shift assignments. The ops manager reviews
 * and confirms before the schedule is committed.
 *
 * Called by: ops-manager conversation, cron unscheduled-job-window sweep.
 */

import type { HandlerContext, HandlerResult } from "@nexus/identity-and-access";

type Args = Record<string, unknown>;

// ── DB row shapes ──────────────────────────────────────────────────────────

interface WorkerRow {
  readonly id: string;
  readonly name: string;
  readonly certifications: string[];
  readonly max_hours_per_week: number;
  readonly min_rest_hours: number;
}

interface JobRow {
  readonly id: string;
  readonly title: string;
  readonly required_certification: string | null;
  readonly shift_start: Date;
  readonly shift_end: Date;
  readonly priority: number;
  readonly site_id: string;
}

interface ComplianceRuleRow {
  readonly id: string;
  readonly rule_type: string;
  readonly rule_value: number;
  readonly jurisdiction: string;
}

interface AvailabilityRow {
  readonly worker_id: string;
  readonly available_from: Date;
  readonly available_until: Date;
}

interface ExistingAssignmentRow {
  readonly worker_id: string;
  readonly shift_start: Date;
  readonly shift_end: Date;
  readonly hours_this_week: number;
}

// ── Scheduling types ───────────────────────────────────────────────────────

interface ShiftAssignment {
  readonly job_id: string;
  readonly job_title: string;
  readonly worker_id: string;
  readonly worker_name: string;
  readonly shift_start: string;
  readonly shift_end: string;
  readonly score: number;
  readonly constraint_violations: string[];
}

interface ScheduleResult {
  readonly assignments: ShiftAssignment[];
  readonly unscheduled_jobs: string[];
  readonly total_jobs: number;
  readonly scheduled_count: number;
  readonly coverage_pct: number;
  readonly requires_confirmation: true;
}

// ── Constraint-satisfaction helpers ───────────────────────────────────────

function shiftDurationHours(start: Date, end: Date): number {
  return (end.getTime() - start.getTime()) / 3_600_000;
}

function shiftsOverlap(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function workerAvailableForShift(
  worker: WorkerRow,
  job: JobRow,
  availability: AvailabilityRow[],
): boolean {
  return availability
    .filter((av) => av.worker_id === worker.id)
    .some(
      (av) =>
        av.available_from <= job.shift_start &&
        av.available_until >= job.shift_end,
    );
}

function workerMeetsCertification(worker: WorkerRow, job: JobRow): boolean {
  if (!job.required_certification) return true;
  return worker.certifications.includes(job.required_certification);
}

function computeWorkerHoursThisWeek(
  workerId: string,
  existingAssignments: ExistingAssignmentRow[],
): number {
  return existingAssignments
    .filter((a) => a.worker_id === workerId)
    .reduce((sum, a) => sum + a.hours_this_week, 0);
}

function workerHasRestConflict(
  worker: WorkerRow,
  job: JobRow,
  existingAssignments: ExistingAssignmentRow[],
): boolean {
  const minRestMs = worker.min_rest_hours * 3_600_000;
  return existingAssignments
    .filter((a) => a.worker_id === worker.id)
    .some((a) => {
      const gapAfter = job.shift_start.getTime() - a.shift_end.getTime();
      const gapBefore = a.shift_start.getTime() - job.shift_end.getTime();
      return (
        (gapAfter >= 0 && gapAfter < minRestMs) ||
        (gapBefore >= 0 && gapBefore < minRestMs)
      );
    });
}

function scoreAssignment(
  worker: WorkerRow,
  job: JobRow,
  hoursUsed: number,
  violations: string[],
  rules: ComplianceRuleRow[],
): number {
  let score = 100;

  // Penalise proximity to weekly hour cap
  const shiftHours = shiftDurationHours(job.shift_start, job.shift_end);
  const utilisation = (hoursUsed + shiftHours) / worker.max_hours_per_week;
  if (utilisation > 0.9) score -= 20;
  else if (utilisation > 0.75) score -= 10;

  // Bonus for exact certification match (not just "any cert")
  if (job.required_certification && worker.certifications.includes(job.required_certification)) {
    score += 10;
  }

  // Penalise per soft-constraint violation recorded during eligibility checks
  score -= violations.length * 15;

  // Penalise when predictive-scheduling rules flag short-notice (< 14 days)
  const noticeDays =
    (job.shift_start.getTime() - Date.now()) / 86_400_000;
  const hasPredictiveRule = rules.some(
    (r) => r.rule_type === "predictive_scheduling_notice_days",
  );
  if (hasPredictiveRule && noticeDays < 14) score -= 10;

  return Math.max(0, score);
}

// ── Main handler ───────────────────────────────────────────────────────────

export async function handleGenerateScheduleFromConstraints(
  ctx: HandlerContext,
  args: Args,
): Promise<HandlerResult> {
  // Parse args
  const windowStart = args.window_start
    ? new Date(args.window_start as string)
    : new Date();
  const windowEnd = args.window_end
    ? new Date(args.window_end as string)
    : new Date(Date.now() + 7 * 86_400_000);
  const siteId = (args.site_id as string | undefined) ?? null;

  if (isNaN(windowStart.getTime()) || isNaN(windowEnd.getTime())) {
    return { status: 400, body: "invalid window_start or window_end" };
  }
  if (windowEnd <= windowStart) {
    return { status: 400, body: "window_end must be after window_start" };
  }

  // ── 1. Load workers ──────────────────────────────────────────────────────
  let workers: WorkerRow[];
  try {
    workers = await ctx.db.query<WorkerRow>(
      `SELECT
         w.id,
         w.name,
         COALESCE(
           ARRAY_AGG(wc.certification) FILTER (WHERE wc.certification IS NOT NULL),
           '{}'::text[]
         ) AS certifications,
         COALESCE(w.max_hours_per_week, 40) AS max_hours_per_week,
         COALESCE(w.min_rest_hours, 8)      AS min_rest_hours
       FROM crew_workers w
       LEFT JOIN crew_worker_certifications wc ON wc.worker_id = w.id
       WHERE w.status = 'active'
       GROUP BY w.id, w.name, w.max_hours_per_week, w.min_rest_hours`,
    );
  } catch {
    return { status: 500, body: "failed to load workers" };
  }

  if (workers.length === 0) {
    return { status: 422, body: "no active workers found" };
  }

  // ── 2. Load unscheduled jobs in window ──────────────────────────────────
  const jobParams: unknown[] = [windowStart, windowEnd];
  let siteFilter = "";
  if (siteId) {
    jobParams.push(siteId);
    siteFilter = `AND j.site_id = $${jobParams.length}::uuid`;
  }

  let jobs: JobRow[];
  try {
    jobs = await ctx.db.query<JobRow>(
      `SELECT
         j.id,
         j.title,
         j.required_certification,
         j.shift_start,
         j.shift_end,
         COALESCE(j.priority, 5) AS priority,
         j.site_id
       FROM crew_jobs j
       WHERE j.shift_start >= $1
         AND j.shift_end   <= $2
         AND j.status = 'unscheduled'
         ${siteFilter}
       ORDER BY j.priority DESC, j.shift_start ASC`,
      ...jobParams,
    );
  } catch {
    return { status: 500, body: "failed to load jobs" };
  }

  if (jobs.length === 0) {
    return {
      status: 200,
      body: {
        assignments: [],
        unscheduled_jobs: [],
        total_jobs: 0,
        scheduled_count: 0,
        coverage_pct: 100,
        requires_confirmation: true,
        message: "no unscheduled jobs found in the requested window",
      } satisfies ScheduleResult & { message: string },
    };
  }

  // ── 3. Load compliance rules ─────────────────────────────────────────────
  let rules: ComplianceRuleRow[];
  try {
    rules = await ctx.db.query<ComplianceRuleRow>(
      `SELECT id, rule_type, rule_value, jurisdiction
       FROM crew_compliance_rules
       WHERE is_active = true`,
    );
  } catch {
    rules = [];
  }

  const maxWeeklyHoursRule = rules.find(
    (r) => r.rule_type === "max_weekly_hours",
  );
  const globalMaxWeeklyHours = maxWeeklyHoursRule?.rule_value ?? 40;

  // ── 4. Load availability ─────────────────────────────────────────────────
  let availability: AvailabilityRow[];
  try {
    availability = await ctx.db.query<AvailabilityRow>(
      `SELECT worker_id, available_from, available_until
       FROM crew_worker_availability
       WHERE available_from < $2
         AND available_until > $1`,
      windowStart,
      windowEnd,
    );
  } catch {
    availability = [];
  }

  // ── 5. Load existing assignments (for hour/rest tracking) ────────────────
  const weekAgo = new Date(windowStart.getTime() - 7 * 86_400_000);
  let existingAssignments: ExistingAssignmentRow[];
  try {
    existingAssignments = await ctx.db.query<ExistingAssignmentRow>(
      `SELECT
         ja.worker_id,
         j.shift_start,
         j.shift_end,
         EXTRACT(EPOCH FROM (j.shift_end - j.shift_start)) / 3600.0 AS hours_this_week
       FROM crew_job_assignments ja
       JOIN crew_jobs j ON j.id = ja.job_id
       WHERE j.shift_start >= $1
         AND j.shift_start <  $2
         AND ja.status != 'cancelled'`,
      weekAgo,
      windowEnd,
    );
  } catch {
    existingAssignments = [];
  }

  // ── 6. Constraint-satisfaction scheduling ───────────────────────────────
  const assignments: ShiftAssignment[] = [];
  const unscheduledIds: string[] = [];

  // Track tentative assignments within this scheduling run (to detect
  // intra-run overlaps and accumulate hours).
  const tentativeAssignments: Array<{
    workerId: string;
    shiftStart: Date;
    shiftEnd: Date;
    hours: number;
  }> = [];

  for (const job of jobs) {
    const shiftHours = shiftDurationHours(job.shift_start, job.shift_end);

    // Candidate workers: score each eligible worker, pick best
    const candidates: Array<{
      worker: WorkerRow;
      score: number;
      violations: string[];
    }> = [];

    for (const worker of workers) {
      const violations: string[] = [];

      // Hard constraint: certification
      if (!workerMeetsCertification(worker, job)) continue;

      // Hard constraint: availability
      if (availability.length > 0 && !workerAvailableForShift(worker, job, availability)) {
        continue;
      }

      // Hard constraint: no intra-run overlap for same worker
      const hasIntraRunOverlap = tentativeAssignments.some(
        (ta) =>
          ta.workerId === worker.id &&
          shiftsOverlap(ta.shiftStart, ta.shiftEnd, job.shift_start, job.shift_end),
      );
      if (hasIntraRunOverlap) continue;

      // Soft: max weekly hours (compliance + per-worker cap)
      const existingHours = computeWorkerHoursThisWeek(worker.id, existingAssignments);
      const tentativeHours = tentativeAssignments
        .filter((ta) => ta.workerId === worker.id)
        .reduce((s, ta) => s + ta.hours, 0);
      const totalHours = existingHours + tentativeHours + shiftHours;
      const effectiveMax = Math.min(worker.max_hours_per_week, globalMaxWeeklyHours);

      if (totalHours > effectiveMax) {
        violations.push(`would exceed ${effectiveMax}h weekly cap`);
      }

      // Soft: minimum rest between shifts
      if (workerHasRestConflict(worker, job, existingAssignments)) {
        violations.push(`rest period < ${worker.min_rest_hours}h`);
      }

      const sc = scoreAssignment(
        worker,
        job,
        existingHours + tentativeHours,
        violations,
        rules,
      );

      candidates.push({ worker, score: sc, violations });
    }

    if (candidates.length === 0) {
      unscheduledIds.push(job.id);
      continue;
    }

    // Pick highest-scoring candidate (ties broken by least accumulated hours)
    candidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const aHrs = tentativeAssignments.filter((t) => t.workerId === a.worker.id).reduce((s, t) => s + t.hours, 0);
      const bHrs = tentativeAssignments.filter((t) => t.workerId === b.worker.id).reduce((s, t) => s + t.hours, 0);
      return aHrs - bHrs;
    });

    const best = candidates[0];
    tentativeAssignments.push({
      workerId: best.worker.id,
      shiftStart: job.shift_start,
      shiftEnd: job.shift_end,
      hours: shiftHours,
    });

    assignments.push({
      job_id: job.id,
      job_title: job.title,
      worker_id: best.worker.id,
      worker_name: best.worker.name,
      shift_start: job.shift_start.toISOString(),
      shift_end: job.shift_end.toISOString(),
      score: best.score,
      constraint_violations: best.violations,
    });
  }

  // Sort final list by shift start, then descending score
  assignments.sort((a, b) => {
    const timeDiff =
      new Date(a.shift_start).getTime() - new Date(b.shift_start).getTime();
    return timeDiff !== 0 ? timeDiff : b.score - a.score;
  });

  const result: ScheduleResult = {
    assignments,
    unscheduled_jobs: unscheduledIds,
    total_jobs: jobs.length,
    scheduled_count: assignments.length,
    coverage_pct:
      jobs.length > 0
        ? Math.round((assignments.length / jobs.length) * 100)
        : 100,
    requires_confirmation: true,
  };

  await ctx.events.publish("schedule.generated", {
    total_jobs: result.total_jobs,
    scheduled_count: result.scheduled_count,
    coverage_pct: result.coverage_pct,
    window_start: windowStart.toISOString(),
    window_end: windowEnd.toISOString(),
  });

  return { status: 200, body: result as unknown as Record<string, unknown> };
}
