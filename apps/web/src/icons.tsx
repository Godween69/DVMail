// Небольшой набор иконок (линии 1.8). Рисуем сами, чтобы не тянуть библиотеку.
import type { ReactNode, SVGProps } from "react";

const base = (d: ReactNode) => (p: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...p}>{d}</svg>
);

export const IconInbox = base(<><path d="M3 13l2.6-7.2A2 2 0 0 1 7.5 4.5h9a2 2 0 0 1 1.9 1.3L21 13" /><path d="M3 13v5a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5h-5.5a2.5 2.5 0 0 1-5 0H3z" /></>);
export const IconSend = base(<><path d="M21 3L10.5 13.5" /><path d="M21 3l-6.5 18-4-7.5L3 9.5 21 3z" /></>);
export const IconDraft = base(<><path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3z" /><path d="M13.5 8.5l3 3" /></>);
export const IconTrash = base(<><path d="M4 7h16" /><path d="M10 11v6M14 11v6" /><path d="M6 7l1 12a2 2 0 0 0 2 1.8h6a2 2 0 0 0 2-1.8l1-12" /><path d="M9 7V4.8A.8.8 0 0 1 9.8 4h4.4a.8.8 0 0 1 .8.8V7" /></>);
export const IconJunk = base(<><path d="M12 3l8 3v6c0 4.4-3.2 7.8-8 9-4.8-1.2-8-4.6-8-9V6l8-3z" /><path d="M12 8.5v4M12 15.6v.1" /></>);
export const IconArchive = base(<><rect x="3" y="4" width="18" height="4.5" rx="1.2" /><path d="M5 8.5V18a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5" /><path d="M10 12.5h4" /></>);
export const IconFolder = base(<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />);
export const IconSearch = base(<><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" /></>);
export const IconClip = base(<path d="M20 11.5l-8 8a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7L9.5 17.2a1.7 1.7 0 0 1-2.4-2.4l7.6-7.6" />);
export const IconSun = base(<><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" /></>);
export const IconMoon = base(<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" />);
export const IconLogout = base(<><path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4" /><path d="M16 8l4 4-4 4M20 12H9" /></>);
export const IconDownload = base(<><path d="M12 4v11M7.5 11L12 15.5 16.5 11" /><path d="M5 19.5h14" /></>);
export const IconMailOpen = base(<><path d="M3 9.5l9-6 9 6V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9.5z" /><path d="M3 10l9 6 9-6" /></>);
export const IconMail = base(<><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3.5 6.5L12 13l8.5-6.5" /></>);
export const IconBack = base(<path d="M15 5l-7 7 7 7" />);
export const IconMenu = base(<path d="M4 7h16M4 12h16M4 17h16" />);
export const IconLink = base(<><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1" /></>);
export const IconCopy = base(<><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>);
export const IconExternal = base(<><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" /></>);
export const IconLock = base(<><rect x="5" y="10.5" width="14" height="9.5" rx="2" /><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" /></>);
export const IconAlert = base(<><path d="M12 3.5l9 16H3l9-16z" /><path d="M12 10v4.2M12 17.2v.1" /></>);
export const IconX = base(<path d="M6 6l12 12M18 6L6 18" />);
export const IconEye = base(<><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="2.8" /></>);
export const IconEyeOff = base(<><path d="M4 4l16 16" /><path d="M9.9 5.8A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-3 3.8M6.2 7.6C3.7 9.4 2.5 12 2.5 12S6 18.5 12 18.5c1.3 0 2.5-.3 3.5-.8" /><path d="M10 10a3 3 0 0 0 4 4" /></>);
export const IconRefresh = base(<><path d="M20 11a8 8 0 0 0-14.3-4.3L4 8.5" /><path d="M4 4v4.5h4.5" /><path d="M4 13a8 8 0 0 0 14.3 4.3L20 15.5" /><path d="M20 20v-4.5h-4.5" /></>);
export const IconFile = base(<><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z" /><path d="M14 3v5h5" /></>);
export const IconShield = base(<><path d="M12 3l8 3v6c0 4.4-3.2 7.8-8 9-4.8-1.2-8-4.6-8-9V6l8-3z" /><path d="M8.7 12.2l2.3 2.3 4.3-4.6" /></>);
