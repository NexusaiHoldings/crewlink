/**
 * /dispatch/events — Crew Dispatch Events audit log.
 *
 * Server component. Reads crew_dispatch_events from the DB and renders a
 * filterable, paginated table. Supports URL search params:
 *   ?type=<event_type>   — filter by event type (e.g. cancellation, no_show)
 *   ?status=<status>     — filter by outcome status
 *   ?page=<n>            — pagination (25 rows per page)
 *
 * Auth: requires a logged-in session. Non-authenticated visitors are
 * redirected to /login.
 */

import type { JSX } from "react";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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
    max: 5,
    idleTimeoutMillis: 30_000,
  });
  return _pool;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DispatchEventRow {
  id: string;
  job_id: string | null;
  event_type: string;
  status: string;
  worker_id: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

const PAGE_SIZE = 25;

async function fetchEvents(
  eventType: string | null,
  status: string | null,
  page: number,
): Promise<{ rows: DispatchEventRow[]; total: number }> {
  const pool = getPool();

  // Self-bootstrap: create the table if it does not yet exist.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS crew_dispatch_events (
      id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      job_id     UUID,
      event_type TEXT        NOT NULL,
      payload    JSONB       NOT NULL DEFAULT '{}',
      worker_id  UUID,
      status     TEXT        NOT NULL DEFAULT 'logged',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Build parameterized WHERE clause
  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (eventType) {
    conditions.push(`event_type = $${paramIdx++}`);
    params.push(eventType);
  }
  if (status) {
    conditions.push(`status = $${paramIdx++}`);
    params.push(status);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const offset = (Math.max(1, page) - 1) * PAGE_SIZE;

  // Count
  const countRows = (await pool.query(
    `SELECT COUNT(*) AS cnt FROM crew_dispatch_events ${where}`,
    params,
  )).rows as Array<{ cnt: string }>;
  const total = parseInt(countRows[0]?.cnt ?? "0", 10);

  // Data
  const dataRows = (await pool.query(
    `SELECT id, job_id, event_type, status, worker_id, payload, created_at
     FROM   crew_dispatch_events
     ${where}
     ORDER BY created_at DESC
     LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
    [...params, PAGE_SIZE, offset],
  )).rows as Array<Record<string, unknown>>;

  const rows: DispatchEventRow[] = dataRows.map((r) => ({
    id: String(r.id),
    job_id: r.job_id ? String(r.job_id) : null,
    event_type: String(r.event_type),
    status: String(r.status),
    worker_id: r.worker_id ? String(r.worker_id) : null,
    payload:
      typeof r.payload === "object" && r.payload !== null
        ? (r.payload as Record<string, unknown>)
        : {},
    created_at: String(r.created_at),
  }));

  return { rows, total };
}

async function fetchDistinctValues(
  col: "event_type" | "status",
): Promise<string[]> {
  const pool = getPool();
  try {
    const rows = (await pool.query(
      `SELECT DISTINCT ${col} FROM crew_dispatch_events ORDER BY ${col}`,
      [],
    )).rows as Array<Record<string, unknown>>;
    return rows.map((r) => String(r[col]));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statusBadgeClass(status: string): string {
  switch (status) {
    case "reassigned":
      return "badge-green";
    case "pending_confirmation":
      return "badge-yellow";
    case "no_candidates":
      return "badge-red";
    case "error":
      return "badge-red";
    default:
      return "badge-gray";
  }
}

function formatDate(ts: string): string {
  try {
    return new Date(ts).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return ts;
  }
}

function shortId(id: string | null): string {
  if (!id) return "—";
  return id.slice(0, 8) + "…";
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

interface PageProps {
  searchParams?: Record<string, string | string[] | undefined>;
}

export default async function DispatchEventsPage({
  searchParams = {},
}: PageProps): Promise<JSX.Element> {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const eventType =
    typeof searchParams.type === "string" ? searchParams.type : null;
  const status =
    typeof searchParams.status === "string" ? searchParams.status : null;
  const page =
    typeof searchParams.page === "string"
      ? Math.max(1, parseInt(searchParams.page, 10) || 1)
      : 1;

  const [{ rows, total }, eventTypes, statuses] = await Promise.all([
    fetchEvents(eventType, status, page),
    fetchDistinctValues("event_type"),
    fetchDistinctValues("status"),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  function buildHref(overrides: Record<string, string | null>): string {
    const params = new URLSearchParams();
    const merged: Record<string, string | null> = {
      type: eventType,
      status,
      page: String(page),
      ...overrides,
    };
    for (const [k, v] of Object.entries(merged)) {
      if (v !== null && v !== "") params.set(k, v);
    }
    const qs = params.toString();
    return `/dispatch/events${qs ? `?${qs}` : ""}`;
  }

  return (
    <main>
      <h1>Dispatch Events</h1>
      <p>
        Audit log of all reassignment engine events — cancellations, no-shows,
        overruns, and their outcomes. Used for compliance review and RL training
        data collection.
      </p>

      {/* Filter toolbar */}
      <form method="GET" action="/dispatch/events" className="toolbar">
        <select name="type" defaultValue={eventType ?? ""}>
          <option value="">All event types</option>
          {eventTypes.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>

        <select name="status" defaultValue={status ?? ""}>
          <option value="">All statuses</option>
          {statuses.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>

        <button type="submit">Filter</button>

        {(eventType || status) && (
          <a href="/dispatch/events" className="btn secondary">
            Clear
          </a>
        )}
      </form>

      {/* Summary line */}
      <p className="muted">
        {total === 0
          ? "No events recorded yet."
          : `Showing ${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, total)} of ${total} event${total === 1 ? "" : "s"}`}
      </p>

      {rows.length === 0 ? (
        <div className="empty">
          <p>No dispatch events match your filter.</p>
          {(eventType || status) && (
            <p>
              <a href="/dispatch/events">Clear filters</a> to see all events.
            </p>
          )}
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Event Type</th>
              <th>Status</th>
              <th>Job ID</th>
              <th>Worker ID</th>
              <th>Candidates</th>
              <th>Confirmation?</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((ev) => {
              const payload = ev.payload;
              const candidates =
                typeof payload.candidates_evaluated === "number"
                  ? payload.candidates_evaluated
                  : null;
              const needsConfirm =
                payload.requires_manager_confirmation === true;

              return (
                <tr key={ev.id}>
                  <td>
                    <span className="muted">{formatDate(ev.created_at)}</span>
                  </td>
                  <td>
                    <code>{ev.event_type}</code>
                  </td>
                  <td>
                    <span className={statusBadgeClass(ev.status)}>
                      {ev.status}
                    </span>
                  </td>
                  <td>
                    <code title={ev.job_id ?? undefined}>{shortId(ev.job_id)}</code>
                  </td>
                  <td>
                    <code title={ev.worker_id ?? undefined}>
                      {shortId(ev.worker_id)}
                    </code>
                  </td>
                  <td>{candidates !== null ? candidates : "—"}</td>
                  <td>{needsConfirm ? "Yes" : "No"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <nav aria-label="Pagination">
          <ul style={{ display: "flex", gap: "0.5rem", listStyle: "none", padding: 0 }}>
            {page > 1 && (
              <li>
                <a href={buildHref({ page: String(page - 1) })} className="btn secondary">
                  ← Previous
                </a>
              </li>
            )}
            <li>
              <span className="muted">
                Page {page} of {totalPages}
              </span>
            </li>
            {page < totalPages && (
              <li>
                <a href={buildHref({ page: String(page + 1) })} className="btn secondary">
                  Next →
                </a>
              </li>
            )}
          </ul>
        </nav>
      )}
    </main>
  );
}
