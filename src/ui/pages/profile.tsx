import type { FC } from "hono/jsx";
import type { InviteCodeStatus, InviteCodesResult } from "../../beta/gate";
import { Layout } from "../layout";

interface ProfileUser {
  id: string;
  email: string;
  username: string;
  createdAt: string;
  githubUsername?: string;
}

interface ProfilePageProps {
  user: ProfileUser;
  /**
   * Absent when no referral service is configured (every self-hosted instance,
   * and any deployment that never ran the closed beta) — the invite section is
   * then not rendered at all rather than rendered empty.
   */
  invites?: InviteCodesResult;
  /** Origin for share links, e.g. https://referral.usestratum.dev. */
  shareBaseUrl?: string;
  /** Per-request CSP nonce for the copy-button script. */
  nonce?: string;
}

function formatDate(iso: string): string {
  const parsed = new Date(iso);
  // Show the raw value rather than "Invalid Date": it is at least evidence of
  // what is stored. Same rule as the settings page.
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleDateString();
}

function shareLink(base: string | undefined, code: string): string | null {
  if (!base) return null;
  return `${base.replace(/\/$/, "")}/?ref=${encodeURIComponent(code)}`;
}

/**
 * Copies the text of the element named by `data-copy-target`. One delegated
 * listener rather than a script per row, and the value is read out of the DOM
 * instead of being interpolated into JS — a code must never reach a script
 * body, where escaping it correctly is a fresh chance to get it wrong.
 */
const COPY_CODE_SCRIPT = `
(function () {
  var buttons = document.querySelectorAll('[data-copy-target]');
  Array.prototype.forEach.call(buttons, function (btn) {
    var target = document.getElementById(btn.getAttribute('data-copy-target'));
    if (!target) return;
    var label = btn.textContent;
    btn.addEventListener('click', function () {
      // Clipboard API can be missing (insecure context) or blocked by policy;
      // fall back to selecting the value so a manual Ctrl/Cmd+C still works.
      var fallback = function () {
        var range = document.createRange();
        range.selectNodeContents(target);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        btn.textContent = 'Ctrl/Cmd+C';
        setTimeout(function () { btn.textContent = label; }, 3000);
      };
      if (!navigator.clipboard || !navigator.clipboard.writeText) {
        fallback();
        return;
      }
      navigator.clipboard.writeText(target.textContent).then(function () {
        btn.textContent = 'Copied';
        setTimeout(function () { btn.textContent = label; }, 2000);
      }, fallback);
    });
  });
})();
`;

const InviteCodeRow: FC<{ entry: InviteCodeStatus; index: number; shareBaseUrl?: string }> = ({
  entry,
  index,
  shareBaseUrl,
}) => {
  const redeemed = entry.redeemedAt !== null;
  const link = shareLink(shareBaseUrl, entry.code);
  // The id only has to be unique within the page; the code itself is not used,
  // so a code containing characters illegal in an id cannot break the wiring.
  const linkId = `invite-link-${index}`;
  const codeId = `invite-code-${index}`;
  return (
    <tr>
      <td>
        <code class="mono" id={codeId}>
          {entry.code}
        </code>
      </td>
      <td>
        {link === null ? (
          <span class="text-muted">—</span>
        ) : (
          <code class="mono invite-share-link" id={linkId}>
            {link}
          </code>
        )}
      </td>
      <td>
        {redeemed ? (
          <span class="badge badge-merged">
            Redeemed {entry.redeemedAt === null ? "" : formatDate(entry.redeemedAt)}
            {entry.redeemedBy === null ? "" : ` by ${entry.redeemedBy}`}
          </span>
        ) : (
          <span class="badge badge-open">Available</span>
        )}
      </td>
      <td>
        {redeemed ? (
          <span class="text-muted">—</span>
        ) : (
          <button
            type="button"
            class="btn btn-small"
            data-copy-target={link === null ? codeId : linkId}
          >
            Copy
          </button>
        )}
      </td>
    </tr>
  );
};

const InviteCodesCard: FC<{
  invites: InviteCodesResult;
  shareBaseUrl?: string;
  nonce?: string;
}> = ({ invites, shareBaseUrl, nonce }) => {
  const codes = invites.status === "ok" ? invites.codes : [];
  const available = codes.filter((entry) => entry.redeemedAt === null).length;
  return (
    <div class="card">
      <h3 style={{ marginTop: 0 }}>Invite codes</h3>
      {invites.status === "unavailable" ? (
        <p class="settings-help" style={{ color: "#f87171" }}>
          Your invite codes could not be loaded right now. This is a temporary problem reaching the
          invite service — your codes have not been lost. Try again shortly.
        </p>
      ) : codes.length === 0 ? (
        <p class="settings-help">
          You have no invite codes. Codes are issued when you join through the closed beta; if you
          signed up while signups were open, there is nothing to share here.
        </p>
      ) : (
        <>
          <p class="settings-help">
            Each code lets one person create an account. Send someone the share link and their code
            is filled in for them at signup. {available} of {codes.length}{" "}
            {codes.length === 1 ? "code is" : "codes are"} still available.
          </p>
          <div class="table-scroll">
            <table class="table">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Share link</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {codes.map((entry, index) => (
                  <InviteCodeRow
                    key={entry.code}
                    entry={entry}
                    index={index}
                    {...(shareBaseUrl !== undefined ? { shareBaseUrl } : {})}
                  />
                ))}
              </tbody>
            </table>
          </div>
          {nonce !== undefined && (
            <script nonce={nonce} dangerouslySetInnerHTML={{ __html: COPY_CODE_SCRIPT }} />
          )}
        </>
      )}
    </div>
  );
};

export const ProfilePage: FC<ProfilePageProps> = ({ user, invites, shareBaseUrl, nonce }) => (
  <Layout title="Profile" user={user}>
    <div class="page-header">
      <h1>Profile</h1>
    </div>

    <div class="card">
      <h3 style={{ marginTop: 0 }}>Account</h3>
      <dl class="detail-list">
        <dt>Username</dt>
        <dd>@{user.username}</dd>
        <dt>Email</dt>
        <dd>{user.email}</dd>
        <dt>Member since</dt>
        <dd>{formatDate(user.createdAt)}</dd>
        {user.githubUsername !== undefined && (
          <>
            <dt>GitHub</dt>
            <dd>
              <a href={`https://github.com/${user.githubUsername}`}>@{user.githubUsername}</a>
            </dd>
          </>
        )}
      </dl>
      <p class="settings-help">
        Credentials, API tokens, and privacy live in <a href="/settings">settings</a>.
      </p>
    </div>

    {invites !== undefined && (
      <InviteCodesCard
        invites={invites}
        {...(shareBaseUrl !== undefined ? { shareBaseUrl } : {})}
        {...(nonce !== undefined ? { nonce } : {})}
      />
    )}
  </Layout>
);
