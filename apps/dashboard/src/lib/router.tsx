import type { AnchorHTMLAttributes } from "react";
import { useSyncExternalStore } from "react";

/**
 * Dashboard routes live in the URL hash. Paths such as `/projects/:id` and
 * `/orgs/:id/*` belong to the Worker's management API, so a path router would
 * send reloads and shared links to JSON endpoints instead of the app.
 */
const subscribe = (notify: () => void) => {
  window.addEventListener("hashchange", notify);

  return () => window.removeEventListener("hashchange", notify);
};

const read = () => {
  const path = window.location.hash.replace(/^#/, "");

  return path.startsWith("/") ? path : `/${path}`;
};

/** The current hash path with its query string, e.g. `/orgs/acme/audit?outcome=deny`. */
export const useLocation = () => useSyncExternalStore(subscribe, read, () => "/");

export const navigate = (to: string, options: { readonly replace?: boolean } = {}) => {
  const hash = `#${to}`;

  if (options.replace) window.history.replaceState(null, "", hash);
  else window.location.hash = hash;
  window.dispatchEvent(new HashChangeEvent("hashchange"));
};

export const splitLocation = (location: string) => {
  const [path = "/", query = ""] = location.split("?", 2);

  return { path, params: new URLSearchParams(query) };
};

/** Match `/orgs/:org/projects/:id` against a path; segments are URI-decoded. */
export const matchRoute = (
  pattern: string,
  path: string,
): Readonly<Record<string, string>> | undefined => {
  const expected = pattern.split("/").filter(Boolean);
  const actual = path.split("/").filter(Boolean);

  if (expected.length !== actual.length) return undefined;
  const params: Record<string, string> = {};

  for (const [index, segment] of expected.entries()) {
    const value = actual[index]!;

    if (segment.startsWith(":")) {
      try {
        params[segment.slice(1)] = decodeURIComponent(value);
      } catch {
        return undefined;
      }
    } else if (segment !== value) return undefined;
  }

  return params;
};

export const href = (path: string) => `#${path}`;

export function Link({
  to,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & { readonly to: string }) {
  return <a {...props} href={href(to)} />;
}
