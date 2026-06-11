import { redirect } from 'next/navigation';
import { createJob } from '@/lib/dispatch/job-access';
import Link from 'next/link';

export default function NewJobPage() {
  async function createJobAction(formData: FormData) {
    'use server';

    const title = (formData.get('title') as string)?.trim();
    if (!title) return;

    const certRaw = (formData.get('certifications') as string)?.trim();
    const certifications = certRaw
      ? certRaw
          .split(',')
          .map((c) => c.trim())
          .filter(Boolean)
      : [];

    await createJob({
      title,
      customerName: (formData.get('customerName') as string)?.trim() || '',
      customerEmail:
        (formData.get('customerEmail') as string)?.trim() || undefined,
      customerPhone:
        (formData.get('customerPhone') as string)?.trim() || undefined,
      locationAddress:
        (formData.get('locationAddress') as string)?.trim() || '',
      requiredCertifications: certifications,
      scheduledStart:
        (formData.get('scheduledStart') as string) || undefined,
      scheduledEnd:
        (formData.get('scheduledEnd') as string) || undefined,
      priority:
        ((formData.get('priority') as string) as 'low' | 'medium' | 'high' | 'urgent') ||
        'medium',
      notes: (formData.get('notes') as string)?.trim() || undefined,
    });

    redirect('/jobs');
  }

  return (
    <main>
      <div style={{ marginBottom: '1rem' }}>
        <Link href="/jobs" className="btn secondary">
          ← Back to Jobs
        </Link>
      </div>

      <h1>Create New Job</h1>
      <p>
        Add a new field-service job to the registry. Required fields are marked
        with *.
      </p>

      <form action={createJobAction}>
        <label htmlFor="title">Job Title *</label>
        <input
          id="title"
          name="title"
          type="text"
          required
          placeholder="e.g. HVAC Maintenance — 123 Main St"
        />

        <label htmlFor="customerName">Customer Name *</label>
        <input
          id="customerName"
          name="customerName"
          type="text"
          required
          placeholder="Full name"
        />

        <label htmlFor="customerEmail">Customer Email</label>
        <input
          id="customerEmail"
          name="customerEmail"
          type="email"
          placeholder="customer@example.com"
        />

        <label htmlFor="customerPhone">Customer Phone</label>
        <input
          id="customerPhone"
          name="customerPhone"
          type="tel"
          placeholder="+1 555 000 0000"
        />

        <label htmlFor="locationAddress">Service Location *</label>
        <input
          id="locationAddress"
          name="locationAddress"
          type="text"
          required
          placeholder="Full street address"
        />

        <label htmlFor="certifications">Required Certifications</label>
        <input
          id="certifications"
          name="certifications"
          type="text"
          placeholder="e.g. EPA 608, OSHA 30 (comma-separated)"
        />
        <span className="muted" style={{ fontSize: '0.85em' }}>
          Enter certifications separated by commas.
        </span>

        <label htmlFor="scheduledStart">Scheduled Start</label>
        <input
          id="scheduledStart"
          name="scheduledStart"
          type="datetime-local"
        />

        <label htmlFor="scheduledEnd">Scheduled End</label>
        <input id="scheduledEnd" name="scheduledEnd" type="datetime-local" />

        <label htmlFor="priority">Priority</label>
        <select id="priority" name="priority" defaultValue="medium">
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
          <option value="urgent">Urgent</option>
        </select>

        <label htmlFor="notes">Notes</label>
        <textarea
          id="notes"
          name="notes"
          rows={4}
          placeholder="Any special instructions or additional information..."
        />

        <div style={{ marginTop: '1.5rem', display: 'flex', gap: '0.5rem' }}>
          <button type="submit">Create Job</button>
          <Link href="/jobs" className="btn secondary">
            Cancel
          </Link>
        </div>
      </form>
    </main>
  );
}
