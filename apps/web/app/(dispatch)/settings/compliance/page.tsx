/**
 * Compliance Settings Page
 *
 * Managers configure which predictive scheduling law jurisdictions are active
 * for their workforce, review rule parameters, and manage blackout periods.
 * Rules are stored as typed objects in Postgres for auditable, queryable
 * compliance state rather than opaque config files.
 */

import { redirect } from "next/navigation";
import { Pool } from "pg";
import {
  JURISDICTION_RULES,
  detectJurisdiction,
} from "@/lib/dispatch/compliance-rules";
import type { Jurisdiction, ComplianceRule, BlackoutPeriod } from "@/lib/dispatch/compliance-rules";
import type { JSX } from "react";

// ── Database helpers ───────────────────────────────────────────────────────

function getPool(): Pool {
  return new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
}

interface ActiveJurisdictionRow {
  jurisdiction: string;
  enabled: boolean;
  overrides: Record<string, unknown> | null;
  updated_at: Date;
}

interface BlackoutPeriodRow {
  id: string;
  jurisdiction: string;
  label: string;
  start_date: string;
  end_date: string;
  created_at: Date;
}

async function fetchActiveJurisdictions(): Promise<ActiveJurisdictionRow[]> {
  const db = getPool();
  try {
    const result = await db.query<ActiveJurisdictionRow>(
      `SELECT jurisdiction, enabled, overrides, updated_at
       FROM dispatch_compliance_jurisdictions
       ORDER BY jurisdiction ASC`,
    );
    return result.rows;
  } catch {
    // Table may not exist yet — return empty so the page degrades gracefully
    return [];
  } finally {
    await db.end();
  }
}

async function fetchBlackoutPeriods(): Promise<BlackoutPeriodRow[]> {
  const db = getPool();
  try {
    const result = await db.query<BlackoutPeriodRow>(
      `SELECT id, jurisdiction, label, start_date, end_date, created_at
       FROM dispatch_compliance_blackouts
       ORDER BY start_date DESC
       LIMIT 50`,
    );
    return result.rows;
  } catch {
    return [];
  } finally {
    await db.end();
  }
}

// ── Server Actions ─────────────────────────────────────────────────────────

async function handleToggleJurisdiction(formData: FormData): Promise<void> {
  "use server";

  const jurisdiction = formData.get("jurisdiction") as string;
  const enabled = formData.get("enabled") === "true";

  if (!jurisdiction || !["CA", "OR", "chicago", "nyc"].includes(jurisdiction)) {
    redirect("/settings/compliance?error=Invalid+jurisdiction");
  }

  const db = getPool();
  try {
    await db.query(
      `INSERT INTO dispatch_compliance_jurisdictions (jurisdiction, enabled, overrides, updated_at)
       VALUES ($1, $2, NULL, NOW())
       ON CONFLICT (jurisdiction) DO UPDATE
         SET enabled = $2, updated_at = NOW()`,
      [jurisdiction, enabled],
    );
  } finally {
    await db.end();
  }

  redirect("/settings/compliance");
}

async function handleAddBlackout(formData: FormData): Promise<void> {
  "use server";

  const jurisdiction = formData.get("jurisdiction") as string;
  const label = (formData.get("label") as string)?.trim();
  const startDate = formData.get("startDate") as string;
  const endDate = formData.get("endDate") as string;

  if (!jurisdiction || !label || !startDate || !endDate) {
    redirect("/settings/compliance?error=All+blackout+fields+are+required");
  }
  if (endDate < startDate) {
    redirect("/settings/compliance?error=End+date+must+be+on+or+after+start+date");
  }

  const db = getPool();
  try {
    await db.query(
      `INSERT INTO dispatch_compliance_blackouts (id, jurisdiction, label, start_date, end_date, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [crypto.randomUUID(), jurisdiction, label, startDate, endDate],
    );
  } finally {
    await db.end();
  }

  redirect("/settings/compliance");
}

async function handleDeleteBlackout(formData: FormData): Promise<void> {
  "use server";

  const blackoutId = formData.get("blackoutId") as string;
  if (!blackoutId) {
    redirect("/settings/compliance?error=Missing+blackout+ID");
  }

  const db = getPool();
  try {
    await db.query(
      `DELETE FROM dispatch_compliance_blackouts WHERE id = $1`,
      [blackoutId],
    );
  } finally {
    await db.end();
  }

  redirect("/settings/compliance");
}

// ── Rule card component ────────────────────────────────────────────────────

function JurisdictionRuleCard({
  rule,
  isEnabled,
}: {
  rule: ComplianceRule;
  isEnabled: boolean;
}): JSX.Element {
  const toggleValue = isEnabled ? "false" : "true";
  const toggleLabel = isEnabled ? "Disable" : "Enable";

  return (
    <div
      className="card"
      style={{
        opacity: isEnabled ? 1 : 0.6,
        borderLeft: isEnabled ? "3px solid #2563eb" : "3px solid #e5e7eb",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "0.5rem" }}>
        <div>
          <h3 style={{ margin: "0 0 4px" }}>{rule.name}</h3>
          <p className="muted" style={{ margin: 0, fontSize: "14px" }}>
            {rule.description}
          </p>
        </div>
        <form action={handleToggleJurisdiction}>
          <input type="hidden" name="jurisdiction" value={rule.jurisdiction} />
          <input type="hidden" name="enabled" value={toggleValue} />
          <button type="submit" className={isEnabled ? "btn secondary" : "btn"}>
            {toggleLabel}
          </button>
        </form>
      </div>

      <dl
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
          gap: "0.75rem 1.5rem",
          marginTop: "1rem",
        }}
      >
        <div>
          <dt className="muted" style={{ fontSize: "12px" }}>Advance Notice</dt>
          <dd style={{ margin: 0, fontWeight: 600 }}>
            {rule.advanceNoticeHours}h ({Math.round(rule.advanceNoticeHours / 24)} days)
          </dd>
        </div>
        <div>
          <dt className="muted" style={{ fontSize: "12px" }}>Short-Notice Premium</dt>
          <dd style={{ margin: 0, fontWeight: 600 }}>{rule.shortNoticePremiumMultiplier}×</dd>
        </div>
        <div>
          <dt className="muted" style={{ fontSize: "12px" }}>Min Rest Between Shifts</dt>
          <dd style={{ margin: 0, fontWeight: 600 }}>{rule.minRestHoursBetweenShifts}h</dd>
        </div>
        <div>
          <dt className="muted" style={{ fontSize: "12px" }}>Max Shift Length</dt>
          <dd style={{ margin: 0, fontWeight: 600 }}>{rule.maxShiftHours}h</dd>
        </div>
        <div>
          <dt className="muted" style={{ fontSize: "12px" }}>Weekly OT Threshold</dt>
          <dd style={{ margin: 0, fontWeight: 600 }}>{rule.weeklyMaxHours}h</dd>
        </div>
        <div>
          <dt className="muted" style={{ fontSize: "12px" }}>Per-Violation Fine</dt>
          <dd style={{ margin: 0, fontWeight: 600, color: "#b91c1c" }}>
            ${rule.perViolationFineUsd.toLocaleString()}
          </dd>
        </div>
        <div>
          <dt className="muted" style={{ fontSize: "12px" }}>Law Effective</dt>
          <dd style={{ margin: 0, fontWeight: 600 }}>{rule.effectiveDate}</dd>
        </div>
      </dl>
    </div>
  );
}

// ── Blackout period table ──────────────────────────────────────────────────

function BlackoutPeriodsTable({
  periods,
}: {
  periods: BlackoutPeriodRow[];
}): JSX.Element {
  if (periods.length === 0) {
    return (
      <div className="empty">
        No blackout periods configured. Add one below to block shift generation
        during high-risk compliance windows (e.g. holidays, union voting periods).
      </div>
    );
  }

  return (
    <table>
      <thead>
        <tr>
          <th>Jurisdiction</th>
          <th>Label</th>
          <th>Start</th>
          <th>End</th>
          <th>Added</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {periods.map((p) => (
          <tr key={p.id}>
            <td>
              <strong>{p.jurisdiction.toUpperCase()}</strong>
            </td>
            <td>{p.label}</td>
            <td>{p.start_date}</td>
            <td>{p.end_date}</td>
            <td className="muted" style={{ fontSize: "13px" }}>
              {new Date(p.created_at).toLocaleDateString()}
            </td>
            <td>
              <form action={handleDeleteBlackout}>
                <input type="hidden" name="blackoutId" value={p.id} />
                <button
                  type="submit"
                  className="btn secondary"
                  style={{ fontSize: "12px", padding: "2px 8px", color: "#b91c1c" }}
                >
                  Remove
                </button>
              </form>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────

export default async function ComplianceSettingsPage({
  searchParams,
}: {
  searchParams: { error?: string };
}): Promise<JSX.Element> {
  const errorMsg = searchParams.error;

  const [activeRows, blackouts] = await Promise.all([
    fetchActiveJurisdictions(),
    fetchBlackoutPeriods(),
  ]);

  // Build a lookup of enabled jurisdictions from DB; default to enabled when no row exists
  const enabledMap = new Map<string, boolean>();
  for (const row of activeRows) {
    enabledMap.set(row.jurisdiction, row.enabled);
  }

  const allJurisdictions = Object.keys(JURISDICTION_RULES) as Jurisdiction[];

  return (
    <main>
      <h1>Compliance Settings</h1>
      <p>
        Configure which predictive scheduling laws govern your workforce.
        Enabled rules run on every schedule generation — violations are flagged
        and overtime-triggering schedules are held for manager confirmation.
      </p>

      {errorMsg && (
        <div
          role="alert"
          style={{
            padding: "0.75rem 1rem",
            background: "#fee2e2",
            color: "#991b1b",
            borderRadius: "6px",
            marginBottom: "1.5rem",
            fontSize: "14px",
          }}
        >
          {decodeURIComponent(errorMsg)}
        </div>
      )}

      {/* ── Jurisdiction rules ── */}
      <section style={{ marginBottom: "2.5rem" }}>
        <h2>Jurisdiction Rules</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
          {allJurisdictions.map((jur) => (
            <JurisdictionRuleCard
              key={jur}
              rule={JURISDICTION_RULES[jur]}
              isEnabled={enabledMap.get(jur) ?? true}
            />
          ))}
        </div>
      </section>

      {/* ── Blackout periods ── */}
      <section style={{ marginBottom: "2.5rem" }}>
        <h2>Blackout Periods</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Shifts scheduled within a blackout window are flagged as{" "}
          <em>blackout_period</em> violations before the schedule is generated.
        </p>
        <BlackoutPeriodsTable periods={blackouts} />

        {/* Add blackout form */}
        <form action={handleAddBlackout}>
          <div
            className="card"
            style={{ marginTop: "1.25rem" }}
          >
            <h3 style={{ margin: "0 0 1rem" }}>Add Blackout Period</h3>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
                gap: "0.75rem",
                alignItems: "end",
              }}
            >
              <div>
                <label htmlFor="bp-jurisdiction">Jurisdiction</label>
                <select
                  id="bp-jurisdiction"
                  name="jurisdiction"
                  required
                  style={{ display: "block", marginTop: "4px", width: "100%" }}
                >
                  {allJurisdictions.map((jur) => (
                    <option key={jur} value={jur}>
                      {JURISDICTION_RULES[jur].name.split(" ")[0]} ({jur.toUpperCase()})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="bp-label">Label</label>
                <input
                  id="bp-label"
                  name="label"
                  type="text"
                  placeholder="e.g. Thanksgiving week"
                  required
                  style={{ display: "block", marginTop: "4px", width: "100%" }}
                />
              </div>

              <div>
                <label htmlFor="bp-start">Start Date</label>
                <input
                  id="bp-start"
                  name="startDate"
                  type="date"
                  required
                  style={{ display: "block", marginTop: "4px", width: "100%" }}
                />
              </div>

              <div>
                <label htmlFor="bp-end">End Date</label>
                <input
                  id="bp-end"
                  name="endDate"
                  type="date"
                  required
                  style={{ display: "block", marginTop: "4px", width: "100%" }}
                />
              </div>

              <div>
                <button type="submit" className="btn">
                  Add Blackout
                </button>
              </div>
            </div>
          </div>
        </form>
      </section>

      {/* ── Compliance summary ── */}
      <section>
        <h2>Law Reference</h2>
        <table>
          <thead>
            <tr>
              <th>Jurisdiction</th>
              <th>Law</th>
              <th>Notice Required</th>
              <th>Per-Violation Fine</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {allJurisdictions.map((jur) => {
              const rule = JURISDICTION_RULES[jur];
              const isEnabled = enabledMap.get(jur) ?? true;
              return (
                <tr key={jur}>
                  <td>
                    <strong>{jur.toUpperCase()}</strong>
                  </td>
                  <td style={{ fontSize: "13px" }}>{rule.name}</td>
                  <td>
                    {Math.round(rule.advanceNoticeHours / 24)} days
                  </td>
                  <td style={{ color: "#b91c1c" }}>
                    ${rule.perViolationFineUsd.toLocaleString()}
                  </td>
                  <td>
                    <span
                      style={{
                        padding: "2px 8px",
                        borderRadius: "4px",
                        fontSize: "12px",
                        background: isEnabled ? "#d1fae5" : "#f3f4f6",
                        color: isEnabled ? "#065f46" : "#6b7280",
                      }}
                    >
                      {isEnabled ? "Active" : "Disabled"}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </main>
  );
}
