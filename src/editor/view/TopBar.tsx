import type { ReactNode } from "react";
import { Link } from "react-router";
import { BrandMark } from "../../components/brand/BrandMark";
import { Icon, type IconName } from "../../components/ui/Icon";
import { BRAND } from "../../config/brand";
import { useSnapshot, useStore } from "../state/context";
import { Menu, type MenuTriggerProps } from "./Menu";

interface TopBarProps {
  onExport: () => void;
  onShortcuts: () => void;
  onClose: () => void;
  onFind: () => void;
  onOtherTool: () => void;
}

type IconButtonProps = { label: string; icon: IconName; pressed?: boolean; disabled?: boolean; testId?: string; children?: ReactNode } & Partial<MenuTriggerProps>;

/** An icon-only button. Used as a menu's trigger it takes the menu's props; as a toggle it reports whether it is pressed. */
function IconButton({ label, icon, onClick, pressed, disabled, testId, children, ...menu }: IconButtonProps) {
  const opensMenu = menu["aria-haspopup"] !== undefined;
  return (
    <button type="button" className={`ed-iconbtn${pressed ? " ed-iconbtn--on" : ""}`} aria-label={label} title={label} aria-pressed={opensMenu ? undefined : pressed} disabled={disabled} data-testid={testId} onClick={onClick} {...menu}>
      <Icon name={icon} size={18} />
      {children}
    </button>
  );
}

function formatTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** File name and whether there is anything not yet downloaded, undo and redo, the side panels and the download button. */
export function TopBar({ onExport, onShortcuts, onClose, onFind, onOtherTool }: TopBarProps) {
  const store = useStore();
  const { view, canUndo, canRedo, dirty, lastExport, name } = useSnapshot();
  const status = dirty ? "Unsaved changes" : lastExport ? `Downloaded at ${formatTime(lastExport)}` : "No changes yet";

  return (
    <header className="ed-topbar" data-testid="topbar">
      <Link to="/" className="ed-topbar__brand" aria-label={`${BRAND.name} home`} onClick={(event) => {
        if (dirty && !window.confirm("You have changes that have not been downloaded. Leave the editor and lose them?")) event.preventDefault();
      }}>
        <BrandMark width={26} height={26} />
      </Link>

      <div className="ed-topbar__file">
        <span className="ed-topbar__name" title={name} data-testid="file-name">
          {name}
        </span>
        <span className={`ed-status${dirty ? " ed-status--dirty" : ""}`} role="status" data-testid="save-status">
          <span className="ed-status__dot" aria-hidden="true" />
          {status}
        </span>
      </div>

      <div className="ed-topbar__group" role="group" aria-label="History">
        <IconButton label="Undo (Ctrl+Z)" icon="undo" onClick={store.undo} disabled={!canUndo} testId="undo" />
        <IconButton label="Redo (Ctrl+Shift+Z)" icon="redo" onClick={store.redo} disabled={!canRedo} testId="redo" />
        <HistoryMenu />
      </div>

      <div className="ed-topbar__spacer" />

      <div className="ed-topbar__group" role="group" aria-label="Panels">
        <IconButton label="Find text (Ctrl+F)" icon="search" onClick={onFind} testId="find" />
        <IconButton label="Pages panel" icon="panel-left" pressed={view.sidebar} onClick={() => store.setView({ sidebar: !view.sidebar })} testId="toggle-sidebar" />
        <IconButton label="Properties panel" icon="panel-right" pressed={view.panel} onClick={() => store.setView({ panel: !view.panel })} testId="toggle-panel" />
        <MoreMenu onShortcuts={onShortcuts} onClose={onClose} onOtherTool={onOtherTool} onFind={onFind} />
      </div>

      <button type="button" className="btn btn--primary ed-topbar__export" onClick={onExport} data-testid="download-as">
        <Icon name="download" size={18} />
        <span>Download as…</span>
      </button>
    </header>
  );
}

function HistoryMenu() {
  const store = useStore();
  const { steps } = useSnapshot();
  return (
    <Menu
      label="History of changes"
      role="dialog"
      className="ed-popover--history"
      testId="history-panel"
      trigger={(props, open) => <IconButton label="History of changes" icon="history" pressed={open} testId="history" {...props} />}
    >
      {({ close }) => (
        <>
          <p className="ed-popover__title">What you have done</p>
          <ol className="ed-popover__steps" data-testid="history-steps">
            {steps.map((step, index) => (
              <li key={index}>
                <button
                  type="button"
                  aria-current={step.current ? "step" : undefined}
                  className={`ed-popover__item${step.current ? " ed-popover__item--current" : ""}`}
                  onClick={() => {
                    store.jump(index);
                    close();
                  }}
                >
                  <span>{step.label}</span>
                  <time>{formatTime(step.at)}</time>
                </button>
              </li>
            ))}
          </ol>
        </>
      )}
    </Menu>
  );
}

function MoreMenu({ onShortcuts, onClose, onOtherTool, onFind }: { onShortcuts: () => void; onClose: () => void; onOtherTool: () => void; onFind: () => void }) {
  const { view } = useSnapshot();
  const store = useStore();
  return (
    <Menu label="More" align="end" testId="more-menu" trigger={(props, open) => <IconButton label="More" icon="more" pressed={open} testId="more" {...props} />}>
      {({ close }) => {
        const item = (label: string, icon: IconName, run: () => void, testId?: string) => (
          <button
            key={testId ?? label}
            type="button"
            role="menuitem"
            className="ed-popover__item"
            data-testid={testId}
            onClick={() => {
              close();
              run();
            }}
          >
            <Icon name={icon} size={16} /> {label}
          </button>
        );
        return (
          <>
            {item("Find text…", "search", onFind, "more-find")}
            {item(view.snap ? "Turn off snapping guides" : "Turn on snapping guides", "grid", () => store.setView({ snap: !view.snap }), "toggle-snap")}
            {item("Use another tool on this document…", "wrench", onOtherTool, "other-tool")}
            {item("Keyboard shortcuts", "keyboard", onShortcuts, "shortcuts")}
            {item("Close this document", "close", onClose, "close-doc")}
          </>
        );
      }}
    </Menu>
  );
}
