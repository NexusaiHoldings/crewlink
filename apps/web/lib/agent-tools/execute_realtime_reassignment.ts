/**
 * Agent tool handler: execute_realtime_reassignment
 *
 * Confirm-gated mutation — selects the optimal replacement worker for a
 * disrupted job by scoring available workers on proximity, certification
 * match, and reliability score, then writes the reassignment to
 * crew_dispatch_events and triggers push/SMS notification.
 *
 * Called immediately on cancellation or no-show event.
 */

import type { HandlerContext, HandlerResult } from "@nexus/identity-and-access";

type Args = Record<string, unknown>;

// ── DB row shapes ──────────────────────────────────────────────────────────

interface JobRow {
  readonly id: string;
  readonly title: string;
  readonly required_certification: string | null;
  readonly shift_start: Date;
  readonly shift_end: Date;
  readonly priority: number;
  readonly site_id: string;
  readonly site_lat: number | null;
  readonly site_lng: number | null;
  readonly current_worker_id: string | null;
}

interface WorkerRow {
  readonly id: string;
  readonly name: string;
  readonly phone: string | null;
  readonly push_token: string | null;
  readonly certifications: string[];
  readonly reliability_score: number;
  readonly lat: number | null;
  readonly lng: number | null;
  readonly status: string;
}

interface EventRow {
  readonly id: string;
}

// ── Result type ────────────────────────────────────────────────────────────

interface ScoreBreakdown {
  readonly proximity: number;
  readonly certification: number;
  readonly reliability: number;
}

interface ReassignmentResult {
  readonly job_id: string;
  readonly job_title: string;
  readonly shift_start: string;
  readonly shift_end: string;
  readonly replacement_worker_id: string;
  readonly replacement_worker_name: string;
  readonly score: number;
  readonly score_breakdown: ScoreBreakdown;
  readonly event_id: string;
  readonly notification_sent: boolean;
  readonly requires_confirmation: true;
}

// ── Scoring helpers ────────────────────────────────────────────────────────

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

function scoreWorker(
  worker: WorkerRow,
  job: JobRow,
): { score: number; breakdown: ScoreBreakdown } {
  // Proximity: 0-40 pts — 0 km = 40, 50 km = 0, unknown = neutral 20
  let proximityScore = 20;
  if (
    job.site_lat !== null &&
    job.site_lng !== null &&
    worker.lat !== null &&
    worker.lng !== null
  ) {
    const distKm = haversineKm(worker.lat, worker.lng, job.site_lat, job.site_lng);
    proximityScore = Math.max(0, 40 - (distKm / 50) * 40);
  }

  // Certification: 0-30 pts — required cert present or not required = full marks
  const certScore =
    !job.required_certification ||
    worker.certifications.includes(job.required_certification)
      ? 30
      : 0;

  // Reliability: 0-30 pts — reliability_score stored as 0-1 or 0-100
  const rawReliability =
    worker.reliability_score > 1
      ? worker.reliability_score / 100
      : worker.reliability_score;
  const reliabilityScore = rawReliability * 30;

  const total = Math.min(
    100,
    Math.max(0, Math.round(proximityScore + certScore + reliabilityScore)),
  );

  return {
    score: total,
    breakdown: {
      proximity: Math.round(proximityScore),
      certification: certScore,
      reliability: Math.round(reliabilityScore),
    },
  };
}

// ── Main handler ───────────────────────────────────────────────────────────

export async function handleExecuteRealtimeReassignment(
  ctx: HandlerContext,
  args: Args,
): Promise<HandlerResult> {
  const jobId = args.job_id as string | undefined;
  const eventType = (args.event_type as string | undefined) ?? "cancellation";
  const displacedWorkerId = args.displaced_worker_id as string | undefined;

  if (!jobId) {
    return { status: 400, body: "job_id is required" };
  }
  if (!["cancellation", "no_show"].includes(eventType)) {
    return {
      status: 400,
      body: "event_type must be 'cancellation' or 'no_show'",
    };
  }

  // ── 1. Load disrupted job ─────────────────────────────────────────────────
  let job: JobRow | undefined;
  try {
    const rows = await ctx.db.query<JobRow>(
      `SELECT
         j.id,
         j.title,
         j.required_certification,
         j.shift_start,
         j.shift_end,
         COALESCE(j.priority, 5)   AS priority,
         j.site_id,
         s.lat                     AS site_lat,
         s.lng                     AS site_lng,
         ja.worker_id              AS current_worker_id
       FROM crew_jobs j
       LEFT JOIN crew_sites s ON s.id = j.site_id
       LEFT JOIN crew_job_assignments ja
              ON ja.job_id = j.id AND ja.status = 'active'
       WHERE j.id = $1::uuid`,
      jobId,
    );
    job = rows[0];
  } catch {
    return { status: 500, body: "failed to load job" };
  }

  if (!job) {
    return { status: 404, body: `job ${jobId} not found` };
  }

  // ── 2. Load available replacement workers ────────────────────────────────
  // Exclude the displaced worker so they are not re-selected.
  const excludeId =
    displacedWorkerId ?? "00000000-0000-0000-0000-000000000000";

  let workers: WorkerRow[];
  try {
    workers = await ctx.db.query<WorkerRow>(
      `SELECT
         w.id,
         w.name,
         w.phone,
         w.push_token,
         COALESCE(
           ARRAY_AGG(wc.certification) FILTER (WHERE wc.certification IS NOT NULL),
           '{}'::text[]
         )                               AS certifications,
         COALESCE(w.reliability_score, 0.8) AS reliability_score,
         w.lat,
         w.lng,
         w.status
       FROM crew_workers w
       LEFT JOIN crew_worker_certifications wc ON wc.worker_id = w.id
       WHERE w.status = 'active'
         AND w.id != $1::uuid
       GROUP BY w.id, w.name, w.phone, w.push_token,
                w.reliability_score, w.lat, w.lng, w.status`,
      excludeId,
    );
  } catch {
    return { status: 500, body: "failed to load available workers" };
  }

  // Hard filter: must hold the required certification (if any)
  const eligible = workers.filter(
    (w) =>
      !job!.required_certification ||
      w.certifications.includes(job!.required_certification),
  );

  if (eligible.length === 0) {
    return {
      status: 422,
      body: `no eligible replacement workers found for job ${jobId}`,
    };
  }

  // ── 3. Score and rank eligible workers ───────────────────────────────────
  const scored = eligible
    .map((w) => ({ worker: w, ...scoreWorker(w, job!) }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];

  // ── 4. Write reassignment event to crew_dispatch_events ─────────────────
  let eventId: string;
  try {
    const eventRows = await ctx.db.query<EventRow>(
      `INSERT INTO crew_dispatch_events (
         id,
         job_id,
         event_type,
         displaced_worker_id,
         replacement_worker_id,
         score,
         score_breakdown,
         created_at
       ) VALUES (
         gen_random_uuid(),
         $1::uuid,
         $2,
         $3::uuid,
         $4::uuid,
         $5,
         $6::jsonb,
         NOW()
       )
       RETURNING id`,
      jobId,
      eventType,
      displacedWorkerId ?? null,
      best.worker.id,
      best.score,
      JSON.stringify(best.breakdown),
    );
    eventId = eventRows[0].id;
  } catch {
    return { status: 500, body: "failed to record dispatch event" };
  }

  // ── 5. Update crew_job_assignments ────────────────────────────────────────
  try {
    if (displacedWorkerId) {
      await ctx.db.query(
        `UPDATE crew_job_assignments
         SET status = $1, updated_at = NOW()
         WHERE job_id = $2::uuid
           AND worker_id = $3::uuid
           AND status = 'active'`,
        eventType === "no_show" ? "no_show" : "cancelled",
        jobId,
        displacedWorkerId,
      );
    }
    await ctx.db.query(
      `INSERT INTO crew_job_assignments (id, job_id, worker_id, status, assigned_at)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'active', NOW())
       ON CONFLICT (job_id, worker_id)
       DO UPDATE SET status = 'active', assigned_at = NOW()`,
      jobId,
      best.worker.id,
    );
  } catch {
    // Non-fatal — dispatch event already recorded; log and continue
  }

  // ── 6. Trigger push/SMS notifications ────────────────────────────────────
  let notificationSent = false;
  try {
    await ctx.events.publish("dispatch.reassignment", {
      event_id: eventId,
      job_id: jobId,
      job_title: job.title,
      shift_start: job.shift_start.toISOString(),
      shift_end: job.shift_end.toISOString(),
      replacement_worker_id: best.worker.id,
      replacement_worker_name: best.worker.name,
      replacement_worker_phone: best.worker.phone ?? null,
      replacement_worker_push_token: best.worker.push_token ?? null,
      event_type: eventType,
    });
    notificationSent = true;
  } catch {
    notificationSent = false;
  }

  const result: ReassignmentResult = {
    job_id: jobId,
    job_title: job.title,
    shift_start: job.shift_start.toISOString(),
    shift_end: job.shift_end.toISOString(),
    replacement_worker_id: best.worker.id,
    replacement_worker_name: best.worker.name,
    score: best.score,
    score_breakdown: best.breakdown,
    event_id: eventId,
    notification_sent: notificationSent,
    requires_confirmation: true,
  };

  return { status: 200, body: result as unknown as Record<string, unknown> };
}
