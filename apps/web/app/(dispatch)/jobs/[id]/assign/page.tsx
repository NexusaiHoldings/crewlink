import { getJobById } from '@/lib/dispatch/job-access';
import { listWorkers } from '@/lib/dispatch/worker-access';
import { assignWorkerToJob } from '@/lib/dispatch/assignment-actions';
import Link from 'next/link';
import { notFound } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default async function AssignWorkerPage({
  params,
}: {
  params: { id: string };
}) {
  const job = await getJobById(params.id);
  if (!job) notFound();

  if (job.status === 'completed' || job.status === 'cancelled') {
    return (
      <main>
        <div style={{ marginBottom: '1rem' }}>
          <Link href={`/jobs/${job.id}`} className="btn secondary">
            ← Back to Job
          </Link>
        </div>
        <h1>Cannot Assign Worker</h1>
        <div className="card">
          <p>
            This job is <strong>{job.status}</strong> and cannot be assigned a
            worker.
          </p>
        </div>
      </main>
    );
  }

  const workers = await listWorkers({ status: 'active' });

  const eligible = job.requiredCertifications.length > 0
    ? workers.filter((w) =>
        job.requiredCertifications.every((cert) =>
          w.certifications.includes(cert),
        ),
      )
    : workers;

  const ineligible = workers.filter((w) => !eligible.includes(w));

  return (
    <main>
      <div style={{ marginBottom: '1rem' }}>
        <Link href={`/jobs/${job.id}`} className="btn secondary">
          ← Back to Job
        </Link>
      </div>

      <h1>Assign Worker</h1>
      <p>
        Select an active worker to assign to{' '}
        <strong>{job.title}</strong>.
      </p>

      {job.requiredCertifications.length > 0 && (
        <div className="card" style={{ marginBottom: '1.5rem' }}>
          <h2>Required Certifications</h2>
          <ul>
            {job.requiredCertifications.map((cert) => (
              <li key={cert}>{cert}</li>
            ))}
          </ul>
        </div>
      )}

      <form action={assignWorkerToJob}>
        <input type="hidden" name="jobId" value={job.id} />

        {workers.length === 0 ? (
          <div className="empty">
            <p>
              No active workers found. Please{' '}
              <Link href="/workers/new">add a worker</Link> first.
            </p>
          </div>
        ) : (
          <>
            <label htmlFor="workerId">Select Worker *</label>
            <select id="workerId" name="workerId" required>
              <option value="">— Choose a worker —</option>

              {eligible.length > 0 && (
                <optgroup label="Qualified Workers">
                  {eligible.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name} — {w.trade}
                      {w.reliability_score < 100
                        ? ` (reliability: ${w.reliability_score})`
                        : ''}
                    </option>
                  ))}
                </optgroup>
              )}

              {ineligible.length > 0 && (
                <optgroup label="Missing Certifications">
                  {ineligible.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name} — {w.trade} (missing certs)
                    </option>
                  ))}
                </optgroup>
              )}
            </select>

            <label htmlFor="notes">Assignment Notes</label>
            <textarea
              id="notes"
              name="notes"
              rows={3}
              placeholder="Optional notes about this assignment…"
            />

            <div style={{ marginTop: '1.5rem', display: 'flex', gap: '0.5rem' }}>
              <button type="submit">Assign Worker</button>
              <Link href={`/jobs/${job.id}`} className="btn secondary">
                Cancel
              </Link>
            </div>
          </>
        )}
      </form>

      {eligible.length === 0 && workers.length > 0 && (
        <div
          className="card"
          style={{
            borderColor: 'var(--substrate-danger)',
            marginTop: '1rem',
          }}
        >
          <p style={{ color: 'var(--substrate-danger)' }}>
            No workers have all required certifications. You can still assign
            any active worker using the list above, but they may need additional
            training.
          </p>
        </div>
      )}
    </main>
  );
}
