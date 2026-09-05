import type { FC } from "hono/jsx";
import { STRATUM_SOURCE_URL, STRATUM_VERSION } from "../../version";

/**
 * The AGPL-3.0 §13 source offer, rendered in the chrome of every page.
 *
 * §13 asks an operator running a *modified* Stratum to prominently offer that
 * version's Corresponding Source to everyone who interacts with the instance
 * over the network. "Everyone" includes a visitor who never signs in, so this
 * belongs on the standalone auth and OAuth-consent documents as much as on the
 * shared `Layout` — those pages are the only Stratum an anonymous visitor may
 * ever see. It is a component rather than markup copied five times so that the
 * offer cannot quietly survive in four places and disappear from the fifth.
 *
 * Styling comes from `.site-footer` in the shared stylesheet, which every
 * document carrying this links.
 */
export const SourceFooter: FC = () => (
  <footer class="site-footer">
    <span>stratum v{STRATUM_VERSION}</span>
    <span class="site-footer-sep">·</span>
    <a
      href="https://www.gnu.org/licenses/agpl-3.0.html"
      target="_blank"
      rel="license noopener noreferrer"
    >
      AGPL-3.0
    </a>
    <span class="site-footer-sep">·</span>
    <a href={STRATUM_SOURCE_URL} target="_blank" rel="noopener noreferrer">
      source
    </a>
  </footer>
);
