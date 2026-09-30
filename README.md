# SCIM Lifecycle Lab

A small, inspectable demo of SCIM 2.0 identity lifecycle provisioning alongside an Auth0-protected application. SCIM (System for Cross-domain Identity Management) manages application identities; OIDC (OpenID Connect) handles sign-in.

The lab is designed to make one distinction concrete:

- SCIM provisions users and groups and manages their lifecycle.
- Auth0 authenticates people into the sample application through OIDC.
- An enterprise directory, such as Microsoft Entra ID or Okta, is the usual SCIM client.
- This project is the SCIM service provider.

Auth0 is intentionally not assumed to be a generic outbound SCIM client. Any tenant-specific provisioning features should be verified independently before relying on them.

## Choose Your Demo

| Demo | Requirements | What you will see |
| --- | --- | --- |
| [SCIM-only demo](#scim-only-demo) | Local Node.js and npm; no Auth0 tenant required | Automated provisioning, group membership, profile changes, disable/enable, and deletion. |
| [Auth0 access demo](#auth0-access-demo) | Shared local setup, an Auth0 Regular Web Application, and an existing Auth0 user | Access granted, denied, and restored while using the same browser session. |

Start with the SCIM-only demo if you are new to the lab. Neither path requires Entra ID, Okta, or the optional Auth0 Management API adapter.

The simulator uses local profiles named Alice and Bob. It does not create Auth0 accounts or passwords. For the Auth0 demo, Alice's SCIM profile represents the existing Auth0 account you choose, even if that person's name or email is different.

## Quick Start

Prerequisites: Node.js 22.13 or later and npm 11 or later. The commands below use PowerShell and must be run from the repository root.

1. In **Terminal 1**, create a root `.env` from the [environment template](.env.example). Keep an existing configured file:

  ```powershell
  if (-not (Test-Path .env)) { Copy-Item .env.example .env }
  ```

2. Edit `.env`: replace `SCIM_BEARER_TOKEN` with your own local token of at least 16 characters. Keep `SCIM_ENABLE_INSPECTION=true` for this local walkthrough. The SCIM-only demo can leave all Auth0 placeholders unchanged.

3. Install, build, and migrate in **Terminal 1**:

  ```powershell
  npm install
  npm run build
  npm run migrate
  ```

  Expected: the build succeeds and migration prints `Migration complete`. The build is required because the applications import the compiled shared SCIM contract.

4. Start the SCIM service in **Terminal 1** and leave it running:

  ```powershell
  npm run dev:scim
  ```

5. Open **Terminal 2** at the repository root and check the service:

  ```powershell
  Invoke-RestMethod -Uri 'http://127.0.0.1:3000/health'
  ```

  Expected: `status` is `ok`. Terminal 2 is used for all simulator commands below.

The entrypoints load the root `.env` even when npm starts them from a workspace directory. A package-local `.env`, if present, takes precedence. The default local URLs are SCIM at `http://127.0.0.1:3000` and the demo app at `http://localhost:3001`.

## SCIM-Only Demo

In **Terminal 2**, run:

```powershell
npm run simulate:lifecycle
```

Expected: every request prints matching `expected` and `actual` status codes, followed by `Lifecycle scenario complete`.

The simulator creates Alice and Bob, creates `Engineering`, adds Alice, changes her department, disables and re-enables her, removes her membership, and deletes her. Afterwards:

| Resource | Expected final state |
| --- | --- |
| Alice | Deleted |
| Bob | Present and active |
| Engineering | Present with no members |
| Audit events | Requests and mutation snapshots from the run |

Use [Inspect and Clean Up](#inspect-and-clean-up) to view the results. This automated run does not pause for browser login and **deletes Alice**. Use `simulate:provision`, not `simulate:lifecycle`, when proceeding to the Auth0 demo.

## Auth0 Access Demo

Keep the SCIM service running in Terminal 1. Complete [Auth0 setup](docs/auth0-setup.md), including the Regular Web Application, local callback settings, and root `.env` credentials.

1. Choose an existing Auth0 user you can sign in as. In the Auth0 Dashboard, open **User Management > Users**, select that user, and copy the **User ID**. For this demo, that exact value is the OIDC `sub` (subject identifier), commonly shaped like `auth0|...`. Set `SCIM_AUTH0_SUBJECT` in the root `.env` to it; do not substitute an email address.

2. In **Terminal 2**, provision the local profiles:

  ```powershell
  npm run simulate:provision
  ```

  Expected: `Provisioning scenario complete`. Alice remains present and active, with `externalId` equal to your selected Auth0 user's `sub`, and belongs to Engineering.

3. Open **Terminal 3** at the repository root, start the demo app, and leave it running:

  ```powershell
  npm run dev:demo
  ```

4. Open `http://localhost:3001` and sign in as the selected Auth0 user. Expected: the protected page displays **Active SCIM access**.

5. In **Terminal 2**, disable Alice:

  ```powershell
  npm run simulate:disable
  ```

  Expected: `Alice is inactive`. Refresh `http://localhost:3001/app`: the page displays **Access denied** and returns HTTP `403`. Do not sign out; the existing Auth0-authenticated session remains valid.

6. In **Terminal 2**, re-enable Alice:

  ```powershell
  npm run simulate:enable
  ```

  Expected: `Alice is active`. Refresh `/app` again: **Active SCIM access** is restored with HTTP `200`.

This is the key distinction: a successful login does not override a later lifecycle disablement. The app checks SCIM status on each protected request. Disabling Alice does not remove her group membership.

## Inspect and Clean Up

In **Terminal 2**, replace the placeholder with the same local token you set in `.env`:

```powershell
$scimHeaders = @{ Authorization = 'Bearer replace-with-your-local-token' }
$state = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/_dev/inspection' -Headers $scimHeaders
$state.users | Format-Table userName, active
$state.groups | Format-Table displayName, members
$state.auditEvents | Select-Object -First 5 -Property method, path, status, correlationId
```

Expected: the response contains `users`, `groups`, and the latest 500 redacted `auditEvents`, including request payloads and mutation snapshots. After the SCIM-only demo, Bob remains and Engineering is empty; after the Auth0 provisioning demo, Alice is present and belongs to Engineering.

When finished, run in **Terminal 2**:

```powershell
npm run simulate:cleanup
```

Expected: `Cleanup complete`; the simulator's Alice, Bob, and Engineering resources are gone. Stop the servers with `Ctrl+C` in Terminals 1 and 3.

`provision` and `lifecycle` also clean up these known resources before starting. Use the simulator only against a disposable lab directory. Inspection is a bearer-protected JSON API, not a separate UI, and should remain limited to local development or an authenticated administrative audience.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Startup reports missing or invalid configuration | Run from the repository root, configure the root `.env`, and ensure `SCIM_BEARER_TOKEN` has at least 16 characters. Check for an older package-local `.env` or exported environment variable overriding it. |
| A shared-contract module cannot be found | Run `npm run build` before starting the apps or simulator. |
| SCIM calls or inspection return `401` | Use the same bearer token as the service; restart the service if you changed its token. |
| Inspection returns `404` | Set `SCIM_ENABLE_INSPECTION=true` and restart the SCIM service. |
| Auth0 login succeeds but the app returns `403` | Check the exact `SCIM_AUTH0_SUBJECT`, sign in as that Auth0 user, and run `simulate:provision` or `simulate:enable`. A full lifecycle run deletes Alice. |
| The protected app returns `503` | Keep the SCIM service running and verify its health URL, `SCIM_BASE_URL`, and bearer token. |

For a presenter-oriented walkthrough, see [docs/demo-script.md](docs/demo-script.md). The diagrams and protocol reference below explain the implementation behind these demos.

## Architecture

```mermaid
flowchart LR
    CLIENT[SCIM client simulator\nor Entra ID / Okta]
    SCIM[Demo SCIM service\nUsers, Groups, discovery]
    DB[(SQLite)]
    AUDIT[Audit log]
    ADAPTER[Optional Auth0\nManagement API adapter]
    AUTH0[Auth0]
    APP[Sample application]

    CLIENT -->|SCIM 2.0 over HTTPS| SCIM
    SCIM --> DB
    SCIM --> AUDIT
    SCIM -. optional lifecycle sync .-> ADAPTER
    ADAPTER --> AUTH0
    APP -->|OIDC login| AUTH0
    APP -->|active-status authorization check| SCIM
```

The sample application must enforce lifecycle status after authentication. An existing Auth0 browser session can otherwise outlive a later SCIM `active: false` update.

## API Reference

The SCIM service exposes these SCIM 2.0 endpoints:

| Endpoint | Purpose |
| --- | --- |
| `GET /ServiceProviderConfig` | Advertise implemented capabilities |
| `GET /ResourceTypes` | Describe User and Group resource types |
| `GET /Schemas` | Publish supported schemas |
| `GET/POST /Users` | Search or create users |
| `GET/PUT/PATCH/DELETE /Users/{id}` | Manage an individual user |
| `GET/POST /Groups` | Search or create groups |
| `GET/PUT/PATCH/DELETE /Groups/{id}` | Manage an individual group |

The implementation supports bearer-token authentication, pagination (`startIndex`, `count`), a limited documented filter grammar, and SCIM `ListResponse` and error objects. Mutation requests require `application/scim+json`.

## HTTPS Deployment

Plain HTTP is allowed only for loopback development. A non-loopback `SCIM_HOST` enables HTTPS enforcement automatically and cannot explicitly disable it. The service itself listens over HTTP; terminate public TLS at a reverse proxy and prevent direct access to the backend port.

For a TLS proxy on the same machine:

```dotenv
SCIM_HOST=127.0.0.1
SCIM_ENFORCE_HTTPS=true
SCIM_TRUST_PROXY=127.0.0.1,::1
```

The proxy must overwrite incoming `X-Forwarded-Proto`, `X-Forwarded-Host`, and `X-Forwarded-For` with verified values. Only configured proxy IPs/CIDRs are trusted; never trust all internet addresses. Forwarded HTTPS requests produce HTTPS resource URLs, including the public host and port. Keep inspection disabled on public deployments unless its bearer-protected administrative audience is explicitly intended.

The real-directory setup and remaining tenant validation are described in [docs/idp-setup.md](docs/idp-setup.md).

## Auth0 Boundary

Auth0 is part of the login flow, not the core SCIM protocol demonstration.

- The sample application uses an Auth0 OIDC application for sign-in.
- The application checks the local SCIM user is active before serving protected content.
- An optional, disabled-by-default adapter uses the Auth0 Management API to block a corresponding account when SCIM sets `active: false` or deletes the local User, and unblock it when re-enabled.
- The adapter maps `externalId` directly to the Auth0 `sub` and stores `externalId`, department, and employee number in approved `app_metadata` fields. It never creates or deletes Auth0 accounts.
- Adapter outcomes appear in the audit trail. Missing accounts and API failures are non-fatal; the local SCIM lifecycle gate remains authoritative. Setup is in [docs/auth0-setup.md](docs/auth0-setup.md#optional-management-api-adapter).
- SCIM groups and Auth0 roles remain distinct until an explicit, documented mapping is added.
- Password synchronization is out of scope.

## Lifecycle Sequence

The simulator provisions Alice with the selected Auth0 user's `sub` as her SCIM `externalId`. The application checks her lifecycle status on every protected request, even when an existing Auth0-authenticated session remains valid.

```mermaid
sequenceDiagram
  participant CLIENT as SCIM client simulator
  participant SCIM as SCIM service
  participant BROWSER as Browser
  participant APP as Demo application
  participant AUTH0 as Auth0

  CLIENT->>SCIM: POST /Users (externalId = Auth0 sub, active = true)
  SCIM-->>CLIENT: 201 Created
  BROWSER->>APP: GET /login
  APP-->>BROWSER: Redirect to Auth0
  BROWSER->>AUTH0: Authenticate
  AUTH0-->>BROWSER: Redirect to /callback with authorization code
  BROWSER->>APP: GET /callback
  APP->>AUTH0: Exchange authorization code
  AUTH0-->>APP: OIDC tokens with sub
  APP-->>BROWSER: Establish application session and redirect to /app

  BROWSER->>APP: GET /app (session cookie)
  APP->>SCIM: GET /Users?filter=externalId eq "sub"
  SCIM-->>APP: One matching User, active = true
  APP-->>BROWSER: 200 Protected content

  CLIENT->>SCIM: PATCH /Users/{id} (active = false)
  SCIM-->>CLIENT: 200 User, active = false
  Note over BROWSER,APP: Existing Auth0-authenticated session remains valid
  BROWSER->>APP: Refresh /app (same session cookie)
  APP->>SCIM: GET /Users?filter=externalId eq "sub"
  SCIM-->>APP: One matching User, active = false
  APP-->>BROWSER: 403 Access denied
```

## Repository Layout

```text
apps/
  scim-service/        SCIM API, persistence, and audit logging
  demo-app/            Auth0-protected application and lifecycle gate
packages/
  scim-contract/       Shared SCIM schemas, types, and error helpers
  client-simulator/    Repeatable lifecycle requests
docs/
  implementation-plan.md
  auth0-setup.md
```

## Current Implementation

The local SCIM implementation is available:

- SQLite migrations for users, groups, group membership, and audit events.
- Bearer-protected discovery endpoints and SCIM-formatted errors.
- User and Group create, read, replace, patch, delete, pagination, and documented equality filters.
- Atomic mutations, case-insensitive unique `userName` and `displayName`, and cascading group-membership removal when a User is deleted.
- Request/outcome auditing with configurable payload and PATCH-path redaction and a bearer-protected development inspection endpoint.
- A repeatable HTTP client simulator for the Alice/Bob lifecycle scenario.
- A server-side Auth0 Regular Web Application that checks an Auth0 `sub` against the matching active SCIM `externalId` on every protected request.
- Optional Auth0 Management API lifecycle sync, bounded retries of absolute updates, ordered per-account changes, and audited non-fatal results.
- Loopback-only HTTP development and explicit trusted-proxy support for public HTTPS deployments.

Live Auth0 sign-in and real Entra ID/Okta acceptance remain tenant-dependent validation steps. The checked-in guide records the current limitations without claiming a completed real-IdP run.

## Implemented Protocol Subset

| Area | Supported behavior |
| --- | --- |
| Authentication | Static bearer token on all SCIM endpoints; unauthenticated calls receive a SCIM `401` error before request-body processing. |
| Discovery | `ServiceProviderConfig`, `ResourceTypes`, and `Schemas`; only implemented capabilities are advertised. |
| User filters | `userName eq "value"` or exact `externalId eq "value"`, with `startIndex` and `count` pagination. |
| Group filters | `displayName eq "value"`, with `startIndex` and `count` pagination. |
| User PATCH | `add`, `replace`, and `remove` for explicit core and enterprise attribute paths. |
| Group PATCH | `add`, `replace`, and `remove` for `displayName` and `members`; repeated member adds are no-ops. |
| Enterprise attributes | Department and employee number through `urn:ietf:params:scim:schemas:extension:enterprise:2.0:User`. |
| User deletion | Permanent deletion; memberships are removed atomically and affected Group versions advance. |

Unsupported filter or PATCH paths return explicit SCIM errors. Bulk operations, sorting, ETags, and password synchronization are not supported.

## Quality Bar

Run the automated checks from the repository root:

```powershell
npm run check
npm test
```

- Duplicate `userName` requests return `409` with `scimType: "uniqueness"`.
- Missing resources return `404`; unauthenticated requests return `401`.
- `PATCH` changes are atomic.
- Repeating a group-membership change is harmless.
- Filtering and pagination return valid `ListResponse` payloads.
- Deleted users no longer appear in list results.
- Discovery documents match the actual implementation.
- Lifecycle mutations capture redacted before-and-after snapshots; audit persistence is currently best-effort.
- Sensitive PATCH values are redacted, including rejected password operations.
- The optional Auth0 adapter never causes a committed SCIM mutation to fail and records sanitized outcomes.
- Public HTTP and untrusted forwarding headers are rejected; resource URLs retain their ports.

## Documentation

The phased build plan, implementation choices, and test matrix are in [docs/implementation-plan.md](docs/implementation-plan.md).

## References

- [RFC 7643: SCIM Core Schema](https://www.rfc-editor.org/rfc/rfc7643)
- [RFC 7644: SCIM Protocol](https://www.rfc-editor.org/rfc/rfc7644)
- [Auth0 enterprise identity providers](https://auth0.com/docs/authenticate/identity-providers/enterprise-identity-providers)
