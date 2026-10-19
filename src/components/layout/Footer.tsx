import { Link } from "react-router";
import { BRAND } from "../../config/brand";
import { getTool } from "../../config/tools";
import { BrandMark } from "../brand/BrandMark";
import { ThemeSelect } from "./ThemeToggle";

const POPULAR = ["merge", "split", "compress", "jpg-to-pdf", "pdf-to-jpg", "protect"];
const MORE = ["organize", "rotate", "page-numbers", "watermark", "crop", "edit"];

export function Footer() {
  return (
    <footer className="site-footer">
      <div className="container">
        <div className="site-footer__grid">
          <div className="site-footer__brand">
            <Link to="/" className="brand" aria-label={`${BRAND.name} home`}>
              <BrandMark className="brand__mark" />
              <span>{BRAND.name}</span>
            </Link>
            <p className="site-footer__note">{BRAND.description}</p>
          </div>

          <nav aria-label="Popular tools">
            <h2>Popular tools</h2>
            <ul>
              {POPULAR.map((id) => {
                const tool = getTool(id);
                return tool ? (
                  <li key={id}>
                    <Link to={`/tools/${id}`}>{tool.name}</Link>
                  </li>
                ) : null;
              })}
            </ul>
          </nav>

          <nav aria-label="More tools">
            <h2>More tools</h2>
            <ul>
              {MORE.map((id) => {
                const tool = getTool(id);
                return tool ? (
                  <li key={id}>
                    <Link to={`/tools/${id}`}>{tool.name}</Link>
                  </li>
                ) : null;
              })}
              <li>
                <Link to="/tools">All tools</Link>
              </li>
            </ul>
          </nav>

          <nav aria-label="About">
            <h2>About</h2>
            <ul>
              <li>
                <Link to="/privacy">Privacy &amp; how it works</Link>
              </li>
              <li>
                <Link to="/self-hosting">Self-hosting</Link>
              </li>
              <li>
                <Link to="/about">About {BRAND.name}</Link>
              </li>
            </ul>
          </nav>
        </div>

        <div className="site-footer__bottom">
          <span>Free to use. No account needed. Most tools never upload your files.</span>
          <ThemeSelect />
        </div>
      </div>
    </footer>
  );
}
