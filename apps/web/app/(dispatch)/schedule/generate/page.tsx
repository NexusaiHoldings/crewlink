/**
 * Schedule Generation Page
 *
 * Managers select a week and jobs, then trigger the constraint-aware
 * scheduler. Schedules that would trigger overtime require manager
 * confirmation before publishing (per liability_assessor requirement).
 */

import { redirect } from "next/navigation";
import {
  generateSchedule,
  confirmSchedule,
  rejectSchedule,
  getScheduleSnapshot,
  listScheduleSnapshots,
  fetchUnscheduledJobs,
} from "@/lib/dispatch/scheduler";
import type { CrewScheduleSnapshot } from "@/lib/dispatch/scheduler";
import type { JSX } from "react";

// ── Search params from Next.js App Router ─────────────────────────────────

interface PageProps {
  searchParams: {
    snapshotId?: string;
    week?: string;
    error?: string;
  };
}

// ── Server Actions ─────────────────────────────────────────────────────────

async function handleGenerateSchedule(formData: FormData): Promise<void> {
  "use server";

  const weekStartDate = formData.get("weekStartDate") as string;
  const managerId = (formData.get("managerId") as string) || "system";
  const jobIds = formData.getAll("jobIds") as string[];

  if (!weekStartDate) {
    redirect("/schedule/generate?error=Week+start+date+is+required");
  }
  if (jobIds.length === 0) {
    redirect("/schedule/generate?error=Select+at+least+one+job");
  }

  try {
    const result = await generateSchedule({
      weekStartDate,
      jobIds,
      managerId,
    });
    redirect(`/schedule/generate?snapshotId=${result.snapshot.id}&week=${weekStartDate}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Schedule generation failed";
    redirect(`/schedule/generate?error=${encodeURIComponent(message)}&week=${weekStartDate}`);
  }
}

async function handleConfirmSchedule(formData: FormData): Promise<void> {
  "use server";

  const snapshotId = formData.get("snapshotId") as string;
  const managerId = (formData.get("managerId") as string) || "system";
  const weekStartDate = formData.get("weekStartDate") as string;

  try {
    await confirmSchedule(snapshotId, managerId);
    redirect(`/schedule/generate?snapshotId=${snapshotId}&week=${weekStartDate}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Confirmation failed";
    redirect(
      `/schedule/generate?snapshotId=${snapshotId}&week=${weekStartDate}&error=${encodeURIComponent(message)}`,
    );
  }
}

async function handleRejectSchedule(formData: FormData): Promise<void> {
  "use server";

  const snapshotId = formData.get("snapshotId") as string;
  const managerId = (formData.get("managerId") as string) || "system";
  const weekStartDate = formData.get("weekStartDate") as string;
  const reason = (formData.get("rejectionReason") as string) || "Rejected by manager";

  try {
    await rejectSchedule(snapshotId, managerId, reason);
    redirect(`/schedule/generate?week=${weekStartDate}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Rejection failed";
    redirect(
      `/schedule/generate?snapshotId=${snapshotId}&week=${weekStartDate}&error=${encodeURIComponent(message)}`,
    );
  }
}

// ── Status badge ───────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }): JSX.Element {
  const styles: Record<string, string> = {
    draft: "color:#92400e;background:#fef3c7;padding:2px 8px;border-radius:4px;font-size:12px",
    pending_confirmation: "color:#1d4ed8;background:#dbeafe;padding:2px 8px;border-radius:4px;font-size:12px",
    published: "color:#065f46;background:#d1fae5;padding:2px 8px;border-radius:4px;font-size:12px",
    rejected: "color:#991b1b;background:#fee2e2;padding:2px 8px;border-radius:4px;font-size:12px",
  };
  const labels: Record<string, string> = {
    draft: "Draft",
    pending_confirmation: "Awaiting Confirmation",
    published: "Published",
    rejected: "Rejected",
  };
  return (
    <span style={styles[status] ?? styles["draft"]}>
      {labels[status] ?? status}
    </span>
  );
}

// ── Snapshot detail view ───────────────────────────────────────────────────

function SnapshotDetail({
  snapshot,
}: {
  snapshot: CrewScheduleSnapshot;
}): JSX.Element {
  const isActionable =
    snapshot.status === "draft" || snapshot.status === "pending_confirmation";

  return (
    <section>
      <div className="card" style={{ marginBottom: "1.5rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "1rem", marginBottom: "0.75rem" }}>
          <h2 style={{ margin: 0 }}>
            Schedule — Week of {snapshot.weekStartDate}
          </h2>
          <StatusBadge status={snapshot.status} />
        </div>

        <dl style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: "0.5rem 1.5rem" }}>
          <div>
            <dt className="muted">Assignments</dt>
            <dd style={{ margin: 0, fontWeight: 600 }}>{snapshot.assignments.length}</dd>
          </div>
          <div>
            <dt className="muted">Compliance Violations</dt>
            <dd style={{ margin: 0, fontWeight: 600, color: snapshot.totalViolations > 0 ? "#b91c1c" : "inherit" }}>
              {snapshot.totalViolations}
            </dd>
          </div>
          <div>
            <dt className="muted">Estimated Fines</dt>
            <dd style={{ margin: 0, fontWeight: 600, color: snapshot.totalEstimatedFinesUsd > 0 ? "#b91c1c" : "inherit" }}>
              ${snapshot.totalEstimatedFinesUsd.toLocaleString("en-US", { minimumFractionDigits: 0 })}
            </dd>
          </div>
          <div>
            <dt className="muted">Generated</dt>
            <dd style={{ margin: 0 }}>{new Date(snapshot.generatedAt).toLocaleString()}</dd>
          </div>
        </dl>

        {snapshot.requiresManagerConfirmation && isActionable && (
          <p style={{ marginTop: "0.75rem", padding: "0.5rem 0.75rem", background: "#fef3c7", borderRadius: "6px", fontSize: "14px", margin: "0.75rem 0 0" }}>
            <strong>Manager confirmation required</strong> — this schedule triggers overtime or
            has compliance violations. Review assignments below before publishing.
          </p>
        )}
      </div>

      {/* Assignments table */}
      {snapshot.assignments.length > 0 ? (
        <div style={{ overflowX: "auto", marginBottom: "1.5rem" }}>
          <table>
            <thead>
              <tr>
                <th>Worker</th>
                <th>Job</th>
                <th>Start</th>
                <th>End</th>
                <th>Hours</th>
                <th>Violations</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.assignments.map((a) => (
                <tr key={`${a.workerId}-${a.jobId}`}>
                  <td>{a.workerName}</td>
                  <td>{a.jobTitle}</td>
                  <td>{new Date(a.scheduledStart).toLocaleString()}</td>
                  <td>{new Date(a.scheduledEnd).toLocaleString()}</td>
                  <td>{a.durationHours}h</td>
                  <td>
                    {a.violations.length === 0 ? (
                      <span className="muted">None</span>
                    ) : (
                      <details>
                        <summary style={{ cursor: "pointer", color: "#b91c1c" }}>
                          {a.violations.length} violation{a.violations.length !== 1 ? "s" : ""}
                        </summary>
                        <ul style={{ margin: "0.25rem 0 0", paddingLeft: "1rem", fontSize: "13px" }}>
                          {a.violations.map((v, vi) => (
                            <li key={vi} style={{ color: "#b91c1c" }}>
                              <strong>{v.violationType.replace(/_/g, " ")}</strong>: {v.description}
                              {v.estimatedFineUsd > 0 && ` ($${v.estimatedFineUsd} fine)`}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty">No assignments in this snapshot.</div>
      )}

      {/* Confirm / Reject actions */}
      {isActionable && (
        <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
          <form action={handleConfirmSchedule}>
            <input type="hidden" name="snapshotId" value={snapshot.id} />
            <input type="hidden" name="managerId" value="manager" />
            <input type="hidden" name="weekStartDate" value={snapshot.weekStartDate} />
            <button type="submit" className="btn">
              Publish Schedule
            </button>
          </form>

          <form action={handleRejectSchedule} style={{ display: "flex", gap: "0.5rem", alignItems: "flex-end" }}>
            <input type="hidden" name="snapshotId" value={snapshot.id} />
            <input type="hidden" name="managerId" value="manager" />
            <input type="hidden" name="weekStartDate" value={snapshot.weekStartDate} />
            <div>
              <label htmlFor="rejectionReason" className="muted" style={{ display: "block", fontSize: "13px", marginBottom: "2px" }}>
                Rejection reason
              </label>
              <input
                id="rejectionReason"
                name="rejectionReason"
                type="text"
                placeholder="Optional note…"
                style={{ minWidth: "220px" }}
              />
            </div>
            <button type="submit" className="btn secondary">
              Reject
            </button>
          </form>
        </div>
      )}
    </section>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────

export default async function ScheduleGeneratePage({
  searchParams,
}: PageProps): Promise<JSX.Element> {
  const weekParam = searchParams.week ?? new Date().toISOString().slice(0, 10);
  const snapshotId = searchParams.snapshotId;
  const errorMsg = searchParams.error;

  // Fetch snapshot if ID provided
  const currentSnapshot = snapshotId ? await getScheduleSnapshot(snapshotId) : null;

  // Fetch unscheduled jobs for the selected week (for the generation form)
  let availableJobs: Array<{
    id: string;
    title: string;
    location: string;
    scheduledStart: Date;
    durationHours: number;
  }> = [];
  try {
    availableJobs = await fetchUnscheduledJobs(weekParam);
  } catch {
    // Tables may not exist yet in development — degrade gracefully
    availableJobs = [];
  }

  // Recent snapshots list for context
  let recentSnapshots: Awaited<ReturnType<typeof listScheduleSnapshots>> = [];
  try {
    recentSnapshots = await listScheduleSnapshots();
  } catch {
    recentSnapshots = [];
  }

  return (
    <main>
      <h1>Generate Schedule</h1>
      <p>
        Select a week and unassigned jobs to let the constraint engine build a
        crew schedule — matching worker certifications, availability windows,
        travel zones, and predictive scheduling law requirements.
      </p>

      {errorMsg && (
        <div
          role="alert"
          style={{
            padding: "0.75rem 1rem",
            background: "#fee2e2",
            color: "#991b1b",
            borderRadius: "6px",
            marginBottom: "1.5rem",
            fontSize: "14px",
          }}
        >
          {decodeURIComponent(errorMsg)}
        </div>
      )}

      {/* ── Current snapshot detail ── */}
      {currentSnapshot && (
        <SnapshotDetail snapshot={currentSnapshot} />
      )}

      {/* ── Generation form ── */}
      {!currentSnapshot && (
        <form action={handleGenerateSchedule} style={{ marginBottom: "2rem" }}>
          <div className="card">
            <h2 style={{ marginTop: 0 }}>New Schedule</h2>

            <div style={{ display: "grid", gap: "1rem", maxWidth: "480px" }}>
              <div>
                <label htmlFor="weekStartDate">
                  Week Starting (Monday)
                </label>
                <input
                  id="weekStartDate"
                  name="weekStartDate"
                  type="date"
                  defaultValue={weekParam}
                  required
                  style={{ display: "block", marginTop: "4px", width: "100%" }}
                />
              </div>

              <input type="hidden" name="managerId" value="manager" />

              <div>
                <p style={{ margin: "0 0 0.5rem", fontWeight: 500 }}>
                  Unassigned Jobs for Selected Week
                </p>
                {availableJobs.length === 0 ? (
                  <p className="muted" style={{ fontSize: "14px" }}>
                    No unassigned jobs found for this week. Change the week or
                    create jobs from the dispatch board.
                  </p>
                ) : (
                  <div
                    style={{
                      border: "1px solid #e5e7eb",
                      borderRadius: "6px",
                      maxHeight: "260px",
                      overflowY: "auto",
                    }}
                  >
                    {availableJobs.map((job) => (
                      <label
                        key={job.id}
                        style={{
                          display: "flex",
                          alignItems: "flex-start",
                          gap: "0.5rem",
                          padding: "0.6rem 0.75rem",
                          borderBottom: "1px solid #f3f4f6",
                          cursor: "pointer",
                        }}
                      >
                        <input
                          type="checkbox"
                          name="jobIds"
                          value={job.id}
                          defaultChecked
                          style={{ marginTop: "2px" }}
                        />
                        <span style={{ fontSize: "14px" }}>
                          <strong>{job.title}</strong>
                          <span className="muted">
                            {" "}— {job.location} ·{" "}
                            {new Date(job.scheduledStart).toLocaleDateString()} ·{" "}
                            {job.durationHours}h
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div style={{ marginTop: "1.25rem" }}>
              <button type="submit" className="btn" disabled={availableJobs.length === 0}>
                Generate Schedule
              </button>
            </div>
          </div>
        </form>
      )}

      {/* ── Back / New schedule link when viewing a snapshot ── */}
      {currentSnapshot && (
        <p style={{ marginTop: "1.5rem" }}>
          <a href={`/schedule/generate?week=${currentSnapshot.weekStartDate}`} className="btn secondary">
            ← Generate Another Schedule
          </a>
        </p>
      )}

      {/* ── Recent snapshots ── */}
      {recentSnapshots.length > 0 && (
        <section style={{ marginTop: "2.5rem" }}>
          <h2>Recent Schedules</h2>
          <table>
            <thead>
              <tr>
                <th>Week</th>
                <th>Assignments</th>
                <th>Violations</th>
                <th>Status</th>
                <th>Generated</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {recentSnapshots.map((snap) => (
                <tr key={snap.id}>
                  <td>{snap.weekStartDate}</td>
                  <td>{snap.assignmentCount}</td>
                  <td style={{ color: snap.totalViolations > 0 ? "#b91c1c" : "inherit" }}>
                    {snap.totalViolations}
                    {snap.totalEstimatedFinesUsd > 0 && (
                      <span className="muted"> (${snap.totalEstimatedFinesUsd})</span>
                    )}
                  </td>
                  <td>
                    <StatusBadge status={snap.status} />
                  </td>
                  <td className="muted" style={{ fontSize: "13px" }}>
                    {new Date(snap.generatedAt).toLocaleString()}
                  </td>
                  <td>
                    <a
                      href={`/schedule/generate?snapshotId=${snap.id}&week=${snap.weekStartDate}`}
                      className="btn secondary"
                      style={{ fontSize: "13px", padding: "2px 10px" }}
                    >
                      View
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {recentSnapshots.length === 0 && !currentSnapshot && (
        <div className="empty" style={{ marginTop: "2rem" }}>
          No schedules generated yet. Select a week and jobs above to create your
          first constraint-aware crew schedule.
        </div>
      )}
    </main>
  );
}
