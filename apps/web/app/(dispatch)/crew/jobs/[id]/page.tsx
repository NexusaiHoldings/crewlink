import type { JSX } from "react";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getSessionUser } from "@/lib/admin-auth";
import {
  ensureDispatchSchema,
  getJobById,
  recordWorkerSignal,
  type DispatchJob,
} from "@/lib/dispatch/worker-signals";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function formatDate(date: Date | null): string {
  if (!date) return "Time TBD";
  return new Date(date).toLocaleString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function AlreadyResponded({ signalType }: { signalType: "accept" | "decline" }): JSX.Element {
  const isAccepted = signalType === "accept";
  return (
    <div
      className="card"
      style={{
        borderColor: isAccepted ? "#16a34a" : "#dc2626",
        background: isAccepted ? "#f0fdf4" : "#fef2f2",
        marginTop: "1.5rem",
      }}
    >
      <strong style={{ color: isAccepted ? "#16a34a" : "#dc2626" }}>
        {isAccepted ? "You accepted this job" : "You declined this job"}
      </strong>
      <p className="muted" style={{ margin: "0.25rem 0 0" }}>
        Your response has been recorded. Contact your dispatcher if you need to change it.
      </p>
    </div>
  );
}

function JobDetailCard({ job }: { job: DispatchJob }): JSX.Element {
  return (
    <div className="card" style={{ marginTop: "1rem" }}>
      {job.scheduledAt && (
        <p>
          <strong>When:</strong> {formatDate(job.scheduledAt)}
          {job.estimatedDurationMinutes != null && (
            <span className="muted"> · est. {job.estimatedDurationMinutes} min</span>
          )}
        </p>
      )}
      {job.location && (
        <p>
          <strong>Where:</strong>{" "}
          <a
            href={`https://maps.google.com/?q=${encodeURIComponent(job.location)}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            {job.location}
          </a>
        </p>
      )}
      {job.customerName && (
        <p>
          <strong>Customer:</strong> {job.customerName}
          {job.customerPhone && (
            <span>
              {" "}·{" "}
              <a href={`tel:${job.customerPhone}`}>{job.customerPhone}</a>
            </span>
          )}
        </p>
      )}
      {job.description && (
        <p>
          <strong>Description:</strong> {job.description}
        </p>
      )}
      {job.notes && (
        <p>
          <strong>Notes:</strong> {job.notes}
        </p>
      )}
    </div>
  );
}

export default async function JobDetailPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { signal?: string; error?: string };
}): Promise<JSX.Element> {
  const user = await getSessionUser();
  if (!user) redirect(`/login?redirect=/crew/jobs/${params.id}`);

  let job: DispatchJob | null = null;
  try {
    await ensureDispatchSchema();
    job = await getJobById(params.id, user.id);
  } catch (err) {
    console.error("[crew/jobs/[id]] db error", err);
  }

  if (!job) {
    return (
      <main>
        <h1>Job Not Found</h1>
        <p>This job does not exist or is not assigned to you.</p>
        <a href="/crew/schedule" className="btn secondary">Back to Schedule</a>
      </main>
    );
  }

  async function acceptJob(_fd: FormData): Promise<void> {
    "use server";
    const sessionUser = await getSessionUser();
    if (!sessionUser) return;
    let ok = false;
    try {
      await recordWorkerSignal({
        jobId: params.id,
        workerId: sessionUser.id,
        signalType: "accept",
      });
      ok = true;
    } catch (err) {
      console.error("[crew/jobs/accept] signal error", err);
    }
    revalidatePath(`/crew/jobs/${params.id}`);
    redirect(ok ? `/crew/jobs/${params.id}?signal=accepted` : `/crew/jobs/${params.id}?error=1`);
  }

  async function declineJob(fd: FormData): Promise<void> {
    "use server";
    const sessionUser = await getSessionUser();
    if (!sessionUser) return;
    const reason = fd.get("reason")?.toString() ?? undefined;
    let ok = false;
    try {
      await recordWorkerSignal({
        jobId: params.id,
        workerId: sessionUser.id,
        signalType: "decline",
        reason,
      });
      ok = true;
    } catch (err) {
      console.error("[crew/jobs/decline] signal error", err);
    }
    revalidatePath(`/crew/jobs/${params.id}`);
    redirect(ok ? `/crew/jobs/${params.id}?signal=declined` : `/crew/jobs/${params.id}?error=1`);
  }

  const hasResponded = !!job.workerSignalType;
  const signalSent = searchParams.signal;

  return (
    <main>
      <a href="/crew/schedule" className="btn secondary" style={{ marginBottom: "1rem", display: "inline-block" }}>
        ← Back to Schedule
      </a>

      <h1>{job.title}</h1>
      <p className="muted">
        Status:{" "}
        <strong>
          {job.workerSignalType === "accept"
            ? "Accepted"
            : job.workerSignalType === "decline"
            ? "Declined"
            : job.assignmentStatus ?? job.status}
        </strong>
      </p>

      {signalSent === "accepted" && (
        <div className="card" style={{ borderColor: "#16a34a", background: "#f0fdf4" }}>
          <strong style={{ color: "#16a34a" }}>Job accepted!</strong>
          <p className="muted" style={{ margin: "0.25rem 0 0" }}>
            Your dispatcher has been notified. See you on site.
          </p>
        </div>
      )}

      {signalSent === "declined" && (
        <div className="card" style={{ borderColor: "#dc2626", background: "#fef2f2" }}>
          <strong style={{ color: "#dc2626" }}>Job declined.</strong>
          <p className="muted" style={{ margin: "0.25rem 0 0" }}>
            Your dispatcher has been notified and will reassign the job.
          </p>
        </div>
      )}

      {searchParams.error && (
        <div className="card" style={{ borderColor: "#f59e0b", background: "#fffbeb" }}>
          <strong style={{ color: "#b45309" }}>Something went wrong.</strong>
          <p className="muted" style={{ margin: "0.25rem 0 0" }}>
            Please try again or contact your dispatcher.
          </p>
        </div>
      )}

      <JobDetailCard job={job} />

      {hasResponded ? (
        <AlreadyResponded signalType={job.workerSignalType!} />
      ) : (
        <div style={{ marginTop: "2rem" }}>
          <h2>Respond to This Job</h2>
          <p className="muted">
            Let your dispatcher know if you can make it. Your response feeds into your
            reliability score.
          </p>

          <form action={acceptJob} style={{ display: "inline-block", marginRight: "1rem" }}>
            <button type="submit" className="btn">Accept Job</button>
          </form>

          <details style={{ marginTop: "1.5rem" }}>
            <summary style={{ cursor: "pointer", color: "#6b7280" }}>
              Decline this job
            </summary>
            <form action={declineJob} style={{ marginTop: "0.75rem" }}>
              <label htmlFor="reason" style={{ display: "block", marginBottom: "0.5rem" }}>
                Reason (optional)
              </label>
              <input
                id="reason"
                name="reason"
                type="text"
                placeholder="e.g. Schedule conflict, illness…"
                style={{ width: "100%", maxWidth: "400px" }}
              />
              <div style={{ marginTop: "0.75rem" }}>
                <button type="submit" className="btn secondary">Decline Job</button>
              </div>
            </form>
          </details>
        </div>
      )}

      <script
        dangerouslySetInnerHTML={{
          __html: `
            if ('serviceWorker' in navigator) {
              navigator.serviceWorker.register('/sw.js').catch(function(){});
            }
          `,
        }}
      />
    </main>
  );
}
