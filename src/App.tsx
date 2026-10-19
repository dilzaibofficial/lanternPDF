import { Suspense, lazy } from "react";
import { BrowserRouter, Route, Routes } from "react-router";
import { AppShell } from "./components/layout/AppShell";
import { CapabilitiesProvider } from "./hooks/useCapabilities";
import { HandoffProvider } from "./hooks/useHandoff";
import { ThemeProvider } from "./hooks/useTheme";
import AboutPage from "./pages/AboutPage";
import HomePage from "./pages/HomePage";
import NotFoundPage from "./pages/NotFoundPage";
import PrivacyPage from "./pages/PrivacyPage";
import SelfHostingPage from "./pages/SelfHostingPage";
import ToolPage from "./pages/ToolPage";
import ToolsPage from "./pages/ToolsPage";

// The editor is large (pdf.js, the text engine, the editing UI): it is only downloaded by people who open it.
const EditorPage = lazy(() => import("./editor/EditorPage"));

export default function App() {
  return (
    <ThemeProvider>
      <CapabilitiesProvider>
        <HandoffProvider>
          <BrowserRouter>
            <Routes>
              <Route
                path="editor"
                element={
                  <Suspense
                    fallback={
                      <div className="viewer__loading" role="status" style={{ minHeight: "100dvh" }}>
                        <span className="spinner" aria-hidden="true" /> Loading the editor…
                      </div>
                    }
                  >
                    <EditorPage />
                  </Suspense>
                }
              />
              <Route element={<AppShell />}>
                <Route index element={<HomePage />} />
                <Route path="tools" element={<ToolsPage />} />
                <Route path="tools/:toolId" element={<ToolPage />} />
                <Route path="privacy" element={<PrivacyPage />} />
                <Route path="about" element={<AboutPage />} />
                <Route path="self-hosting" element={<SelfHostingPage />} />
                <Route path="*" element={<NotFoundPage />} />
              </Route>
            </Routes>
          </BrowserRouter>
        </HandoffProvider>
      </CapabilitiesProvider>
    </ThemeProvider>
  );
}
