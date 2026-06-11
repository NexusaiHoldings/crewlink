import { getJobs, JobStatus } from '@/lib/dispatch/job-access';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

const VALID_STATUSES: JobStatus[] = [
  'pending',
  'assigned',
  'in_progress',
  'completed',
  'cancelled',
];

export default async function JobsPage({
  searchParams,
}: {
  searchParams: { status?: string };
}) {
  const rawStatus = searchParams.status ?? '';
  const status = VALID_STATUSES.includes(rawStatus as JobStatus)
    ? (rawStatus as JobStatus)
    : undefined;

  const jobs = await getJobs(status ? { status } : undefined);

  return (
    <main>
      <h1>Job Registry</h1>
      <p>Create and manage field-service jobs for dispatch. Unassigned jobs are highlighted.</p>

      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.5rem' }}>
        <Link href="/jobs/new" className="btn">+ New Job</Link>
        <Link href="/schedule" className="btn secondary">Assignment Board</Link>
      </div>

      <div className="toolbar">
        <form method="get">
          <select name="status" defaultValue={rawStatus}>
            <option value="">All Statuses</option>
            <option value="pending">Pending</option>
            <option value="assigned">Assigned</option>
            <option value="in_progress">In Progress</option>
            <option value="completed">Completed</option>
            <option value="cancelled">Cancelled</option>
          </select>
          <button type="submit">Filter</button>
          {rawStatus && (
            <a href="/jobs" className="btn secondary">Clear</a>
          )}
        </form>
      </div>

      {jobs.length === 0 ? (
        <div className="empty">
          <p>
            No jobs found.{' '}
            <Link href="/jobs/new">Create your first job</Link> to get started.
          </p>
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Title</th>
              <th>Customer</th>
              <th>Location</th>
              <th>Priority</th>
              <th>Status</th>
              <th>Scheduled Start</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <tr key={job.id}>
                <td>
                  <Link href={`/jobs/${job.id}`}>{job.title}</Link>
                </td>
                <td>{job.customerName || <span className="muted">—</span>}</td>
                <td>{job.locationAddress || <span className="muted">—</span>}</td>
                <td>{job.priority}</td>
                <td>
                  <span
                    style={{
                      color:
                        job.status === 'pending'
                          ? 'var(--substrate-danger)'
                          : job.status === 'completed'
                          ? 'var(--substrate-success)'
                          : 'inherit',
                      fontWeight: job.status === 'pending' ? 600 : undefined,
                    }}
                  >
                    {job.status.replace('_', ' ')}
                  </span>
                </td>
                <td>
                  {job.scheduledStart ? (
                    job.scheduledStart.toLocaleDateString()
                  ) : (
                    <span className="muted">Unscheduled</span>
                  )}
                </td>
                <td>
                  <Link href={`/jobs/${job.id}`} className="btn secondary">
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
