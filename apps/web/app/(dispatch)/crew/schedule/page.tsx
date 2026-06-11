import type { JSX, CSSProperties } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/admin-auth";
import {
  ensureDispatchSchema,
  getJobsForWorker,
  getWorkerReliabilityStats,
  type DispatchJob,
} from "@/lib/dispatch/worker-signals";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function formatScheduledTime(date: Date | null): string {
  if (!date) return "Time TBD";
  return new Date(date).toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function jobStatusLabel(job: DispatchJob): string {
  if (job.workerSignalType === "accept") return "Accepted ✓";
  if (job.workerSignalType === "decline") return "Declined";
  if (job.assignmentStatus === "assigned") return "Awaiting Response";
  return job.assignmentStatus ?? job.status;
}

function signalStyle(job: DispatchJob): CSSProperties {
  if (job.workerSignalType === "accept") return { color: "#16a34a", fontWeight: 600 };
  if (job.workerSignalType === "decline") return { color: "#dc2626", fontWeight: 600 };
  return { color: "#6b7280", fontStyle: "italic" };
}

export default async function CrewSchedulePage(): Promise<JSX.Element> {
  const user = await getSessionUser();
  if (!user) redirect("/login?redirect=/crew/schedule");

  let jobs: DispatchJob[] = [];
  let acceptanceRate: number | null = null;
  let totalAssigned = 0;

  try {
    await ensureDispatchSchema();
    jobs = await getJobsForWorker(user.id);
    const stats = await getWorkerReliabilityStats(user.id);
    acceptanceRate = stats.acceptanceRate;
    totalAssigned = stats.totalAssigned;
  } catch (err) {
    console.error("[crew/schedule] db error", err);
  }

  const pending = jobs.filter((j) => !j.workerSignalType);
  const responded = jobs.filter((j) => !!j.workerSignalType);

  return (
    <main>
      <h1>My Schedule</h1>
      <p>Your assigned jobs — tap a job to view details and respond.</p>

      {totalAssigned > 0 && acceptanceRate !== null && (
        <div className="card" style={{ marginBottom: "1.25rem" }}>
          <strong>Reliability Score</strong>
          <p className="muted" style={{ margin: "0.25rem 0 0" }}>
            {Math.round(acceptanceRate * 100)}% acceptance rate across{" "}
            {totalAssigned} assigned job{totalAssigned !== 1 ? "s" : ""}
          </p>
        </div>
      )}

      {jobs.length === 0 ? (
        <div className="empty">
          <p>No jobs assigned yet. Check back soon or contact your dispatcher.</p>
        </div>
      ) : (
        <>
          {pending.length > 0 && (
            <section>
              <h2>Needs Response ({pending.length})</h2>
              <ul style={{ listStyle: "none", padding: 0 }}>
                {pending.map((job) => (
                  <li key={job.id} style={{ marginBottom: "0.75rem" }}>
                    <Link href={`/crew/jobs/${job.id}`} className="btn secondary" style={{ display: "block", textAlign: "left", padding: "0" }}>
                      <div className="card">
                        <strong>{job.title}</strong>
                        {job.location && (
                          <p className="muted" style={{ margin: "0.25rem 0" }}>
                            {job.location}
                          </p>
                        )}
                        <p style={{ margin: "0.25rem 0" }}>
                          {formatScheduledTime(job.scheduledAt)}
                          {job.estimatedDurationMinutes != null && (
                            <span className="muted"> · {job.estimatedDurationMinutes} min</span>
                          )}
                        </p>
                        <p style={{ margin: "0.25rem 0", ...signalStyle(job) }}>
                          {jobStatusLabel(job)}
                        </p>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {responded.length > 0 && (
            <section>
              <h2>Responded ({responded.length})</h2>
              <ul style={{ listStyle: "none", padding: 0 }}>
                {responded.map((job) => (
                  <li key={job.id} style={{ marginBottom: "0.75rem" }}>
                    <Link href={`/crew/jobs/${job.id}`} style={{ display: "block", textDecoration: "none" }}>
                      <div className="card">
                        <strong>{job.title}</strong>
                        {job.location && (
                          <p className="muted" style={{ margin: "0.25rem 0" }}>
                            {job.location}
                          </p>
                        )}
                        <p style={{ margin: "0.25rem 0" }}>
                          {formatScheduledTime(job.scheduledAt)}
                        </p>
                        <p style={{ margin: "0.25rem 0", ...signalStyle(job) }}>
                          {jobStatusLabel(job)}
                        </p>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </main>
  );
}
