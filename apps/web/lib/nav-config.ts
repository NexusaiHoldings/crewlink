export type NavLink = {
  label: string;
  href: string;
  exact?: boolean;
};

export type NavGroup = {
  heading: string;
  links: NavLink[];
};

export type NavConfig = {
  primary: NavLink[];
  groups: NavGroup[];
};

export const NAV_CONFIG: NavConfig = {
  primary: [
    { label: "Home", href: "/" },
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
      heading: "Operations",
      links: [
        { label: "Schedule", href: "/schedule" },
        { label: "Dispatch Events", href: "/dispatch/events" },
      ],
    },
    {
      heading: "Crew",
      links: [
        { label: "Workers", href: "/workers" },
        { label: "Crew Schedule", href: "/crew/schedule" },
      ],
    },
    {
      heading: "Jobs",
      links: [{ label: "Jobs", href: "/jobs" }],
    },
    {
      heading: "Compliance",
      links: [{ label: "Compliance Settings", href: "/settings/compliance" }],
    },
    {
      heading: "Analytics",
      links: [{ label: "Analytics Overview", href: "/analytics" }],
    },
  ],
};

export default NAV_CONFIG;
