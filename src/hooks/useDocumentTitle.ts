import { useEffect } from "react";
import { BRAND } from "../config/brand";

/** Sets the tab title (and the description meta tag) for the current page. */
export function useDocumentTitle(title?: string, description?: string): void {
  useEffect(() => {
    document.title = title ? `${title} – ${BRAND.name}` : `${BRAND.name} – free PDF tools that run in your browser`;
    if (description) {
      document.querySelector('meta[name="description"]')?.setAttribute("content", description);
    }
  }, [title, description]);
}
