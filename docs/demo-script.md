# SCIM Lifecycle Lab Demo Script

## Prepare

1. Copy `.env.example` to `.env` and set a local `SCIM_BEARER_TOKEN` with at least 16 characters.
2. Run `npm install`.
3. Run `npm run migrate`.
4. Run `npm run dev:scim`.
5. In another terminal, run `npm run simulate:lifecycle`.

The simulator prints a correlation ID, expected status, and actual status for every HTTP request.

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

Configure a Regular Web Application as described in [auth0-setup.md](auth0-setup.md), then run `npm run dev:demo` and open `http://localhost:3001`.

For an Auth0-connected provisioning run, set `SCIM_AUTH0_SUBJECT` to the selected user's exact Auth0 `sub`, then run:

```powershell
npm run simulate:provision
```

This leaves Alice active and present in the directory. The server-side demo app maps that value to the SCIM User `externalId`; it never uses the mutable email claim as the binding key.

1. Sign in at `http://localhost:3001` as the selected Auth0 user. The application displays **Active SCIM access**.
2. In another terminal, run `npm run simulate:disable`.
3. Refresh `http://localhost:3001/app`. The same Auth0 session receives **Access denied** because Alice is inactive.
4. Run `npm run simulate:enable`, then refresh `/app`. Access is restored.
5. Run `npm run simulate:cleanup` when the demonstration is complete.

An authenticated user receives application access only while exactly one mapped SCIM User exists and that User is active. A missing, inactive, or ambiguous mapping receives a clear denial response. The check is repeated on each protected application request.

## Inspect

Use an authenticated request to `GET http://127.0.0.1:3000/_dev/inspection` with the same bearer token. The response displays current users, groups, active state, request method/path/status, correlation IDs, redacted payloads, and mutation snapshots.

For example, in PowerShell:

```powershell
Invoke-RestMethod `
  -Uri 'http://127.0.0.1:3000/_dev/inspection' `
  -Headers @{ Authorization = 'Bearer replace-with-your-local-token' }
```

## Clean Up

Run `npm run simulate:cleanup` to remove the simulator's known Engineering, Alice, and Bob resources. The cleanup mode is safe to run when none of those resources exist.