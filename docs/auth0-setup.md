# Auth0 Setup

## Application Type

Create an Auth0 **Regular Web Application**. The demo app is a server-side Express application that uses the authorization-code flow through `express-openid-connect`.

For local development, configure these values in the Auth0 application settings:

| Setting | Value |
| --- | --- |
| Allowed Callback URLs | `http://localhost:3001/callback` |
| Allowed Logout URLs | `http://localhost:3001` |
| Allowed Web Origins | `http://localhost:3001` |

Use HTTPS equivalents outside localhost. The callback URL must be `DEMO_APP_BASE_URL` followed by `/callback`, and the logout URL must equal `DEMO_APP_BASE_URL`; the application validates both at startup.

## Local Configuration

Complete the shared [Quick Start](../README.md#quick-start), including `npm install`, `npm run build`, and `npm run migrate`. Edit the existing repository-root `.env`, then set:

```dotenv
DEMO_APP_BASE_URL=http://localhost:3001
AUTH0_DOMAIN=your-tenant.us.auth0.com
AUTH0_CLIENT_ID=your-regular-web-app-client-id
AUTH0_CLIENT_SECRET=your-regular-web-app-client-secret
AUTH0_SESSION_SECRET=at-least-32-random-characters
AUTH0_CALLBACK_URL=http://localhost:3001/callback
AUTH0_LOGOUT_URL=http://localhost:3001
```

Generate a session secret locally with:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Keep the SCIM service running in Terminal 1, or start it from the repository root:

```powershell
npm run dev:scim
```

Start the demo app from the repository root in Terminal 3. Reserve Terminal 2 for simulator commands:

```powershell
npm run dev:demo
```

Expected: the console prints `Demo app listening at http://localhost:3001`. The Auth0 SDK owns `/login`, `/callback`, and `/logout`; do not create application routes with those paths. Provision the identity mapping below before signing in at `http://localhost:3001`.

## SCIM Identity Binding

The browser never receives the SCIM bearer token. After Auth0 authenticates a browser session, the demo app reads the stable OIDC `sub` claim and, from the server, requests:

```text
GET /Users?filter=externalId eq "<Auth0 sub>"
```

The application grants protected access only when exactly one matching SCIM User exists and `active` is `true`. It rejects access when the local User is missing, inactive, or ambiguous, and fails closed when the SCIM service cannot be reached. The lookup runs on every protected `/app` and `/api/session` request.

Choose an existing Auth0 user you can sign in as. In the Auth0 Dashboard, open **User Management > Users**, select the user, and copy the **User ID**. For this demo, that exact value is the OIDC `sub`, often shaped like `auth0|...`.

Set `SCIM_AUTH0_SUBJECT` in the root `.env` to that value. Do not map by email. In Terminal 2, run:

```powershell
npm run simulate:provision
```

Expected: `Provisioning scenario complete`. Alice's local SCIM `externalId` now matches the selected Auth0 account. The simulator does not create an Auth0 user, and you should sign in using the selected account's credentials, not the simulator's `alice@example.test` profile name.

Do not use `simulate:lifecycle` for login testing: it deletes Alice at the end. When `SCIM_AUTH0_SUBJECT` is blank, the simulator uses a local-only identifier that will not match your Auth0 login.

Sign in at `http://localhost:3001` and expect **Active SCIM access**. Run `npm run simulate:disable` in Terminal 2, then refresh `/app` to see **Access denied** with HTTP `403`. Run `npm run simulate:enable` and refresh again to restore access with HTTP `200`; no sign-out is required. Finish with `npm run simulate:cleanup`.

## Credentials and Scope

Keep `AUTH0_CLIENT_SECRET`, `AUTH0_SESSION_SECRET`, and `SCIM_BEARER_TOKEN` in environment-specific secret storage. Do not expose any of them to browser code.

The optional Auth0 Management API adapter is not implemented yet. No Management API client credentials or scopes are required for this phase.