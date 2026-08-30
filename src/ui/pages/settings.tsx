import type { FC } from "hono/jsx";
import { Layout } from "../layout";

interface AgentSummary {
  id: string;
  name: string;
  model?: string;
  createdAt: string;
}

interface SettingsPageProps {
  user: { id: string; email: string; username: string };
  agents: AgentSummary[];
  /** Freshly created credential, shown exactly once after a rotate/create POST. */
  freshToken?: { kind: "api-key" | "agent"; value: string; agentName?: string };
  /** Per-request CSP nonce for the copy-button script (only rendered with a fresh token). */
  nonce?: string;
  /** True when the user has opted out of product analytics (#257). */
  telemetryOptOut: boolean;
}

/** Clipboard needs script; the value is read from the DOM, never re-serialized. */
const COPY_TOKEN_SCRIPT = `
(function () {
  var btn = document.getElementById('copy-fresh-token');
  var token = document.getElementById('fresh-token');
  if (!btn || !token) return;
  btn.addEventListener('click', function () {
    // Clipboard API can be missing (insecure context) or blocked by policy;
    // fall back to selecting the value so a manual Ctrl/Cmd+C still works.
    var fallback = function () {
      var range = document.createRange();
      range.selectNodeContents(token);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      btn.textContent = 'Press Ctrl/Cmd+C';
      setTimeout(function () { btn.textContent = 'Copy'; }, 3000);
    };
    if (!navigator.clipboard || !navigator.clipboard.writeText) {
      fallback();
      return;
    }
    navigator.clipboard.writeText(token.textContent).then(function () {
      btn.textContent = 'Copied';
      setTimeout(function () { btn.textContent = 'Copy'; }, 2000);
    }, fallback);
  });
})();
`;

export const SettingsPage: FC<SettingsPageProps> = ({
  user,
  agents,
  freshToken,
  nonce,
  telemetryOptOut,
}) => {
  return (
    <Layout title="Settings" user={user}>
      <div class="page-header">
        <h1>Settings</h1>
      </div>

      {freshToken && (
        <div class="card settings-token-reveal">
          <h3 style={{ marginTop: 0 }}>
            {freshToken.kind === "api-key"
              ? "Your new API key"
              : `Token for agent ${freshToken.agentName ?? ""}`}
          </h3>
          <p class="settings-help">
            Copy it now — it is shown only once.{" "}
            {freshToken.kind === "api-key" ? "Your previous key no longer works." : ""}
          </p>
          <div class="token-reveal-row">
            <code class="settings-token" id="fresh-token">
              {freshToken.value}
            </code>
            <button type="button" class="btn btn-small" id="copy-fresh-token">
              Copy
            </button>
          </div>
          {nonce !== undefined && (
            <script nonce={nonce} dangerouslySetInnerHTML={{ __html: COPY_TOKEN_SCRIPT }} />
          )}
        </div>
      )}

      <div class="card">
        <h3 style={{ marginTop: 0 }}>Account</h3>
        <dl class="detail-list">
          <dt>Username</dt>
          <dd>@{user.username}</dd>
          <dt>Email</dt>
          <dd>{user.email}</dd>
        </dl>
      </div>

      <div class="card">
        <h3 style={{ marginTop: 0 }}>Privacy</h3>
        <p class="settings-help">
          Stratum can send anonymous usage analytics. Two kinds of event are sent, and only these:
        </p>
        <ul class="settings-help">
          <li>
            One <code>api_request</code> per request, carrying the matched route pattern (e.g.{" "}
            <code>/:namespace/:slug/files</code>), the method, the status, and the latency.
          </li>
          <li>
            One event per repository activity (a change opening, a merge), carrying the event type
            and an opaque project id.
          </li>
        </ul>
        <p class="settings-help">
          Concrete URLs, namespaces, repository names, file paths, diffs, and request payloads are
          never sent. Turning this off stops future events for your account and for any agent token
          you own; it does not delete events already sent.
        </p>
        <form method="post" action="/settings/telemetry">
          <label>
            {/*
              The missing `value` is load-bearing: browsers submit a valueless
              checked box as "on", and POST /settings/telemetry accepts only
              that literal. Adding value="1" would opt every user out, because
              the route reads an unrecognized value as an opt-out (it fails
              toward privacy). The field is also the affirmative while the
              stored column is the negative, hence the inversion here.
            */}
            <input type="checkbox" name="analytics" checked={!telemetryOptOut} />
            Send anonymous usage analytics
          </label>
          <button type="submit" class="btn btn-primary">
            Save preference
          </button>
        </form>
      </div>

      <div class="card">
        <h3 style={{ marginTop: 0 }}>API key</h3>
        <p class="settings-help">
          Used as <code>Authorization: Bearer stratum_user_…</code> for the API and CLI. Rotating
          invalidates the current key immediately.
        </p>
        <form method="post" action="/settings/rotate-token">
          <button type="submit" class="btn btn-danger">
            Rotate API key
          </button>
        </form>
      </div>

      <div class="card">
        <h3 style={{ marginTop: 0 }}>Agents</h3>
        <p class="settings-help">
          Agent tokens let automated agents fork workspaces, commit, and open changes under your
          account. Reviews remain human-only.
        </p>
        {agents.length === 0 ? (
          <p class="settings-help">No agents yet.</p>
        ) : (
          <table class="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Model</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {agents.map((agent) => (
                <tr key={agent.id}>
                  <td>{agent.name}</td>
                  <td>{agent.model ?? "—"}</td>
                  <td>{new Date(agent.createdAt).toLocaleDateString()}</td>
                  <td>
                    <form method="post" action={`/settings/agents/${agent.id}/delete`}>
                      <button type="submit" class="btn btn-small btn-danger">
                        Revoke
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <form method="post" action="/settings/agents" class="settings-agent-form">
          <label>
            Agent name
            <input type="text" name="name" required maxlength={100} />
          </label>
          <label>
            Model (optional)
            <input type="text" name="model" placeholder="claude-sonnet-4-6" maxlength={100} />
          </label>
          <button type="submit" class="btn btn-primary">
            Create agent token
          </button>
        </form>
      </div>

      <div class="card danger-zone">
        <h3 style={{ marginTop: 0 }}>Danger Zone</h3>
        <p class="settings-help">
          Permanently delete your account. All your projects and personal data are erased and your
          tokens stop working immediately. Contributions you left in other people's projects are
          anonymized, not deleted. This cannot be undone. Type <code>{user.username}</code> to
          confirm.
        </p>
        <form method="post" action="/api/users/me/delete">
          <input
            type="text"
            name="confirm"
            required
            autocomplete="off"
            placeholder={user.username}
          />
          <button type="submit" class="btn btn-danger">
            Delete account
          </button>
        </form>
      </div>
    </Layout>
  );
};
