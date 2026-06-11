import { getJobById, getAssignments } from '@/lib/dispatch/job-access';
import Link from 'next/link';
import { notFound } from 'next/navigation';

export const dynamic = 'force-dynamic';

function statusLabel(status: string): string {
  switch (status) {
    case 'pending':
      return 'Unassigned — awaiting a worker.';
    case 'assigned':
      return 'Assigned to a worker.';
    case 'in_progress':
      return 'Currently in progress.';
    case 'completed':
      return 'Completed.';
    case 'cancelled':
      return 'Cancelled.';
    default:
      return status;
  }
}

export default async function JobDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const job = await getJobById(params.id);
  if (!job) notFound();

  const assignments = await getAssignments([job.id]);
  const activeAssignment = assignments.find((a) => a.status === 'active') ?? null;

  return (
    <main>
      <div style={{ marginBottom: '1rem' }}>
        <Link href="/jobs" className="btn secondary">
          ← Back to Jobs
        </Link>
      </div>

      <h1>{job.title}</h1>
      <p>{statusLabel(job.status)}</p>

      <div className="card">
        <h2>Job Details</h2>
        <table>
          <tbody>
            <tr>
              <th>Status</th>
              <td>
                <span
                  style={{
                    color:
                      job.status === 'pending'
                        ? 'var(--substrate-danger)'
                        : job.status === 'completed'
                        ? 'var(--substrate-success)'
                        : 'inherit',
                  }}
                >
                  {job.status.replace('_', ' ')}
                </span>
              </td>
            </tr>
            <tr>
              <th>Priority</th>
              <td>{job.priority}</td>
            </tr>
            <tr>
              <th>Location</th>
              <td>{job.locationAddress || <span className="muted">—</span>}</td>
            </tr>
            <tr>
              <th>Scheduled Start</th>
              <td>
                {job.scheduledStart ? (
                  job.scheduledStart.toLocaleString()
                ) : (
                  <span className="muted">Unscheduled</span>
                )}
              </td>
            </tr>
            <tr>
              <th>Scheduled End</th>
              <td>
                {job.scheduledEnd ? (
                  job.scheduledEnd.toLocaleString()
                ) : (
                  <span className="muted">—</span>
                )}
              </td>
            </tr>
            <tr>
              <th>Created</th>
              <td>{job.createdAt.toLocaleString()}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>Customer Information</h2>
        <table>
          <tbody>
            <tr>
              <th>Name</th>
              <td>{job.customerName || <span className="muted">—</span>}</td>
            </tr>
            <tr>
              <th>Email</th>
              <td>{job.customerEmail || <span className="muted">—</span>}</td>
            </tr>
            <tr>
              <th>Phone</th>
              <td>{job.customerPhone || <span className="muted">—</span>}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {job.requiredCertifications.length > 0 && (
        <div className="card">
          <h2>Required Certifications</h2>
          <ul>
            {job.requiredCertifications.map((cert) => (
              <li key={cert}>{cert}</li>
            ))}
          </ul>
        </div>
      )}

      {job.notes && (
        <div className="card">
          <h2>Notes</h2>
          <p>{job.notes}</p>
        </div>
      )}

      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2>Assignment</h2>
          {job.status !== 'completed' && job.status !== 'cancelled' && (
            <Link href={`/jobs/${job.id}/assign`} className="btn">
              {activeAssignment ? 'Reassign Worker' : 'Assign Worker'}
            </Link>
          )}
        </div>
        {activeAssignment ? (
          <table>
            <tbody>
              <tr>
                <th>Worker</th>
                <td>{activeAssignment.workerName}</td>
              </tr>
              <tr>
                <th>Worker ID</th>
                <td>
                  <span className="muted">{activeAssignment.workerId}</span>
                </td>
              </tr>
              <tr>
                <th>Assigned At</th>
                <td>{activeAssignment.assignedAt.toLocaleString()}</td>
              </tr>
              <tr>
                <th>Assignment Status</th>
                <td>{activeAssignment.status}</td>
              </tr>
            </tbody>
          </table>
        ) : (
          <div className="empty">
            <p>No worker assigned yet.</p>
          </div>
        )}
      </div>
    </main>
  );
}
