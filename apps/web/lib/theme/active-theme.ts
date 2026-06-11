/**
 * active-theme — the resolved ThemeContract this company wears.
 * Written by provisioning (_step_substrate_install) from the CMO's
 * ThemeContract (company-theme-authoring-001). Do NOT hand-edit.
 */
import type { ThemeContract } from "./contract";

export const activeTheme: ThemeContract = {
  "type": {
    "fontBody": "inter",
    "fontHeading": "inter"
  },
  "color": {
    "bg": "#f5f7fa",
    "text": "#1a2332",
    "accent": "#1a4f9c",
    "border": "#d4dbe6",
    "danger": "#b52b2b",
    "success": "#1a6b40",
    "surface": "#ffffff",
    "textMuted": "#4f5f74",
    "accentText": "#ffffff",
    "surfaceAlt": "#eaeff5",
    "borderStrong": "#b0bccf"
  },
  "shape": {
    "radius": 6
  }
};
