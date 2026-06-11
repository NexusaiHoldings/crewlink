export const NAV_CONFIG = {
  primary: [
    { label: "Schedule", href: "/schedule" },
    { label: "Workers", href: "/workers" },
    { label: "Jobs", href: "/jobs" },
    { label: "Analytics", href: "/analytics" },
  ],
  groups: [
    {
      label: "Operations",
      items: [{ label: "Dispatch Log", href: "/dispatch/events" }],
    },
    {
      label: "Settings",
      items: [{ label: "Compliance", href: "/settings/compliance" }],
    },
    {
      label: "Crew",
      items: [{ label: "Schedule", href: "/crew/schedule" }],
    },
  ],
};
