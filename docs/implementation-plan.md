# SCIM Lifecycle Lab Implementation Plan

## Objective

Deliver a local demo that shows an enterprise directory provisioning users and groups through SCIM 2.0 while Auth0 independently handles OIDC login to a sample application. The project should make every lifecycle event observable and reproducible without needing an external IdP.

## Decisions to Preserve

| Area | Decision |
| --- | --- |
| SCIM roles | The directory or simulator is the SCIM client; this project is the SCIM service provider. |
| Authentication | Auth0 authenticates the demo application via OIDC. It is not required to originate SCIM calls. |
| Local persistence | Use SQLite for the first working demo. |
| First client | Build a checked-in simulator before integrating Entra ID or Okta. |
| Passwords | Do not accept, store, or synchronize passwords. |
| Lifecycle enforcement | The application checks SCIM active status on protected requests. |
| Auth0 synchronization | Keep it optional and isolated behind an adapter. |

## Reference Stack

Use TypeScript on a current LTS Node.js release. The reference implementation should use a small HTTP framework with schema validation, SQLite with migrations, and a focused test runner. A suggested combination is Fastify, Zod, Drizzle ORM, and Vitest.

The chosen framework is replaceable, but the HTTP contract, data model, and test cases below are not.

## Phases

### 1. Bootstrap the Workspace

Create a package workspace with these deployable surfaces:

- `apps/scim-service`: SCIM HTTP API and persistence layer.
- `apps/demo-app`: Auth0-protected UI and active-user authorization gate.
- `packages/scim-contract`: SCIM schemas, resource mapping, and error serialization.
- `packages/client-simulator`: deterministic lifecycle scenarios.

Add environment templates for the database, SCIM bearer token, and Auth0 configuration. Keep real secrets out of source control.

**Exit criteria:** a developer can install dependencies, start the SCIM service, run migrations, and execute a health check locally.

### 2. Model Resources and Persistence

Create tables for:

- `users`: immutable internal ID, `external_id`, unique `user_name`, profile fields, `active`, timestamps, and version.
- `groups`: immutable internal ID, unique display name, timestamps, and version.
- `group_members`: group/user relationship with uniqueness protection.
- `audit_events`: correlation ID, actor, request metadata, redacted payloads, HTTP status, and before-and-after snapshots.

Represent SCIM `meta.created`, `meta.lastModified`, `meta.resourceType`, `meta.location`, and `meta.version` at the resource boundary. Store stable internal values so conditional updates can be added later without a migration redesign.

**Exit criteria:** migrations create the schema from an empty database and data-access tests verify uniqueness and membership integrity.

### 3. Implement Discovery and Authentication

Add bearer-token middleware for all SCIM endpoints. Return SCIM error payloads for authentication failures and never write authorization headers to the audit log.

Implement:

- `GET /ServiceProviderConfig`
- `GET /ResourceTypes`
- `GET /Schemas`

Initially advertise only features implemented in the following phases. For example, do not claim support for bulk operations, sorting, ETags, or a filter grammar beyond the supported subset.

**Exit criteria:** contract tests confirm that discovery payloads are valid, protected, and consistent with enabled features.

### 4. Implement User Lifecycle

Implement the User collection and resource endpoints:

- `GET /Users` with pagination and `userName eq "value"` filtering.
- `POST /Users` with uniqueness validation and a `Location` header.
- `GET /Users/{id}`.
- `PUT /Users/{id}` as full replacement.
- `PATCH /Users/{id}` for `replace`, `add`, and `remove` operations that are explicitly supported.
- `DELETE /Users/{id}` as permanent deletion for the demo.

Use one transaction per mutating request. Validate the complete patched resource before commit so a failing operation cannot leave partial state.

**Exit criteria:** unit and HTTP tests cover successful provisioning, duplicate user names, `active: false`, invalid patches, not-found responses, filters, and pagination.

### 5. Implement Group Lifecycle

Implement the Group collection and resource endpoints with `displayName` and `members`. Resolve group-member references to local users, reject malformed member values, and make an existing membership addition a no-op.

Decide and document the deletion rule before implementation: either reject deletion of a user who belongs to groups, or remove their memberships in the same transaction. The recommended demo behavior is cascading member removal with an audit record.

**Exit criteria:** tests prove membership add/remove behavior, idempotency, atomic patches, user deletion behavior, and valid group list responses.

### 6. Add Auditability and Inspection

Write an audit event for each SCIM request and response outcome. Redact bearer tokens and configurable sensitive attributes before persistence. Capture a correlation ID, timestamp, route, status, and before/after state for mutations.

Expose a development-only read API or UI showing:

- Current users and groups.
- Active versus inactive users.
- Request method, endpoint, status, timestamp, and correlation ID.
- Redacted raw SCIM payloads.
- Before-and-after resource state.

**Exit criteria:** a full lifecycle scenario is visible from one inspection screen without accessing the database directly.

### 7. Add the Client Simulator

Provide named, repeatable scenarios that send real HTTP requests in this order:

1. Create Alice and Bob.
2. Create `Engineering`.
3. Add Alice to `Engineering`.
4. Update Alice's department.
5. Disable and re-enable Alice.
6. Remove Alice from the group.
7. Delete Alice.

The simulator should print request IDs and expected status codes, accept a base URL and bearer token from environment variables, and have a cleanup mode. Add a Postman or Bruno collection only as a convenience layer; the scripted client is the reproducible source of truth.

**Exit criteria:** a new developer can run the full lifecycle flow against an empty local database without manually crafting requests.

### 8. Integrate Auth0 Login

Create an Auth0 Regular Web Application or Single-Page Application appropriate to the chosen demo-app architecture. Configure callback, logout, and allowed web-origin URLs for local development.

After OIDC login, the demo application resolves the user to the SCIM service and rejects access when the local resource is missing, deleted, or inactive. This check is required even if the optional Auth0 adapter is enabled.

Document how the demo associates an Auth0 subject with a SCIM user, preferably through a stable identifier rather than mutable email address.

**Exit criteria:** an authenticated active user can access the app and an authenticated inactive user receives a clear denial response.

### 9. Add the Optional Auth0 Management API Adapter

Implement an adapter interface and an Auth0-backed implementation that is disabled by default. On a relevant SCIM update, it may:

- Store `externalId` in Auth0 `app_metadata`.
- Copy department and employee number to approved metadata fields.
- Block the mapped Auth0 user when SCIM changes `active` to `false`.

Use least-privilege Management API scopes, retry only safe transient failures, and record adapter outcomes in the audit trail. Explicitly define the behavior when a corresponding Auth0 user does not exist; the recommended first behavior is to record a non-fatal sync result rather than auto-create an account.

**Exit criteria:** adapter tests cover successful mapping, absent users, Management API failures, and the disabled configuration path.

### 10. Validate with a Real IdP

After simulator coverage is stable, configure an Entra ID or Okta test tenant to call the public HTTPS endpoint. Compare its request sequence to the simulator traces and extend the supported filter or PATCH subset only when observed and required.

**Exit criteria:** the documented walkthrough completes against one real test tenant and any vendor-specific constraints are captured in `docs/idp-setup.md`.

## Protocol and Test Matrix

| Behavior | Expected result |
| --- | --- |
| Invalid or absent bearer token | `401` SCIM error response |
| Duplicate `userName` | `409` with `scimType: "uniqueness"` |
| Unknown user or group | `404` SCIM error response |
| Create resource | `201`, resource body, and `Location` header |
| List resources | Valid `ListResponse` with correct pagination fields |
| Supported filter | Correctly filtered `ListResponse` |
| Unsupported filter | Explicit SCIM error; never silently mis-filter |
| PATCH with one invalid operation | No mutation persists |
| Repeated group member add | No duplicate membership and successful no-op |
| Disable user | `active: false`, audit event, and application access denied |
| Delete user | Resource absent from later list and get responses |
| Discovery endpoint | Advertises only the implemented feature set |

## Security and Privacy Requirements

- Require HTTPS outside localhost.
- Keep the SCIM bearer token and Auth0 credentials in environment-specific secret storage.
- Redact `Authorization` headers and configured sensitive attributes from logs and audit records.
- Limit the inspection UI to local development or an authenticated administrative audience.
- Validate JSON content type, request size, IDs, pagination bounds, and all SCIM paths.
- Do not synchronize credentials or write them to audit data.

## Documentation Deliverables

Before the first real-IdP demo, add:

- `docs/auth0-setup.md`: tenant settings, local callback URLs, required claims, and Management API adapter setup.
- `docs/idp-setup.md`: Entra ID or Okta SCIM configuration, token entry, base URL, and observed compatibility notes.
- `.env.example`: non-secret configuration names and descriptions.
- `docs/demo-script.md`: the presenter walkthrough and expected observations.

## Definition of Done

The project is ready for a demo when a clean checkout can run the simulator end to end, display the resulting users/groups/audit trail, authenticate into the sample app through Auth0, deny a disabled user, and pass automated protocol-focused tests. A real test IdP is a follow-up validation milestone, not a prerequisite for the first usable demonstration.