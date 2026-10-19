import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { BrandMark } from "../components/brand/BrandMark";
import { Dropzone } from "../components/files/Dropzone";
import { Alert, ErrorAlert } from "../components/ui/Alerts";
import { Checkbox, Field, PasswordInput } from "../components/ui/Field";
import { Icon } from "../components/ui/Icon";
import { BRAND } from "../config/brand";
import { LIMITS } from "../config/limits";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useHandoff } from "../hooks/useHandoff";
import { type AppError, toAppError } from "../lib/errors";
import { type Rejection, checkFiles, contentProblem } from "../lib/files";
import { formatBytes } from "../lib/format";
import "./editor.css";
import { EditorProvider } from "./state/context";
import { EditorStore } from "./state/store";
import { Shell } from "./view/Shell";

type Phase =
  | { phase: "empty"; rejections: Rejection[] }
  | { phase: "opening"; name: string }
  | { phase: "password"; name: string; bytes: Uint8Array; wrong: boolean }
  | { phase: "error"; error: AppError }
  | { phase: "ready" };

/** Warn before opening something big enough to strain a browser tab. */
const HEAVY_BYTES = 80 * 1024 * 1024;

/**
 * The editor's page. Without a document it asks for one (or takes one handed over from another tool); with one it
 * is the whole screen. The document is opened once and everything else happens inside it.
 */
export default function EditorPage() {
  useDocumentTitle("PDF editor", "Edit the text of a PDF, add images, shapes and notes, redact, fill forms and organize pages: all on your device.");
  const navigate = useNavigate();
  const { take } = useHandoff();
  const [state, setState] = useState<Phase>({ phase: "empty", rejections: [] });
  const [store, setStore] = useState<EditorStore | null>(null);
  // The person said they may open this file; a wrong password does not take that back.
  const [authorized, setAuthorized] = useState(false);
  const storeRef = useRef<EditorStore | null>(null);
  const handoffTaken = useRef(false);

  const release = useCallback(() => {
    storeRef.current?.dispose();
    storeRef.current = null;
    setStore(null);
  }, []);

  // Memory is handed back when the page is left.
  useEffect(() => () => storeRef.current?.dispose(), []);

  const open = useCallback(
    async (name: string, bytes: Uint8Array, password?: string) => {
      setState({ phase: "opening", name });
      const next = new EditorStore();
      try {
        await next.openFirst(name, bytes, password);
        storeRef.current?.dispose();
        storeRef.current = next;
        setStore(next);
        setState({ phase: "ready" });
      } catch (error) {
        next.dispose();
        const app = toAppError(error);
        if (app.code === "PASSWORD_REQUIRED" || app.code === "WRONG_PASSWORD") setState({ phase: "password", name, bytes, wrong: app.code === "WRONG_PASSWORD" });
        else setState({ phase: "error", error: app });
      }
    },
    [],
  );

  const chooseFile = async (files: File[]) => {
    const { accepted, rejected } = checkFiles(files, { extensions: [".pdf"], maxBytes: LIMITS.maxFileBytes, maxFiles: 1, existing: 0, label: "a PDF file" });
    const file = accepted[0];
    if (!file) {
      setState({ phase: "empty", rejections: rejected });
      return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const problem = contentProblem(file.name, bytes);
    if (problem) {
      setState({ phase: "empty", rejections: [{ name: file.name, reason: problem }] });
      return;
    }
    await open(file.name, bytes);
  };

  // A file left by another tool ("Continue with…") opens straight away.
  useEffect(() => {
    if (handoffTaken.current) return;
    handoffTaken.current = true;
    const file = take();
    if (file) void open(file.name, file.bytes);
  }, [take, open]);

  const close = () => {
    const store = storeRef.current;
    if (store?.state.dirty && !window.confirm("You have changes that have not been downloaded. Close the document and lose them?")) return;
    release();
    setState({ phase: "empty", rejections: [] });
  };

  if (state.phase === "ready" && store) {
    return (
      <EditorProvider store={store}>
        <Shell onClose={close} />
      </EditorProvider>
    );
  }

  return (
    <div className="ed-open" data-testid="editor-open">
      <header className="ed-open__bar">
        <Link to="/" className="ed-open__brand">
          <BrandMark width={28} height={28} />
          <span>{BRAND.name}</span>
        </Link>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => navigate("/tools")}>
          All tools
        </button>
      </header>
      <main className="ed-open__main">
        <div className="ed-open__card">
          <h1>PDF editor</h1>
          <p className="ed-open__lead">Open a PDF once, then change its text, add images, shapes and notes, redact, fill forms and organize pages. Everything runs on your device.</p>

          {state.phase === "opening" && (
            <div className="process" role="status" data-testid="opening">
              <span className="spinner" style={{ width: "2.2rem", height: "2.2rem", color: "var(--primary)" }} aria-hidden="true" />
              <p>Opening “{state.name}”…</p>
            </div>
          )}

          {state.phase === "password" && (
            <PasswordForm
              name={state.name}
              wrong={state.wrong}
              authorized={authorized}
              onAuthorized={setAuthorized}
              onSubmit={(password) => open(state.name, state.bytes, password)}
              onCancel={() => {
                setAuthorized(false);
                setState({ phase: "empty", rejections: [] });
              }}
            />
          )}

          {state.phase === "error" && (
            <div className="stack">
              <ErrorAlert error={state.error} onDismiss={() => setState({ phase: "empty", rejections: [] })} />
            </div>
          )}

          {(state.phase === "empty" || state.phase === "error") && (
            <Dropzone
              extensions={[".pdf"]}
              multiple={false}
              pickLabel="a PDF"
              onFiles={(files) => void chooseFile(files)}
              rejections={state.phase === "empty" ? state.rejections : []}
              onDismissRejections={() => setState({ phase: "empty", rejections: [] })}
              note={
                <>
                  <Icon name="shield" size={16} /> Your file stays in this browser tab. It is never uploaded, and your original is never changed: you download a new copy.
                </>
              }
            />
          )}

          {state.phase === "empty" && (
            <ul className="ed-open__points">
              <li>
                <strong>Edit text in place:</strong> click a line and type. It is rewritten inside the page, not covered with a box.
              </li>
              <li>
                <strong>No limits, no sign-up:</strong> there are no accounts, counters or paywalls, and nothing is added to your pages.
              </li>
              <li>
                <strong>Honest about limits:</strong> text in scans or as drawings cannot be edited; you are told why and offered alternatives. Files over {formatBytes(HEAVY_BYTES)} may be slow on small devices.
              </li>
            </ul>
          )}
        </div>
      </main>
    </div>
  );
}

function PasswordForm({ name, wrong, authorized, onAuthorized, onSubmit, onCancel }: { name: string; wrong: boolean; authorized: boolean; onAuthorized: (value: boolean) => void; onSubmit: (password: string) => void; onCancel: () => void }) {
  const [password, setPassword] = useState("");
  return (
    <div className="stack" data-testid="password-form">
      <Alert tone="info" title={`“${name}” is password-protected`}>
        <p>Enter its password to open it. The password stays in this tab and is never stored or sent anywhere. Changes are saved to a new copy without the password unless you add one later.</p>
      </Alert>
      <Field label="Password" error={wrong ? "That password is not correct." : null}>
        {({ id, describedBy, invalid }) => <PasswordInput id={id} value={password} onChange={setPassword} describedBy={describedBy} invalid={invalid} autoFocus onEnter={() => authorized && password && onSubmit(password)} />}
      </Field>
      <Checkbox checked={authorized} onChange={onAuthorized} label="I own this file or have permission to open and edit it" hint="This editor cannot guess or bypass a password; it only opens files you can already open." />
      <div className="ed-dialog__actions">
        <button type="button" className="btn btn--secondary" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn btn--primary" disabled={!authorized || password === ""} onClick={() => onSubmit(password)} data-testid="open-protected">
          Open
        </button>
      </div>
    </div>
  );
}
