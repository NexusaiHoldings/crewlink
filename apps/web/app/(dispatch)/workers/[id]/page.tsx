import type { JSX } from "react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getWorker, updateWorkerStatus } from "@/lib/dispatch/worker-access";

interface PageProps {
  params: { id: string };
}

async function toggleStatus(formData: FormData): Promise<void> {
  "use server";
  const id = formData.get("id") as string;
  const current = formData.get("current_status") as string;
  const next = current === "active" ? "inactive" : "active";
  await updateWorkerStatus(id, next);
  redirect(`/workers/${id}`);
}

export default async function WorkerDetailPage({
  params,
}: PageProps): Promise<JSX.Element> {
  const worker = await getWorker(params.id);

  if (!worker) {
    notFound();
  }

  const availabilityEntries = Object.entries(worker.availability);

  return (
    <main>
      <h1>{worker.name}</h1>
      <p>
        {worker.trade} field worker &mdash;{" "}
        <span className={worker.status === "inactive" ? "muted" : ""}>
          {worker.status}
        </span>
      </p>

      <Link href="/workers" className="btn secondary">
        ← Back to Workers
      </Link>

      <div className="card">
        <h2>Contact</h2>
        <p>
          <strong>Email:</strong>{" "}
          <a href={`mailto:${worker.email}`}>{worker.email}</a>
        </p>
        {worker.phone && (
          <p>
            <strong>Phone:</strong>{" "}
            <a href={`tel:${worker.phone}`}>{worker.phone}</a>
          </p>
        )}
      </div>

      <div className="card">
        <h2>Performance</h2>
        <p>
          <strong>Reliability Score:</strong>{" "}
          {worker.reliability_score.toFixed(1)}%
        </p>
        <p>
          <strong>Status:</strong> {worker.status}
        </p>
        <form action={toggleStatus}>
          <input type="hidden" name="id" value={worker.id} />
          <input type="hidden" name="current_status" value={worker.status} />
          <button type="submit" className="btn secondary">
            {worker.status === "active" ? "Deactivate Worker" : "Activate Worker"}
          </button>
        </form>
      </div>

      <div className="card">
        <h2>Certifications</h2>
        {worker.certifications.length > 0 ? (
          <ul>
            {worker.certifications.map((cert, idx) => (
              <li key={idx}>{cert}</li>
            ))}
          </ul>
        ) : (
          <p className="muted">No certifications recorded.</p>
        )}
      </div>

      <div className="card">
        <h2>Travel Zones</h2>
        {worker.travel_zones.length > 0 ? (
          <ul>
            {worker.travel_zones.map((zone, idx) => (
              <li key={idx}>{zone}</li>
            ))}
          </ul>
        ) : (
          <p className="muted">No travel zones defined.</p>
        )}
      </div>

      {availabilityEntries.length > 0 && (
        <div className="card">
          <h2>Availability</h2>
          <table>
            <thead>
              <tr>
                <th>Day</th>
                <th>Hours</th>
              </tr>
            </thead>
            <tbody>
              {availabilityEntries.map(([day, hours]) => (
                <tr key={day}>
                  <td>{day}</td>
                  <td>{Array.isArray(hours) ? hours.join(", ") : String(hours)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {worker.notes && (
        <div className="card">
          <h2>Notes</h2>
          <p>{worker.notes}</p>
        </div>
      )}

      <p className="muted">
        Added{" "}
        {worker.created_at instanceof Date
          ? worker.created_at.toLocaleDateString()
          : String(worker.created_at)}
        {worker.updated_at &&
          worker.updated_at !== worker.created_at && (
            <>
              {" "}
              &middot; Updated{" "}
              {worker.updated_at instanceof Date
                ? worker.updated_at.toLocaleDateString()
                : String(worker.updated_at)}
            </>
          )}
      </p>
    </main>
  );
}
