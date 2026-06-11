import type { JSX } from "react";
import Link from "next/link";
import { listWorkers } from "@/lib/dispatch/worker-access";

interface PageProps {
  searchParams: { search?: string; status?: string };
}

export default async function WorkersPage({
  searchParams,
}: PageProps): Promise<JSX.Element> {
  const search = searchParams.search ?? "";
  const status = searchParams.status ?? "";

  const workers = await listWorkers({
    search: search || undefined,
    status: status || undefined,
  });

  return (
    <main>
      <h1>Field Workers</h1>
      <p>
        Registry of certified field workers — certifications, availability
        windows, travel zones, and reliability scores for the scheduling engine.
      </p>

      <Link href="/workers/new" className="btn">
        Add Worker
      </Link>

      <form className="toolbar" method="GET">
        <input
          name="search"
          defaultValue={search}
          placeholder="Search by name, email, or trade…"
          aria-label="Search workers"
        />
        <select name="status" defaultValue={status} aria-label="Filter by status">
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>
        <button type="submit">Search</button>
        {(search || status) && (
          <a href="/workers" className="btn secondary">
            Clear
          </a>
        )}
      </form>

      {workers.length === 0 ? (
        <div className="empty">
          <p>
            No workers found.{" "}
            <Link href="/workers/new">Add your first field worker</Link> to get
            started.
          </p>
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Trade</th>
              <th>Status</th>
              <th>Reliability</th>
              <th>Certifications</th>
              <th>Travel Zones</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {workers.map((worker) => (
              <tr key={worker.id}>
                <td>
                  <Link href={`/workers/${worker.id}`}>{worker.name}</Link>
                </td>
                <td>{worker.trade}</td>
                <td>
                  <span className={worker.status === "inactive" ? "muted" : ""}>
                    {worker.status}
                  </span>
                </td>
                <td>{worker.reliability_score.toFixed(1)}%</td>
                <td>
                  {worker.certifications.length > 0
                    ? worker.certifications.join(", ")
                    : <span className="muted">—</span>}
                </td>
                <td>
                  {worker.travel_zones.length > 0
                    ? worker.travel_zones.join(", ")
                    : <span className="muted">—</span>}
                </td>
                <td>
                  <Link href={`/workers/${worker.id}`} className="btn secondary">
                    View
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
