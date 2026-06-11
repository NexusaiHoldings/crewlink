import type { JSX } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createWorker } from "@/lib/dispatch/worker-access";

async function handleCreate(formData: FormData): Promise<void> {
  "use server";

  const name = (formData.get("name") as string | null)?.trim() ?? "";
  const email = (formData.get("email") as string | null)?.trim() ?? "";
  const phone = (formData.get("phone") as string | null)?.trim() || undefined;
  const trade = (formData.get("trade") as string | null)?.trim() ?? "";
  const certRaw = (formData.get("certifications") as string | null)?.trim() ?? "";
  const zonesRaw = (formData.get("travel_zones") as string | null)?.trim() ?? "";
  const reliabilityRaw = formData.get("reliability_score") as string | null;
  const status =
    (formData.get("status") as string | null) === "inactive"
      ? "inactive"
      : "active";
  const notes = (formData.get("notes") as string | null)?.trim() || undefined;

  const certifications = certRaw
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  const travel_zones = zonesRaw
    .split(",")
    .map((z) => z.trim())
    .filter(Boolean);
  const reliability_score = reliabilityRaw
    ? Math.min(100, Math.max(0, Number(reliabilityRaw)))
    : 100;

  if (!name || !email || !trade) {
    throw new Error("Name, email, and trade are required.");
  }

  const worker = await createWorker({
    name,
    email,
    phone,
    trade,
    certifications,
    travel_zones,
    reliability_score,
    status,
    notes,
  });

  redirect(`/workers/${worker.id}`);
}

export default function NewWorkerPage(): JSX.Element {
  return (
    <main>
      <h1>Add Field Worker</h1>
      <p>
        Register a new field worker with their certifications, travel zones, and
        availability — required before the scheduling engine can dispatch them.
      </p>

      <Link href="/workers" className="btn secondary">
        ← Back to Workers
      </Link>

      <form action={handleCreate}>
        <div className="card">
          <h2>Basic Information</h2>

          <label htmlFor="name">Full Name *</label>
          <input
            id="name"
            name="name"
            type="text"
            required
            placeholder="e.g. Jordan Martinez"
            autoComplete="name"
          />

          <label htmlFor="email">Email Address *</label>
          <input
            id="email"
            name="email"
            type="email"
            required
            placeholder="worker@example.com"
            autoComplete="email"
          />

          <label htmlFor="phone">Phone Number</label>
          <input
            id="phone"
            name="phone"
            type="tel"
            placeholder="+1 (555) 000-0000"
            autoComplete="tel"
          />

          <label htmlFor="trade">Trade / Specialty *</label>
          <select id="trade" name="trade" required defaultValue="">
            <option value="" disabled>
              Select a trade…
            </option>
            <option value="HVAC">HVAC</option>
            <option value="Plumbing">Plumbing</option>
            <option value="Cleaning">Cleaning</option>
            <option value="Electrical">Electrical</option>
            <option value="General Maintenance">General Maintenance</option>
            <option value="Landscaping">Landscaping</option>
            <option value="Other">Other</option>
          </select>

          <label htmlFor="status">Status</label>
          <select id="status" name="status" defaultValue="active">
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
        </div>

        <div className="card">
          <h2>Qualifications</h2>

          <label htmlFor="certifications">
            Certifications{" "}
            <span className="muted">(comma-separated)</span>
          </label>
          <input
            id="certifications"
            name="certifications"
            type="text"
            placeholder="e.g. EPA 608, NATE, R-410A"
          />

          <label htmlFor="reliability_score">
            Initial Reliability Score{" "}
            <span className="muted">(0–100, default 100)</span>
          </label>
          <input
            id="reliability_score"
            name="reliability_score"
            type="number"
            min="0"
            max="100"
            step="0.1"
            defaultValue="100"
            placeholder="100"
          />
        </div>

        <div className="card">
          <h2>Coverage &amp; Availability</h2>

          <label htmlFor="travel_zones">
            Travel Zones{" "}
            <span className="muted">(comma-separated zip codes or neighborhoods)</span>
          </label>
          <input
            id="travel_zones"
            name="travel_zones"
            type="text"
            placeholder="e.g. 90210, 90211, Downtown, Westside"
          />
        </div>

        <div className="card">
          <h2>Notes</h2>

          <label htmlFor="notes">Additional Notes</label>
          <textarea
            id="notes"
            name="notes"
            rows={3}
            placeholder="Any relevant context: languages spoken, equipment owned, scheduling preferences…"
          />
        </div>

        <button type="submit" className="btn">
          Add Worker
        </button>
      </form>
    </main>
  );
}
