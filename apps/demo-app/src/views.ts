import type { AuthenticatedIdentity } from "./authentication.js";
import type { ScimDirectoryUser } from "./scim-client.js";

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "'": "&#39;",
      '"': "&quot;"
    };

    return entities[character] ?? character;
  });
}

function document(title: string, content: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light">
    <title>${escapeHtml(title)}</title>
    <style>
      :root { color: #1f2933; background: #f5f7f6; font-family: "Aptos", "Trebuchet MS", sans-serif; }
      * { box-sizing: border-box; }
      body { margin: 0; min-width: 320px; background: linear-gradient(135deg, #f5f7f6 0%, #eaf2ef 100%); }
      main { width: min(960px, calc(100% - 32px)); margin: 0 auto; padding: 52px 0 72px; }
      header { display: flex; align-items: baseline; justify-content: space-between; gap: 20px; border-bottom: 1px solid #c9d7d1; padding-bottom: 20px; }
      .product { color: #006c62; font-size: 15px; font-weight: 700; letter-spacing: 0; margin: 0; text-transform: uppercase; }
      h1 { font-family: Georgia, Cambria, serif; font-size: 34px; font-weight: 600; letter-spacing: 0; line-height: 1.15; margin: 0; }
      h2 { font-family: Georgia, Cambria, serif; font-size: 22px; font-weight: 600; letter-spacing: 0; margin: 0; }
      p { line-height: 1.55; }
      .layout { display: grid; gap: 28px; grid-template-columns: minmax(0, 1fr) 260px; margin-top: 38px; }
      .status { border-left: 5px solid #007c73; padding: 18px 0 18px 20px; }
      .status.denied { border-left-color: #be4b3c; }
      .status.unavailable { border-left-color: #b87900; }
      .button { display: inline-block; background: #006c62; border: 1px solid #006c62; border-radius: 4px; color: #ffffff; font-weight: 700; padding: 10px 16px; text-decoration: none; }
      .button:hover { background: #00574f; }
      .button.secondary { background: transparent; color: #006c62; }
      .details { border-top: 1px solid #c9d7d1; margin: 0; }
      .details div { border-bottom: 1px solid #c9d7d1; display: grid; gap: 12px; grid-template-columns: 130px minmax(0, 1fr); padding: 13px 0; }
      dt { color: #52616b; font-weight: 700; }
      dd { margin: 0; overflow-wrap: anywhere; }
      .active { color: #006c62; font-weight: 700; }
      .aside { align-self: start; border-top: 4px solid #f0b429; padding-top: 16px; }
      .muted { color: #52616b; }
      @media (max-width: 720px) { main { padding-top: 32px; } header { align-items: flex-start; flex-direction: column; } .layout { grid-template-columns: 1fr; } .details div { grid-template-columns: 1fr; gap: 4px; } h1 { font-size: 30px; } }
    </style>
  </head>
  <body>${content}</body>
</html>`;
}

export function renderSignedOut(): string {
  return document(
    "SCIM Lifecycle Lab",
    `<main>
      <header><p class="product">SCIM Lifecycle Lab</p><p class="muted">Application access</p></header>
      <section class="layout">
        <div class="status"><h1>Sign in</h1><p>Use your Auth0 account to continue to the protected application.</p><a class="button" href="/login">Sign in with Auth0</a></div>
        <aside class="aside"><h2>Lifecycle-aware access</h2><p class="muted">Access is evaluated against the local SCIM record after authentication.</p></aside>
      </section>
    </main>`
  );
}

export function renderDashboard(identity: AuthenticatedIdentity, user: ScimDirectoryUser): string {
  const displayName = user.displayName ?? identity.displayName ?? user.userName;

  return document(
    "Application access",
    `<main>
      <header><p class="product">SCIM Lifecycle Lab</p><a class="button secondary" href="/logout">Sign out</a></header>
      <section class="layout">
        <div class="status"><h1>${escapeHtml(displayName)}</h1><p class="active">Active SCIM access</p>
          <dl class="details">
            <div><dt>Auth0 subject</dt><dd>${escapeHtml(identity.subject)}</dd></div>
            <div><dt>SCIM user</dt><dd>${escapeHtml(user.userName)}</dd></div>
            <div><dt>SCIM identifier</dt><dd>${escapeHtml(user.id)}</dd></div>
          </dl>
        </div>
        <aside class="aside"><h2>Authenticated</h2><p class="muted">Your current session is allowed by the active local lifecycle record.</p></aside>
      </section>
    </main>`
  );
}

export function renderAccessDenied(reason: "missing" | "ambiguous" | "inactive"): string {
  const detail =
    reason === "inactive"
      ? "Your local lifecycle record is inactive."
      : reason === "ambiguous"
        ? "More than one local lifecycle record matches this identity."
        : "No local lifecycle record matches this identity.";

  return document(
    "Access denied",
    `<main>
      <header><p class="product">SCIM Lifecycle Lab</p><a class="button secondary" href="/logout">Sign out</a></header>
      <section class="layout"><div class="status denied"><h1>Access denied</h1><p>${detail}</p></div><aside class="aside"><h2>Lifecycle gate</h2><p class="muted">Authentication alone does not grant application access.</p></aside></section>
    </main>`
  );
}

export function renderDirectoryUnavailable(): string {
  return document(
    "Access verification unavailable",
    `<main>
      <header><p class="product">SCIM Lifecycle Lab</p><a class="button secondary" href="/logout">Sign out</a></header>
      <section class="layout"><div class="status unavailable"><h1>Access verification unavailable</h1><p>The lifecycle directory could not be verified. Access has not been granted.</p></div></section>
    </main>`
  );
}
