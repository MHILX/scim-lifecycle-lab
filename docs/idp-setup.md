# Real IdP Setup

## Validation Status

This is a readiness walkthrough for a disposable Microsoft Entra ID test tenant. No live Entra ID or Okta tenant has been validated by the checked-in tests. Local tests prove the documented protocol subset and simulator, not vendor compatibility. Record the actual provisioning sequence and any required changes before claiming phase 10 complete.

## Public HTTPS Endpoint

Build and migrate using the [Quick Start](../README.md#quick-start), then expose the SCIM service through a TLS-terminating reverse proxy. Use a public base URL such as `https://scim-lab.example.test`; the service routes are rooted at `/Users`, `/Groups`, and the discovery endpoints. Do not add `/scim/v2` unless your proxy explicitly rewrites that prefix.

For a proxy running on the same machine:

```dotenv
SCIM_HOST=127.0.0.1
SCIM_ENFORCE_HTTPS=true
SCIM_TRUST_PROXY=127.0.0.1,::1
SCIM_ENABLE_INSPECTION=false
```

Use a real, trusted HTTPS certificate and an environment-specific random SCIM token. A public listener must enforce HTTPS; only explicitly configured proxy IPs/CIDRs may supply forwarded headers. Configure the proxy to overwrite client-supplied forwarding headers and preserve the public host/protocol. Prevent direct external access to the backend HTTP port. Keep the token out of screenshots, provisioning traces, tickets, and committed files.

If inspection is needed during a supervised test, restrict it to an authenticated administrative audience or local proxy route and disable it again afterward. Do not expose a production directory to this lab or run simulator cleanup against vendor-owned test resources.

## Entra ID Configuration

1. In the Microsoft Entra admin center, create a non-gallery enterprise application for this lab using **Enterprise applications > New application > Create your own application**. Choose the option to integrate another application not in the gallery.
2. Under **Provisioning**, choose **Automatic**. In **Admin Credentials**, set **Tenant URL** to your HTTPS SCIM base URL and enter the SCIM bearer token in **Secret Token**. Enter the secret directly in the portal, not through an assistant or a checked-in command.
3. Use **Test Connection** and confirm that the authenticated User lookup returns a valid empty or populated SCIM ListResponse. Compare failed checks with the service's redacted audit events.
4. Start with **Sync only assigned users and groups**, assign only disposable test users, and leave Group provisioning disabled until the User flow is verified.
5. Reduce User attribute mappings to the implemented fields below. Disable mappings for unsupported attributes; unknown attributes are deliberately rejected rather than silently dropped.
6. Use **Provision on demand** for one assigned user before enabling periodic provisioning. Record create, profile update, disable, re-enable, and unassignment/deletion behavior from provisioning logs and audit correlation IDs.
7. Enable Group provisioning for a disposable group. Record membership create/add/remove, replacement, and deletion requests. Only extend filter/PATCH support when the observed requests require it, then add regression tests for those exact shapes.

## Minimal Attribute Mappings

| Entra source | SCIM target | Notes |
| --- | --- | --- |
| `userPrincipalName` | `userName` | Use this as the matching attribute, priority 1; only equality matching is supported. |
| `objectId` | `externalId` | Stable identifier for a SCIM-only test; see the Auth0 binding caveat below. |
| `displayName` | `displayName` | Optional profile field. |
| `givenName` | `name.givenName` | Optional profile field. |
| `surname` | `name.familyName` | Optional profile field. |
| Default active/not-deleted expression | `active` | Must result in a JSON boolean. |
| `department` | `urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department` | Optional enterprise extension. |
| `employeeId` | `urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:employeeNumber` | Optional enterprise extension. |

For Groups, map display name and local User member references only. Do not map passwords, credentials, arbitrary extension attributes, or Auth0 roles.

## Auth0 Binding

An Entra `objectId` is not an Auth0 `sub`. The SCIM-only provisioning walkthrough can use `objectId`, but the protected demo app and optional Management API adapter require `externalId` to equal the corresponding Auth0 User ID exactly.

For combined login/provisioning testing, use a per-user directory extension populated with each existing test account's Auth0 `sub` and map that extension to `externalId`. For a one-user-only trial, a Constant mapping containing that account's exact `sub` is sufficient. Never use one constant for multiple users: this service enforces unique `externalId` values. Avoid mutable email matching.

Keep `AUTH0_SYNC_ENABLED=false` while investigating the IdP request sequence. Enable it only after stable subject mapping is verified, using the separate M2M credentials described in [auth0-setup.md](auth0-setup.md#optional-management-api-adapter).

## Known Compatibility Constraints

These are implementation facts, not results observed from a live tenant:

| Request shape | Current behavior |
| --- | --- |
| `userName eq "value"`, `externalId eq "value"` | Supported User equality filters. |
| `displayName eq "value"` | Supported Group equality filter. |
| Other filters, sorting, bulk, conditional ETags | Not supported; explicit errors or unadvertised capabilities. |
| Mutation content type | Must be `application/scim+json`. A vendor using only `application/json` receives `415` until compatibility work is justified by a captured request. |
| User PATCH | Explicit supported attribute paths only; pathless operations are rejected. |
| Group member addition/removal | `path: "members"` with member value objects is supported; existing additions are no-ops. |
| Filtered member paths such as `members[value eq "id"]` | Not implemented. Capture any vendor use before extending the parser. |
| Member values | Must identify existing local UUID User resources. |
| Pagination | `startIndex >= 1`, `0 <= count <= 100`; invalid bounds are rejected. |
| Unsupported mapped attributes | Rejected with an explicit SCIM error. |
| User deletion | Permanent local deletion with cascading memberships; optional Auth0 sync blocks but never deletes the Auth0 account. |

If the vendor request subset exceeds these constraints, the walkthrough is not yet accepted. Do not label a partial provisioning run compatible.

## Validation Record

Complete this section after a supervised tenant run, keeping credentials and personal data out of the record:

| Evidence | Result |
| --- | --- |
| Date, test IdP, provisioning application type | Pending external validation. |
| Service revision and proxy configuration | Pending external validation. |
| Connection check and create/read responses | Pending external validation. |
| Profile update, disable, re-enable, delete | Pending external validation. |
| Group create/member add/member remove/delete | Pending external validation. |
| Auth0 active `200` / inactive `403` with same session | Pending external validation. |
| Redacted correlation IDs and required compatibility changes | Pending external validation. |

Phase 10 is complete only when the real request sequence succeeds, any necessary extensions have focused tests, and this record contains observed results.