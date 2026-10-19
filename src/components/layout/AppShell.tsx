import { useEffect, useRef } from "react";
import { Outlet, useLocation } from "react-router";
import { Footer } from "./Footer";
import { Header } from "./Header";

/** Header + page + footer, plus keyboard/screen-reader handling when the route changes. */
export function AppShell() {
  const { pathname } = useLocation();
  const main = useRef<HTMLElement>(null);
  const first = useRef(true);

  useEffect(() => {
    // Do not steal focus on the very first load; do move it to the new page afterwards.
    if (first.current) {
      first.current = false;
      return;
    }
    window.scrollTo({ top: 0 });
    main.current?.focus({ preventScroll: true });
  }, [pathname]);

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <Header />
      <main id="main" ref={main} tabIndex={-1} style={{ outline: "none" }}>
        <Outlet />
      </main>
      <Footer />
    </>
  );
}
