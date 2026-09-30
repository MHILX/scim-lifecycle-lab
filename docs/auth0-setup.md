# Auth0 Setup

## Application Type

Create an Auth0 **Regular Web Application**. The demo app is a server-side Express application that uses the authorization-code flow through `express-openid-connect`.

For local development, configure these values in the Auth0 application settings:

| Setting | Value |
| --- | --- |
| Allowed Callback URLs | `http://localhost:3001/callback` |
| Allowed Logout URLs | `http://localhost:3001` |
| Allowed Web Origins | `http://localhost:3001` |

Use HTTPS equivalents outside localhost. The callback and logout values must match `DEMO_APP_BASE_URL` exactly; the application validates this at startup.

## Local Configuration

Copy `.env.example` to `.env`, then set:

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

Start the two servers in separate terminals:

```powershell
npm run dev:scim
npm run dev:demo
```

Open `http://localhost:3001`. The Auth0 SDK owns `/login`, `/callback`, and `/logout`; do not create application routes with those paths.

## SCIM Identity Binding

The browser never receives the SCIM bearer token. After Auth0 authenticates a browser session, the demo app reads the stable OIDC `sub` claim and, from the server, requests:

```text
GET /Users?filter=externalId eq "<Auth0 sub>"
```

The application grants protected access only when exactly one matching SCIM User exists and `active` is `true`. It rejects access when the local User is missing, inactive, or ambiguous, and fails closed when the SCIM service cannot be reached. The lookup runs on every protected `/app` and `/api/session` request.

Provision the selected Auth0 user's exact `sub` into the SCIM User's `externalId`; do not map by email. For the checked-in simulator, set `SCIM_AUTH0_SUBJECT` to that `sub` before running `npm run simulate:lifecycle`. The default simulator identifier is retained when this variable is blank.

## Credentials and Scope

Keep `AUTH0_CLIENT_SECRET`, `AUTH0_SESSION_SECRET`, and `SCIM_BEARER_TOKEN` in environment-specific secret storage. Do not expose any of them to browser code.

The optional Auth0 Management API adapter is not implemented yet. No Management API client credentials or scopes are required for this phase.