export type NavLink = {
  label: string;
  href: string;
  exact?: boolean;
};

export type NavGroup = {
  label: string;
  links: NavLink[];
};

export type NavConfig = {
  primary: NavLink[];
  groups: NavGroup[];
};

export const NAV_CONFIG: NavConfig = {
  primary: [
    { label: "Home", href: "/", exact: true },
    { label: "Schedule", href: "/schedule" },
    { label: "Workers", href: "/workers" },
    { label: "Jobs", href: "/jobs" },
    { label: "Dispatch Events", href: "/dispatch/events" },
    { label: "Compliance", href: "/settings/compliance" },
    { label: "Crew Schedule", href: "/crew/schedule" },
    { label: "Analytics", href: "/analytics" },
  ],
  groups: [
    {
      label: "Operations",
      links: [
        { label: "Schedule", href: "/schedule" },
        { label: "Dispatch Events", href: "/dispatch/events" },
      ],
    },
    {
      label: "Crew",
      links: [
        { label: "Workers", href: "/workers" },
        { label: "Crew Schedule", href: "/crew/schedule" },
      ],
    },
    {
      label: "Jobs",
      links: [{ label: "Jobs", href: "/jobs" }],
    },
    {
      label: "Compliance",
      links: [{ label: "Compliance Settings", href: "/settings/compliance" }],
    },
    {
      label: "Analytics",
      links: [{ label: "Analytics Overview", href: "/analytics" }],
    },
  ],
};

export default NAV_CONFIG;
