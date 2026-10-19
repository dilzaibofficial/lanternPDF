import { useEffect, useRef, useState } from "react";
import { Link, NavLink, useLocation } from "react-router";
import { BRAND } from "../../config/brand";
import { CATEGORIES, toolsInCategory } from "../../config/tools";
import { useDismiss } from "../../hooks/useDismiss";
import { BrandMark } from "../brand/BrandMark";
import { Icon } from "../ui/Icon";
import { CommandPalette } from "./CommandPalette";
import { ThemeToggle } from "./ThemeToggle";

const isMac = typeof navigator !== "undefined" && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);

export function Header() {
  const [megaOpen, setMegaOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const location = useLocation();
  const megaButton = useRef<HTMLButtonElement>(null);
  const megaPanel = useRef<HTMLDivElement>(null);

  // Close menus whenever the page changes.
  useEffect(() => {
    setMegaOpen(false);
    setMobileOpen(false);
  }, [location.pathname]);

  useDismiss([megaButton, megaPanel], megaOpen, () => setMegaOpen(false));

  // Ctrl/⌘+K opens the palette from anywhere.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Lock page scroll behind the mobile menu.
  useEffect(() => {
    document.body.style.overflow = mobileOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [mobileOpen]);

  return (
    <header className="site-header">
      <div className="container site-header__inner">
        <Link to="/" className="brand" aria-label={`${BRAND.name} home`}>
          <BrandMark className="brand__mark" />
          <span>{BRAND.name}</span>
        </Link>

        <nav className="site-nav" aria-label="Main">
          <NavLink to="/tools/merge" className="site-nav__link">
            Merge
          </NavLink>
          <NavLink to="/tools/split" className="site-nav__link">
            Split
          </NavLink>
          <NavLink to="/tools/compress" className="site-nav__link">
            Compress
          </NavLink>
          <button
            ref={megaButton}
            type="button"
            className="site-nav__link"
            aria-expanded={megaOpen}
            aria-controls="mega-menu"
            onClick={() => setMegaOpen((open) => !open)}
          >
            All tools
            <Icon name="chevron-down" size={16} />
          </button>
        </nav>

        <div className="site-header__actions">
          <button type="button" className="search-trigger" onClick={() => setPaletteOpen(true)} aria-label="Search tools">
            <Icon name="search" size={18} />
            <span>Search tools</span>
            <kbd>{isMac ? "⌘" : "Ctrl"} K</kbd>
          </button>
          <ThemeToggle />
          <button
            type="button"
            className="btn btn--ghost btn--icon menu-toggle"
            aria-expanded={mobileOpen}
            aria-controls="mobile-nav"
            aria-label={mobileOpen ? "Close menu" : "Open menu"}
            onClick={() => setMobileOpen((open) => !open)}
          >
            <Icon name={mobileOpen ? "close" : "menu"} />
          </button>
        </div>
      </div>

      {megaOpen && (
        <div className="mega" id="mega-menu">
          <div className="container">
            <div className="mega__panel" ref={megaPanel}>
              {CATEGORIES.map((category) => (
                <section key={category.id} data-cat={category.id} aria-labelledby={`mega-${category.id}`}>
                  <h2 className="mega__group-title" id={`mega-${category.id}`}>
                    {category.name}
                  </h2>
                  <ul role="list" style={{ margin: 0, padding: 0 }}>
                    {toolsInCategory(category.id).map((tool) => (
                      <li key={tool.id}>
                        <Link to={`/tools/${tool.id}`} className="mega__link">
                          <Icon name={tool.icon} size={18} />
                          {tool.name}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          </div>
        </div>
      )}

      {mobileOpen && (
        <nav id="mobile-nav" className="mobile-nav" aria-label="All tools">
          {CATEGORIES.map((category) => (
            <section key={category.id} className="mobile-nav__group" data-cat={category.id}>
              <h2 className="mobile-nav__title">{category.name}</h2>
              {toolsInCategory(category.id).map((tool) => (
                <Link key={tool.id} to={`/tools/${tool.id}`} className="mobile-nav__link">
                  <Icon name={tool.icon} size={20} />
                  {tool.name}
                </Link>
              ))}
            </section>
          ))}
        </nav>
      )}

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </header>
  );
}
