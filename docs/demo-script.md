# SCIM Lifecycle Lab Demo Script

For first-time setup, use the [README Quick Start](../README.md#quick-start). Choose either the automated SCIM-only sequence or the interactive Auth0 login check below. The SCIM-only sequence needs no Auth0 tenant.

## Prepare

Run all commands from the repository root. Create one root `.env` from `.env.example` if it does not already exist, set a local `SCIM_BEARER_TOKEN` with at least 16 characters, and keep `SCIM_ENABLE_INSPECTION=true` for local inspection.

In Terminal 1:

```powershell
npm install
npm run build
npm run migrate
npm run dev:scim
```

Expected: the build succeeds, migration prints `Migration complete`, and the SCIM service remains running. In Terminal 2:

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:3000/health'
```

Expected: `status` is `ok`. Keep Terminal 2 for simulator commands and inspection.

## SCIM-Only Run

In Terminal 2:

```powershell
npm run simulate:lifecycle
```

Expected: the simulator prints a correlation ID and matching expected/actual status codes for every HTTP request, then `Lifecycle scenario complete`. This automated run deletes Alice and does not pause for browser login.

## Expected Lifecycle

1. The simulator checks for prior Alice, Bob, and Engineering resources and removes them when present.
2. It creates Alice and Bob with `201` responses.
3. It creates Engineering with `201`.
4. It adds Alice to Engineering with a Group PATCH `200`.
5. It updates Alice's enterprise department with a User PATCH `200`.
6. It disables Alice, then re-enables Alice, with two User PATCH `200` responses.
7. It removes Alice from Engineering with a Group PATCH `200`.
8. It permanently deletes Alice with `204`.

At this point Bob remains, Engineering remains without Alice, and the development inspection API contains redacted audit events for the sequence.

## Auth0 Login Check

Keep the SCIM service running. Configure a Regular Web Application and an existing test user as described in [auth0-setup.md](auth0-setup.md). Copy the selected user's **User ID** from **User Management > Users** in the Auth0 Dashboard; this is the exact OIDC `sub` used by this demo.

Set `SCIM_AUTH0_SUBJECT` in the root `.env` to that value, then run in Terminal 2:

```powershell
npm run simulate:provision
```

Expected: `Provisioning scenario complete`. This leaves Alice active and present in the directory. The server-side demo app maps that value to the SCIM User `externalId`; it never uses the mutable email claim as the binding key. The simulator does not create Auth0 accounts: Alice represents the existing account you selected, even when that person's name differs.

In Terminal 3 at the repository root:

```powershell
npm run dev:demo
```

1. Sign in at `http://localhost:3001` as the selected Auth0 user. The application displays **Active SCIM access**.
2. In Terminal 2, run `npm run simulate:disable` and expect `Alice is inactive`.
3. Refresh `http://localhost:3001/app`. The same Auth0-authenticated session receives **Access denied** with HTTP `403` because Alice is inactive. Do not sign out.
4. In Terminal 2, run `npm run simulate:enable` and expect `Alice is active`, then refresh `/app`. Access is restored with HTTP `200`.
5. Run `npm run simulate:cleanup` when the demonstration is complete.

An authenticated user receives application access only while exactly one mapped SCIM User exists and that User is active. A missing, inactive, or ambiguous mapping receives a clear denial response. The check is repeated on each protected application request.

## Inspect

Use an authenticated request to `GET http://127.0.0.1:3000/_dev/inspection` with the same bearer token. This is a JSON API, not a separate UI. The response contains current users, groups, active state, request method/path/status, correlation IDs, redacted payloads, and mutation snapshots.

For example, in PowerShell:

```powershell
$state = Invoke-RestMethod `
  -Uri 'http://127.0.0.1:3000/_dev/inspection' `
  -Headers @{ Authorization = 'Bearer replace-with-your-local-token' }
$state.users | Format-Table userName, active
$state.groups | Format-Table displayName, members
$state.auditEvents | Select-Object -First 5 -Property method, path, status, correlationId
```

## Clean Up

Run `npm run simulate:cleanup` in Terminal 2 to remove the simulator's known Engineering, Alice, and Bob resources; expect `Cleanup complete`. The cleanup mode is safe to run when none of those resources exist. Stop the servers with `Ctrl+C` in Terminals 1 and 3.

`simulate:provision` and `simulate:lifecycle` also delete these known resources before recreating them. Use a disposable lab directory, not an existing production directory.