/**
 * home-config — the company's root surface (company-root-landing-001).
 * Written by provisioning (_step_substrate_install) from CTO home_mode
 * + CMO positioning. Do NOT hand-edit.
 */
export interface HomeCta {
  label: string;
  href: string;
}

export interface HomeConfig {
  mode: "landing" | "conversation";
  headline?: string;
  subhead?: string;
  primaryCta?: HomeCta;
  secondaryCta?: HomeCta;
}

export const homeConfig: HomeConfig = {
  "mode": "landing",
  "headline": "When your tech no-shows at 7am, Crewlink reassigns the nearest qualified worker before your customer even notices \u2014 no d",
  "subhead": "Crewlink autonomously resolves crew cancellations, no-shows, and schedule disruptions in real time \u2014 replacing the dispatcher role for HVAC, plumbing, cleaning, pest control, and landscaping teams of 5\u201320 workers who are currently losing jo"
};
