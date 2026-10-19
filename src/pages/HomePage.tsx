import { useEffect, useRef } from "react";
import { Link } from "react-router";
import { HeroArt } from "../components/brand/BrandMark";
import { CategoryChips, SearchBox, ToolGrid, useCatalogState } from "../components/catalog/ToolCatalog";
import { Icon, type IconName } from "../components/ui/Icon";
import { BRAND } from "../config/brand";
import { TOOLS } from "../config/tools";
import { useDocumentTitle } from "../hooks/useDocumentTitle";

const PILLARS: { icon: IconName; title: string; text: string }[] = [
  {
    icon: "shield",
    title: "Your files stay with you",
    text: "Merging, splitting, compressing, editing and protecting all run inside your browser tab. The documents are not uploaded anywhere.",
  },
  {
    icon: "bolt",
    title: "Fast, and free for real",
    text: "No sign-up, no watermarks, no daily limits. Processing uses your own device, so there is no queue to wait in.",
  },
  {
    icon: "eye",
    title: "Check it yourself",
    text: "Open your browser's network panel while you use a tool: your documents are not sent anywhere, and most tools keep working if you go offline after the page has loaded.",
  },
  {
    icon: "check",
    title: "Results you can trust",
    text: "Every output is re-opened and checked before you can download it. If something fails, you get a clear message instead of a broken file.",
  },
];

const FAQ: { q: string; a: string }[] = [
  {
    q: "Is it really free?",
    a: "Yes. There are no accounts, subscriptions or paywalls. The only limits are your device's memory and, for the optional server tools, whatever the person running the server configures.",
  },
  {
    q: "Are my files uploaded?",
    a: "Not for most tools. Merge, split, organize, rotate, compress, JPG ⇄ PDF, page numbers, watermark, crop, edit, protect, unlock, repair and metadata all run in your browser. The exceptions are Word, Excel and PowerPoint to PDF, and the optional server modes of a few converters: they need LibreOffice, which runs on the server. Those tools say so before you start, send the file once, and the server deletes it as soon as the conversion ends.",
  },
  {
    q: "How big can a file be?",
    a: "Browser tools are limited by your device's memory; ordinary PDFs of a few hundred megabytes usually work. Server conversions are limited by the server (50 MB by default). Oversized files are refused with a clear message before anything is sent.",
  },
  {
    q: "Can it remove a password I don't know?",
    a: "No. Unlock PDF needs the password you already have. It does not guess, crack or bypass passwords.",
  },
  {
    q: "Which browsers are supported?",
    a: "Current versions of Chrome, Edge, Firefox and Safari (16.4 or newer). The tools use WebAssembly and Web Workers, which all of them provide.",
  },
  {
    q: "Can I run it myself?",
    a: "Yes. It is a standard Node.js project with an optional Docker image. See the self-hosting guide.",
  },
];

export default function HomePage() {
  useDocumentTitle();
  const catalog = useCatalogState();
  const searchRef = useRef<HTMLDivElement>(null);

  // "/" jumps to the search box, like on most documentation sites.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (event.key === "/" && !typing && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        searchRef.current?.querySelector("input")?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <section className="hero" aria-labelledby="hero-title">
        <HeroArt className="hero__art" />
        <div className="container hero__inner">
          <p className="hero__eyebrow">
            <Icon name="shield" size={18} />
            Free · No sign-up · Files stay on your device
          </p>
          <h1 className="hero__title" id="hero-title">
            Every PDF tool you need. <em>Nothing leaves your device.</em>
          </h1>
          <p className="hero__lead">
            {TOOLS.length} tools to merge, split, compress, convert, edit and protect PDFs, working right in your browser.
          </p>
          <div ref={searchRef}>
            <SearchBox value={catalog.query} onChange={catalog.setQuery} inputId="hero-search" />
          </div>
        </div>
      </section>

      <section className="section" id="tools" aria-labelledby="tools-title" style={{ paddingTop: "var(--space-4)" }}>
        <div className="container">
          <div className="catalog__controls">
            <h2 className="sr-only" id="tools-title">
              All PDF tools
            </h2>
            <CategoryChips value={catalog.category} onChange={catalog.setCategory} />
            <p className="muted" role="status" aria-live="polite" style={{ fontSize: "var(--text-sm)" }}>
              {catalog.filtered ? `${catalog.results.length} ${catalog.results.length === 1 ? "tool" : "tools"} found` : `${TOOLS.length} tools`}
            </p>
          </div>
          <ToolGrid tools={catalog.results} grouped={!catalog.filtered} onClear={catalog.clear} query={catalog.query} />
        </div>
      </section>

      <section className="section section--alt" aria-labelledby="how-title">
        <div className="container">
          <div className="section__head">
            <h2 className="section__title" id="how-title">
              Three steps, every time
            </h2>
            <p className="section__lead">Every tool works the same way, so you only have to learn it once.</p>
          </div>
          <ol className="steps" role="list">
            <li className="step">
              <h3>Add your files</h3>
              <p>Drop them on the page or choose them from your device. Files are checked right away, so problems show up early.</p>
            </li>
            <li className="step">
              <h3>Set your options</h3>
              <p>Pick page ranges, a quality level, a password, a position. Previews show what you are about to get.</p>
            </li>
            <li className="step">
              <h3>Download the result</h3>
              <p>Preview it, then download. You also see the real file sizes and page counts, never a guess.</p>
            </li>
          </ol>
        </div>
      </section>

      <section className="section" aria-labelledby="privacy-title">
        <div className="container">
          <div className="section__head">
            <h2 className="section__title" id="privacy-title">
              Built to be trusted with documents
            </h2>
            <p className="section__lead">
              PDFs are often contracts, invoices and IDs. {BRAND.name} is designed so that you do not have to hand them over.{" "}
              <Link to="/privacy">How it works</Link>
            </p>
          </div>
          <div className="pillars">
            {PILLARS.map((pillar) => (
              <div className="pillar" key={pillar.title}>
                <span className="pillar__icon">
                  <Icon name={pillar.icon} size={22} />
                </span>
                <h3>{pillar.title}</h3>
                <p>{pillar.text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="section section--alt" aria-labelledby="faq-title">
        <div className="container" style={{ maxWidth: "52rem" }}>
          <div className="section__head">
            <h2 className="section__title" id="faq-title">
              Questions
            </h2>
          </div>
          <div className="faq">
            {FAQ.map((item) => (
              <details key={item.q}>
                <summary>{item.q}</summary>
                <p>{item.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
