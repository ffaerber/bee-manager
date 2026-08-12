/**
 * A two-route router, written out rather than pulled in.
 *
 * The app has exactly two pages — the overview and one batch — so a routing
 * library would be more code than this, and more to keep current.
 *
 * Links are real <a href> elements with this intercepting the click, so
 * middle-click, ctrl-click, "copy link address" and the back button all behave
 * the way they look like they should. A div with an onClick would break every
 * one of those.
 */

import { useEffect, useState } from 'react';

export function usePath(): string {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    // pushState does not fire popstate, so navigate() announces itself.
    window.addEventListener('ssm:navigate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      window.removeEventListener('ssm:navigate', onPop);
    };
  }, []);
  return path;
}

export function navigate(to: string) {
  if (to === window.location.pathname) return;
  window.history.pushState(null, '', to);
  window.dispatchEvent(new Event('ssm:navigate'));
}

/**
 * Props for an internal link. Spread onto an <a>.
 *
 * Modified clicks are left to the browser: a ctrl-click meant for a new tab
 * must not be swallowed and turned into an in-page navigation.
 */
export function link(to: string) {
  return {
    href: to,
    onClick: (e: React.MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      navigate(to);
    },
  };
}

/** The batch id in /batch/<64 hex>, or null. */
export function batchIdFrom(path: string): string | null {
  const m = /^\/batch\/([0-9a-fA-F]{64})\/?$/.exec(path);
  return m ? m[1].toLowerCase() : null;
}
