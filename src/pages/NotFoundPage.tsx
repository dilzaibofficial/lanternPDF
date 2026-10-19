import { Link } from "react-router";
import { useDocumentTitle } from "../hooks/useDocumentTitle";

export default function NotFoundPage() {
  useDocumentTitle("Page not found");
  return (
    <div className="container">
      <div className="page-head" style={{ paddingBlock: "var(--space-16)" }}>
        <h1>That page does not exist</h1>
        <p>The link may be old or mistyped. You can search every tool from the home page.</p>
        <p style={{ marginTop: "var(--space-5)" }}>
          <Link to="/" className="btn btn--primary">
            Back to all tools
          </Link>
        </p>
      </div>
    </div>
  );
}
