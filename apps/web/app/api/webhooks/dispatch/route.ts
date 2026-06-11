/**
 * POST /api/webhooks/dispatch — inbound webhook for dispatch events.
 *
 * External services (scheduling software, mobile apps, IoT sensors) POST
 * structured events here when a job status changes. Supported event types:
 *   - cancellation  — worker or client cancelled
 *   - no_show       — assigned worker did not appear
 *   - job_overrun   — job is running past its scheduled end time
 *
 * The handler verifies the HMAC-SHA256 signature (DISPATCH_WEBHOOK_SECRET),
 * marks the job's DB status accordingly, and triggers the reassignment engine.
 *
 * Signature header: X-Dispatch-Signature: sha256=<hex>
 * When DISPATCH_WEBHOOK_SECRET is unset the signature check is skipped
 * (dev/test convenience).
 */

import { NextResponse } from "next/server";
import crypto from "crypto";
import { reassignJob, logDispatchEvent } from "@/lib/dispatch/reassignment";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TriggerType = "cancellation" | "no_show" | "job_overrun";

interface DispatchWebhookPayload {
  event_type: TriggerType;
  job_id: string;
  /** Optional context forwarded from the external system. */
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

function verifySignature(rawBody: string, signatureHeader: string | null): boolean {
  const secret = process.env.DISPATCH_WEBHOOK_SECRET;
  if (!secret) return true; // unguarded in dev

  if (!signatureHeader) return false;

  const expected = `sha256=${crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("hex")}`;

  // Constant-time comparison to prevent timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signatureHeader, "utf8"),
      Buffer.from(expected, "utf8"),
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Map webhook event_type → DB job status + reassignment trigger label
// ---------------------------------------------------------------------------

const EVENT_TO_STATUS: Record<TriggerType, string> = {
  cancellation: "cancelled",
  no_show: "no_show",
  job_overrun: "overrun",
};

// ---------------------------------------------------------------------------
// DB: mark job status
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
    max: 5,
    idleTimeoutMillis: 30_000,
  });
  return _pool;
}

async function markJobStatus(jobId: string, status: string): Promise<boolean> {
  const pool = getPool();
  const result = (await pool.query(
    `UPDATE dispatch_jobs SET status = $1 WHERE id = $2 RETURNING id`,
    [status, jobId],
  )).rows as unknown[];
  return result.length > 0;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function POST(request: Request): Promise<NextResponse> {
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const signature = request.headers.get("x-dispatch-signature");
  if (!verifySignature(rawBody, signature)) {
    console.warn(
      JSON.stringify({
        level: "warn",
        msg: "webhooks.dispatch.signature_invalid",
      }),
    );
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }

  let payload: DispatchWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as DispatchWebhookPayload;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const { event_type, job_id, metadata } = payload;

  // Validate event type
  if (!event_type || !EVENT_TO_STATUS[event_type]) {
    return NextResponse.json(
      { error: "unsupported_event_type", received: event_type },
      { status: 422 },
    );
  }

  // Validate job_id format (UUID)
  const uuidRe =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!job_id || !uuidRe.test(job_id)) {
    return NextResponse.json(
      { error: "invalid_job_id", received: job_id },
      { status: 422 },
    );
  }

  const dbStatus = EVENT_TO_STATUS[event_type];

  // Mark the job status in the DB (best-effort — reassignment engine also
  // reads the status, so this ensures consistency).
  try {
    const updated = await markJobStatus(job_id, dbStatus);
    if (!updated) {
      // Job may not exist — log and fall through; the engine will handle it.
      console.warn(
        JSON.stringify({
          level: "warn",
          msg: "webhooks.dispatch.job_not_found",
          job_id,
          event_type,
        }),
      );
    }
  } catch (err) {
    // Non-fatal: continue to reassignment
    console.error(
      JSON.stringify({
        level: "error",
        msg: "webhooks.dispatch.mark_status_error",
        job_id,
        error: String((err as Error).message),
      }),
    );
  }

  // Log the inbound webhook event before reassignment
  try {
    await logDispatchEvent(job_id, `webhook.${event_type}`, {
      status: "received",
      event_type,
      metadata: metadata ?? {},
    });
  } catch (err) {
    console.error(
      JSON.stringify({
        level: "error",
        msg: "webhooks.dispatch.log_error",
        error: String((err as Error).message),
      }),
    );
  }

  // Trigger reassignment engine
  let result: Awaited<ReturnType<typeof reassignJob>>;
  try {
    result = await reassignJob(job_id, event_type);
  } catch (err) {
    const errMsg = String((err as Error).message).slice(0, 400);
    console.error(
      JSON.stringify({
        level: "error",
        msg: "webhooks.dispatch.reassignment_error",
        job_id,
        error: errMsg,
      }),
    );
    return NextResponse.json({ error: "reassignment_failed", detail: errMsg }, { status: 500 });
  }

  console.log(
    JSON.stringify({
      level: "info",
      msg: "webhooks.dispatch.processed",
      job_id,
      event_type,
      outcome: result.status,
      event_id: result.event_id,
      requires_confirmation: result.requires_manager_confirmation,
    }),
  );

  return NextResponse.json({
    received: true,
    job_id,
    event_type,
    outcome: result.status,
    event_id: result.event_id,
    selected_worker_id: result.selected_worker_id,
    requires_manager_confirmation: result.requires_manager_confirmation,
    candidates_evaluated: result.candidates_evaluated,
  });
}
