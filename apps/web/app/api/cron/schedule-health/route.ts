/**
 * GET /api/cron/schedule-health — Vercel cron: periodic schedule-health sweep.
 *
 * Runs every minute (configured in vercel.json). Scans for jobs in a
 * triggering state (cancelled, no_show, overrun) within the last 24 hours
 * and fires the reassignment engine for each one. Results are returned as
 * JSON for Vercel cron logs.
 *
 * Auth: when CRON_SECRET is set Vercel attaches it as
 * `Authorization: Bearer <secret>`; when unset (local dev) the route runs
 * unguarded.
 */

import { NextResponse } from "next/server";
import {
  fetchJobsNeedingReassignment,
  reassignJob,
} from "@/lib/dispatch/reassignment";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

function isCronAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // dev: unguarded
  const auth = request.headers.get("authorization") ?? "";
  return auth === `Bearer ${secret}`;
}

export async function GET(request: Request): Promise<NextResponse> {
  if (!isCronAuthorized(request)) {
    return new NextResponse("forbidden", { status: 403 });
  }

  const startedAt = Date.now();
  let jobs: Awaited<ReturnType<typeof fetchJobsNeedingReassignment>>;

  try {
    jobs = await fetchJobsNeedingReassignment();
  } catch (err) {
    console.error(
      JSON.stringify({
        level: "error",
        msg: "cron.schedule-health.fetch_failed",
        error: String((err as Error).message),
      }),
    );
    return NextResponse.json(
      { error: "fetch_failed", detail: String((err as Error).message) },
      { status: 502 },
    );
  }

  if (jobs.length === 0) {
    return NextResponse.json({
      swept: 0,
      results: [],
      duration_ms: Date.now() - startedAt,
    });
  }

  const results: Array<{
    job_id: string;
    trigger: string;
    outcome: string;
    event_id: string | null;
    error?: string;
  }> = [];

  for (const job of jobs) {
    try {
      const result = await reassignJob(job.id, job.status);
      results.push({
        job_id: job.id,
        trigger: job.status,
        outcome: result.status,
        event_id: result.event_id,
      });

      console.log(
        JSON.stringify({
          level: "info",
          msg: "cron.schedule-health.job_swept",
          job_id: job.id,
          trigger: job.status,
          outcome: result.status,
          requires_confirmation: result.requires_manager_confirmation,
        }),
      );
    } catch (err) {
      const errMsg = String((err as Error).message).slice(0, 400);
      results.push({
        job_id: job.id,
        trigger: job.status,
        outcome: "error",
        event_id: null,
        error: errMsg,
      });
      console.error(
        JSON.stringify({
          level: "error",
          msg: "cron.schedule-health.job_error",
          job_id: job.id,
          error: errMsg,
        }),
      );
    }
  }

  const summary = {
    swept: results.length,
    reassigned: results.filter((r) => r.outcome === "reassigned").length,
    pending_confirmation: results.filter(
      (r) => r.outcome === "pending_confirmation",
    ).length,
    no_candidates: results.filter((r) => r.outcome === "no_candidates").length,
    errors: results.filter((r) => r.outcome === "error").length,
  };

  console.log(
    JSON.stringify({
      level: "info",
      msg: "cron.schedule-health.sweep_complete",
      ...summary,
      duration_ms: Date.now() - startedAt,
    }),
  );

  return NextResponse.json({
    ...summary,
    results,
    duration_ms: Date.now() - startedAt,
  });
}
