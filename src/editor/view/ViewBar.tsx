import { Icon } from "../../components/ui/Icon";
import { MAX_ZOOM, MIN_ZOOM, ZOOM_STEPS, stepZoom } from "../model/geometry";
import { useSnapshot, useStore } from "../state/context";
import { Menu } from "./Menu";

/** Which page you are on, how big it is shown and how pages are laid out: a small bar floating at the bottom of the page area. */
export function ViewBar() {
  const store = useStore();
  const { doc, view } = useSnapshot();
  const pages = doc.pages;
  const index = Math.max(
    0,
    pages.findIndex((p) => p.id === view.currentPage),
  );

  const goTo = (n: number) => {
    const target = pages[Math.min(pages.length, Math.max(1, n)) - 1];
    if (target) store.setView({ currentPage: target.id, selectedPages: [target.id] });
  };

  return (
    <div className="ed-viewbar" role="toolbar" aria-label="Page and zoom" data-testid="viewbar">
      <div className="ed-viewbar__group" role="group" aria-label="Pages">
        <button type="button" className="ed-iconbtn" aria-label="Previous page" title="Previous page" disabled={index <= 0} data-testid="page-prev" onClick={() => goTo(index)}>
          <Icon name="chevron-up" size={18} />
        </button>
        <label className="ed-pagebox">
          <span className="sr-only">Go to page</span>
          <input className="input" type="number" min={1} max={pages.length} value={index + 1} data-testid="page-input" onKeyDown={(event) => event.stopPropagation()} onChange={(event) => goTo(Number(event.target.value) || 1)} />
          <span aria-hidden="true">of {pages.length}</span>
        </label>
        <button type="button" className="ed-iconbtn" aria-label="Next page" title="Next page" disabled={index >= pages.length - 1} data-testid="page-next" onClick={() => goTo(index + 2)}>
          <Icon name="chevron-down" size={18} />
        </button>
        <button
          type="button"
          className={`ed-iconbtn${view.viewMode === "single" ? " ed-iconbtn--on" : ""}`}
          aria-label={view.viewMode === "single" ? "Show all pages in a column" : "Show one page at a time"}
          title={view.viewMode === "single" ? "Show all pages in a column" : "Show one page at a time"}
          aria-pressed={view.viewMode === "single"}
          data-testid="view-mode"
          onClick={() => store.setView({ viewMode: view.viewMode === "single" ? "continuous" : "single" })}
        >
          <Icon name={view.viewMode === "single" ? "page-scroll" : "page-single"} size={18} />
        </button>
      </div>

      <span className="ed-viewbar__divider" aria-hidden="true" />

      <div className="ed-viewbar__group" role="group" aria-label="Zoom">
        <button type="button" className="ed-iconbtn" aria-label="Zoom out" title="Zoom out (Ctrl+−)" disabled={view.zoom <= MIN_ZOOM + 1e-6} data-testid="zoom-out" onClick={() => store.setZoom(stepZoom(view.zoom, -1))}>
          <Icon name="zoom-out" size={18} />
        </button>
        <Menu
          label="Zoom level"
          testId="zoom-menu"
          trigger={(props) => (
            <button type="button" className="ed-zoomvalue" data-testid="zoom-level" title="Choose a zoom level" {...props}>
              {Math.round(view.zoom * 100)}%
            </button>
          )}
        >
          {({ close }) =>
            ZOOM_STEPS.map((step) => (
              <button
                key={step}
                type="button"
                role="menuitemradio"
                aria-checked={Math.abs(view.zoom - step) < 0.005}
                className="ed-popover__item"
                onClick={() => {
                  store.setZoom(step);
                  close();
                }}
              >
                {Math.round(step * 100)}%
              </button>
            ))
          }
        </Menu>
        <button type="button" className="ed-iconbtn" aria-label="Zoom in" title="Zoom in (Ctrl++)" disabled={view.zoom >= MAX_ZOOM - 1e-6} data-testid="zoom-in" onClick={() => store.setZoom(stepZoom(view.zoom, 1))}>
          <Icon name="zoom-in" size={18} />
        </button>
        <button type="button" className={`ed-iconbtn${view.zoomMode === "fit-width" ? " ed-iconbtn--on" : ""}`} aria-label="Fit the page width" title="Fit the page width (Ctrl+9)" aria-pressed={view.zoomMode === "fit-width"} data-testid="zoom-fit-width" onClick={() => store.setZoom(view.zoom, "fit-width")}>
          <Icon name="fit-width" size={18} />
        </button>
        <button type="button" className={`ed-iconbtn${view.zoomMode === "fit-page" ? " ed-iconbtn--on" : ""}`} aria-label="Fit the whole page" title="Fit the whole page (Ctrl+0)" aria-pressed={view.zoomMode === "fit-page"} data-testid="zoom-fit-page" onClick={() => store.setZoom(view.zoom, "fit-page")}>
          <Icon name="fit-page" size={18} />
        </button>
      </div>
    </div>
  );
}
