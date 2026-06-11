/**
 * Predictive scheduling law compliance rules.
 * Covers CA, OR, Chicago, and NYC — flagged by regulatory_risk worker as
 * carrying per-violation fines that must be audited before schedule publish.
 */

export type Jurisdiction = "CA" | "OR" | "chicago" | "nyc";

export type ViolationType =
  | "advance_notice"
  | "insufficient_rest"
  | "shift_too_long"
  | "overtime"
  | "blackout_period";

export interface ComplianceRule {
  id: string;
  jurisdiction: Jurisdiction;
  name: string;
  description: string;
  /** Minimum hours of advance notice required before a shift starts */
  advanceNoticeHours: number;
  /** Pay multiplier applied to affected hours when notice window is missed */
  shortNoticePremiumMultiplier: number;
  /** Minimum rest hours required between consecutive shifts */
  minRestHoursBetweenShifts: number;
  /** Maximum single-shift duration in hours */
  maxShiftHours: number;
  /** Weekly hours threshold after which premium pay applies */
  weeklyMaxHours: number;
  /** USD fine assessed per violation */
  perViolationFineUsd: number;
  /** ISO date string when the law took effect */
  effectiveDate: string;
}

export interface ComplianceViolation {
  ruleId: string;
  jurisdiction: Jurisdiction;
  workerId: string;
  shiftId: string;
  violationType: ViolationType;
  description: string;
  estimatedFineUsd: number;
  /** Per liability_assessor: overtime and safety violations require manager sign-off */
  requiresManagerConfirmation: boolean;
}

export interface AvailabilityWindow {
  dayOfWeek: number; // 0 = Sunday … 6 = Saturday
  startHour: number; // 0–23
  endHour: number;   // 0–23
}

export interface ScheduleConstraints {
  workerCertifications: string[];
  availabilityWindows: AvailabilityWindow[];
  travelZone: string;
  jurisdiction: Jurisdiction | null;
  maxWeeklyHours: number;
}

// ── Jurisdiction rule definitions ──────────────────────────────────────────

export const JURISDICTION_RULES: Record<Jurisdiction, ComplianceRule> = {
  CA: {
    id: "ca-predictive-scheduling",
    jurisdiction: "CA",
    name: "California Predictive Scheduling Law",
    description:
      "Requires 7-day advance notice of work schedules and 1.5× premium pay for last-minute changes.",
    advanceNoticeHours: 168, // 7 days
    shortNoticePremiumMultiplier: 1.5,
    minRestHoursBetweenShifts: 10,
    maxShiftHours: 10,
    weeklyMaxHours: 40,
    perViolationFineUsd: 50,
    effectiveDate: "2023-01-01",
  },
  OR: {
    id: "or-predictive-scheduling",
    jurisdiction: "OR",
    name: "Oregon Predictive Scheduling Law (SB 828)",
    description:
      "Requires 7-day advance notice; one additional hour of predictability pay per affected shift.",
    advanceNoticeHours: 168, // 7 days
    shortNoticePremiumMultiplier: 1.0,
    minRestHoursBetweenShifts: 10,
    maxShiftHours: 10,
    weeklyMaxHours: 40,
    perViolationFineUsd: 1000,
    effectiveDate: "2018-07-01",
  },
  chicago: {
    id: "chicago-fair-workweek",
    jurisdiction: "chicago",
    name: "Chicago Fair Workweek Ordinance",
    description:
      "Requires 10-day advance notice for covered industries; 1.25× premium pay for late schedule changes.",
    advanceNoticeHours: 240, // 10 days
    shortNoticePremiumMultiplier: 1.25,
    minRestHoursBetweenShifts: 11,
    maxShiftHours: 12,
    weeklyMaxHours: 40,
    perViolationFineUsd: 500,
    effectiveDate: "2020-07-01",
  },
  nyc: {
    id: "nyc-fair-workweek",
    jurisdiction: "nyc",
    name: "NYC Fair Workweek Law",
    description:
      "Requires 14-day advance notice for retail workers; 1.25× premium for changes within the notice window.",
    advanceNoticeHours: 336, // 14 days
    shortNoticePremiumMultiplier: 1.25,
    minRestHoursBetweenShifts: 11,
    maxShiftHours: 12,
    weeklyMaxHours: 40,
    perViolationFineUsd: 500,
    effectiveDate: "2017-11-01",
  },
};

// ── Jurisdiction detection ─────────────────────────────────────────────────

export function detectJurisdiction(
  state: string,
  city: string,
): Jurisdiction | null {
  const c = city.trim().toLowerCase();
  const s = state.trim().toLowerCase();

  if (c === "chicago" || c === "chicago, il") return "chicago";
  if (c === "new york" || c === "new york city" || c === "nyc" || c === "new york, ny")
    return "nyc";
  if (s === "ca" || s === "california") return "CA";
  if (s === "or" || s === "oregon") return "OR";

  return null;
}

// ── Individual violation checkers ──────────────────────────────────────────

export function checkAdvanceNoticeViolation(
  shiftStart: Date,
  schedulePublishedAt: Date,
  rule: ComplianceRule,
  workerId: string,
  shiftId: string,
): ComplianceViolation | null {
  const hoursUntilShift =
    (shiftStart.getTime() - schedulePublishedAt.getTime()) / (1000 * 60 * 60);

  if (hoursUntilShift >= rule.advanceNoticeHours) return null;

  return {
    ruleId: rule.id,
    jurisdiction: rule.jurisdiction,
    workerId,
    shiftId,
    violationType: "advance_notice",
    description:
      `Shift starts in ${Math.round(hoursUntilShift)} hours; ${rule.advanceNoticeHours} hours advance notice required under ${rule.name}.`,
    estimatedFineUsd: rule.perViolationFineUsd,
    requiresManagerConfirmation: true,
  };
}

export function checkRestPeriodViolation(
  previousShiftEnd: Date,
  nextShiftStart: Date,
  rule: ComplianceRule,
  workerId: string,
  shiftId: string,
): ComplianceViolation | null {
  const restHours =
    (nextShiftStart.getTime() - previousShiftEnd.getTime()) / (1000 * 60 * 60);

  if (restHours >= rule.minRestHoursBetweenShifts) return null;

  return {
    ruleId: rule.id,
    jurisdiction: rule.jurisdiction,
    workerId,
    shiftId,
    violationType: "insufficient_rest",
    description:
      `Worker has only ${Math.round(restHours)} hours of rest; ${rule.minRestHoursBetweenShifts} hours required under ${rule.name}.`,
    estimatedFineUsd: rule.perViolationFineUsd,
    requiresManagerConfirmation: true,
  };
}

export function checkShiftLengthViolation(
  shiftDurationHours: number,
  rule: ComplianceRule,
  workerId: string,
  shiftId: string,
): ComplianceViolation | null {
  if (shiftDurationHours <= rule.maxShiftHours) return null;

  return {
    ruleId: rule.id,
    jurisdiction: rule.jurisdiction,
    workerId,
    shiftId,
    violationType: "shift_too_long",
    description:
      `Shift is ${shiftDurationHours} hours; maximum allowed is ${rule.maxShiftHours} hours under ${rule.name}.`,
    estimatedFineUsd: rule.perViolationFineUsd,
    requiresManagerConfirmation: true,
  };
}

export function checkOvertimeViolation(
  projectedWeeklyHours: number,
  rule: ComplianceRule,
  workerId: string,
  shiftId: string,
): ComplianceViolation | null {
  if (projectedWeeklyHours <= rule.weeklyMaxHours) return null;

  return {
    ruleId: rule.id,
    jurisdiction: rule.jurisdiction,
    workerId,
    shiftId,
    violationType: "overtime",
    description:
      `Worker would reach ${projectedWeeklyHours} weekly hours; premium pay applies above ${rule.weeklyMaxHours} hours under ${rule.name}.`,
    // Overtime triggers premium pay obligation, not a direct fine
    estimatedFineUsd: 0,
    // Per liability_assessor: overtime-triggering schedules require human-in-loop confirmation
    requiresManagerConfirmation: true,
  };
}

// ── Batch compliance check ─────────────────────────────────────────────────

export interface ShiftComplianceInput {
  workerId: string;
  shiftId: string;
  shiftStart: Date;
  shiftEnd: Date;
  shiftDurationHours: number;
  previousShiftEnd: Date | null;
  projectedWeeklyHours: number;
  jurisdiction: Jurisdiction | null;
  schedulePublishedAt: Date;
}

export function runAllComplianceChecks(
  input: ShiftComplianceInput,
): ComplianceViolation[] {
  if (!input.jurisdiction) return [];

  const rule = JURISDICTION_RULES[input.jurisdiction];
  const violations: ComplianceViolation[] = [];

  const noticeViolation = checkAdvanceNoticeViolation(
    input.shiftStart,
    input.schedulePublishedAt,
    rule,
    input.workerId,
    input.shiftId,
  );
  if (noticeViolation) violations.push(noticeViolation);

  if (input.previousShiftEnd) {
    const restViolation = checkRestPeriodViolation(
      input.previousShiftEnd,
      input.shiftStart,
      rule,
      input.workerId,
      input.shiftId,
    );
    if (restViolation) violations.push(restViolation);
  }

  const lengthViolation = checkShiftLengthViolation(
    input.shiftDurationHours,
    rule,
    input.workerId,
    input.shiftId,
  );
  if (lengthViolation) violations.push(lengthViolation);

  const overtimeViolation = checkOvertimeViolation(
    input.projectedWeeklyHours,
    rule,
    input.workerId,
    input.shiftId,
  );
  if (overtimeViolation) violations.push(overtimeViolation);

  return violations;
}

// ── Blackout period helpers ────────────────────────────────────────────────

export interface BlackoutPeriod {
  jurisdiction: Jurisdiction;
  label: string;
  startDate: string; // ISO date
  endDate: string;   // ISO date
}

/** Returns true if the shift falls within any blackout period for its jurisdiction. */
export function isInBlackoutPeriod(
  shiftStart: Date,
  jurisdiction: Jurisdiction,
  blackouts: BlackoutPeriod[],
): BlackoutPeriod | null {
  const relevant = blackouts.filter((b) => b.jurisdiction === jurisdiction);
  for (const blackout of relevant) {
    const start = new Date(blackout.startDate);
    const end = new Date(blackout.endDate);
    end.setHours(23, 59, 59, 999);
    if (shiftStart >= start && shiftStart <= end) {
      return blackout;
    }
  }
  return null;
}
