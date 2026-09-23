/**
 * Canonical paths for the two screens. Routing itself is react-router (see <Routes> in App.tsx);
 * this file only holds the path literals so links, the route table, and the server fallback all
 * point at one copy — don't scatter string literals.
 *
 * - Landing lives at the root: opening the default domain is the site, no prefix
 * - Console lives at `/console`; "last viewed" hangs off its query (`?m=…&ide=…&s=…`, see view-state.ts)
 */
export const LANDING_PATH = '/';
export const CONSOLE_PATH = '/console';
