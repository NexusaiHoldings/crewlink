import { getJobsWithAssignments, JobWithAssignment } from '@/lib/dispatch/job-access';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

function isAtRisk(job: JobWithAssignment): boolean {
  if (job.assignment) return false;
  if (!job.scheduledStart) return false;
  const hoursUntil =
    (job.scheduledStart.getTime() - Date.now()) / (1000 * 60 * 60);
  return hoursUntil >= 0 && hoursUntil <= 24;
}

const FILTER_OPTIONS = [
  { value: 'active', label: 'Active Jobs' },
  { value: 'unassigned', label: 'Unassigned' },
  { value: 'at_risk', label: 'At Risk (24 h)' },
  { value: 'all', label: 'All Jobs' },
] as const;

type FilterOption = (typeof FILTER_OPTIONS)[number]['value'];

export default async function SchedulePage({
  searchParams,
}: {
  searchParams: { filter?: string };
}) {
  const rawFilter = searchParams.filter ?? 'active';
  const filter: FilterOption =
    FILTER_OPTIONS.some((f) => f.value === rawFilter)
      ? (rawFilter as FilterOption)
      : 'active';

  const allJobs = await getJobsWithAssignments();

  const unassigned = allJobs.filter(
    (j) =>
      j.status !== 'completed' &&
      j.status !== 'cancelled' &&
      !j.assignment,
  );

  const atRisk = allJobs.filter(isAtRisk);

  const filtered =
    filter === 'unassigned'
      ? unassigned
      : filter === 'at_risk'
      ? atRisk
      : filter === 'all'
      ? allJobs
      : allJobs.filter(
          (j) => j.status !== 'completed' && j.status !== 'cancelled',
        );

  return (
    <main>
      <h1>Assignment Board</h1>
      <p>
        Overview of job-to-worker assignments. Unassigned and at-risk jobs are
        surfaced for immediate action.
      </p>

      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.5rem' }}>
        <Link href="/jobs/new" className="btn">+ New Job</Link>
        <Link href="/jobs" className="btn secondary">Job Registry</Link>
      </div>

      {(unassigned.length > 0 || atRisk.length > 0) && (
        <div
          className="card"
          style={{ borderColor: 'var(--substrate-danger)', marginBottom: '1.5rem' }}
        >
          <h2 style={{ color: 'var(--substrate-danger)' }}>Attention Required</h2>
          {unassigned.length > 0 && (
            <p>
              <strong>{unassigned.length}</strong> job
              {unassigned.length !== 1 ? 's' : ''} without an assigned worker.{' '}
              <a href="/schedule?filter=unassigned" className="btn secondary">
                View unassigned
              </a>
            </p>
          )}
          {atRisk.length > 0 && (
            <p>
              <strong>{atRisk.length}</strong> job
              {atRisk.length !== 1 ? 's' : ''} start within 24 hours with no
              worker assigned.{' '}
              <a href="/schedule?filter=at_risk" className="btn secondary">
                View at-risk
              </a>
            </p>
          )}
        </div>
      )}

      <div className="toolbar">
        {FILTER_OPTIONS.map((opt) => (
          <a
            key={opt.value}
            href={`/schedule?filter=${opt.value}`}
            className={filter === opt.value ? 'btn' : 'btn secondary'}
          >
            {opt.label}
          </a>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="empty">
          <p>
            No jobs match this filter.{' '}
            <Link href="/jobs/new">Create a new job</Link> or choose a different
            filter above.
          </p>
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Job</th>
              <th>Customer</th>
              <th>Location</th>
              <th>Priority</th>
              <th>Scheduled Start</th>
              <th>Assigned Worker</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((job) => {
              const needsAttention =
                !job.assignment &&
                job.status !== 'completed' &&
                job.status !== 'cancelled';
              return (
                <tr
                  key={job.id}
                  style={
                    needsAttention
                      ? { outline: '1px solid var(--substrate-danger)' }
                      : undefined
                  }
                >
                  <td>
                    <Link href={`/jobs/${job.id}`}>{job.title}</Link>
                    {isAtRisk(job) && (
                      <span
                        className="muted"
                        style={{
                          color: 'var(--substrate-danger)',
                          marginLeft: '0.4em',
                          fontSize: '0.8em',
                        }}
                      >
                        ⚠ &lt;24 h
                      </span>
                    )}
                  </td>
                  <td>
                    {job.customerName || <span className="muted">—</span>}
                  </td>
                  <td>
                    {job.locationAddress || <span className="muted">—</span>}
                  </td>
                  <td>{job.priority}</td>
                  <td>
                    {job.scheduledStart ? (
                      job.scheduledStart.toLocaleString()
                    ) : (
                      <span className="muted">Unscheduled</span>
                    )}
                  </td>
                  <td>
                    {job.assignment ? (
                      job.assignment.workerName
                    ) : (
                      <span style={{ color: 'var(--substrate-danger)' }}>
                        Unassigned
                      </span>
                    )}
                  </td>
                  <td>{job.status.replace('_', ' ')}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </main>
  );
}
