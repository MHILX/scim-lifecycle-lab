import { ManagementClient } from "auth0";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Auth0LifecycleAdapter, createAuth0LifecycleAdapter, type LifecycleUser } from "../src/auth0-adapter.js";
import { loadServiceConfig } from "../src/config.js";

const alice: LifecycleUser = {
  externalId: "auth0|alice-001",
  department: "Engineering",
  employeeNumber: "E-001",
  active: false
};

function createAdapter(): Auth0LifecycleAdapter {
  const management = new ManagementClient({ domain: "tenant.example.test", token: "non-secret-test-token" });
  return new Auth0LifecycleAdapter(management.users);
}

describe("optional Auth0 lifecycle adapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps the stable subject, copies approved metadata, and blocks or re-enables the account", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ user_id: alice.externalId }));
    vi.stubGlobal("fetch", fetchMock);
    const adapter = createAdapter();

    expect(await adapter.syncUser(alice, "sync-disabled-001")).toEqual({ adapter: "auth0", status: "synced" });
    expect(await adapter.syncUser({ ...alice, active: true }, "sync-enabled-001")).toEqual({
      adapter: "auth0", status: "synced"
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, request] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://tenant.example.test/api/v2/users/auth0%7Calice-001");
    expect(request?.method).toBe("PATCH");
    expect(JSON.parse(request?.body as string)).toEqual({
      blocked: true,
      app_metadata: { externalId: alice.externalId, department: "Engineering", employeeNumber: "E-001" }
    });
    expect(new Headers(request?.headers).get("x-correlation-id")).toBe("sync-disabled-001");
    expect(JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string).blocked).toBe(false);
  });

  it("does not call Auth0 when there is no stable mapping", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    expect(await createAdapter().syncUser({ ...alice, externalId: null }, "unmapped")).toEqual({
      adapter: "auth0", status: "not_mapped"
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("records an absent account without retrying or creating one", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ message: "Not found" }, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await createAdapter().syncUser(alice, "missing")).toEqual({
      adapter: "auth0", status: "not_found", httpStatus: 404
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry authorization failures or expose raw API errors", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ message: "sensitive-error-sentinel" }, { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await createAdapter().syncUser(alice, "rejected")).toEqual({
      adapter: "auth0", status: "failed", httpStatus: 403
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a transient failure only for the idempotent absolute update", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ message: "Unavailable" }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ user_id: alice.externalId }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await createAdapter().syncUser(alice, "retry")).toEqual({ adapter: "auth0", status: "synced" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(fetchMock.mock.calls[1]?.[1]?.body);
  });

  it("caps transient retries and records an exhausted failure", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ message: "Unavailable" }, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await createAdapter().syncUser(alice, "exhausted")).toEqual({
      adapter: "auth0", status: "failed", httpStatus: 503
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("sanitizes network failures", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("private-network-error-sentinel"));
    vi.stubGlobal("fetch", fetchMock);
    expect(await createAdapter().syncUser(alice, "network-failure")).toEqual({ adapter: "auth0", status: "failed" });
  });

  it("serializes updates for one subject so re-enablement cannot overtake disabling", async () => {
    let finishFirst: (response: Response) => void = () => {};
    let notifyStarted: () => void = () => {};
    const firstResponse = new Promise<Response>((resolve) => { finishFirst = resolve; });
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    const fetchMock = vi.fn<typeof fetch>()
      .mockImplementationOnce(async () => { notifyStarted(); return firstResponse; })
      .mockImplementation(async () => Response.json({ user_id: alice.externalId }));
    vi.stubGlobal("fetch", fetchMock);
    const adapter = createAdapter();
    const disabling = adapter.syncUser(alice, "ordered-disable");
    const enabling = adapter.syncUser({ ...alice, active: true }, "ordered-enable");
    await started;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    finishFirst(Response.json({ user_id: alice.externalId }));
    expect(await Promise.all([disabling, enabling])).toEqual([
      { adapter: "auth0", status: "synced" }, { adapter: "auth0", status: "synced" }
    ]);
    expect(fetchMock.mock.calls.map(([, request]) => JSON.parse(request?.body as string).blocked)).toEqual([true, false]);
  });

  it("obtains and caches a Management API token with client credentials", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      return String(input).endsWith("/oauth/token")
        ? Response.json({ access_token: "non-secret-test-token", token_type: "Bearer", expires_in: 3600 })
        : Response.json({ user_id: alice.externalId });
    });
    vi.stubGlobal("fetch", fetchMock);
    const adapter = createAuth0LifecycleAdapter({
      domain: "tenant.example.test", clientId: "test-client", clientSecret: "non-secret-test-client-secret"
    });
    expect(await adapter?.syncUser(alice, "token-first")).toEqual({ adapter: "auth0", status: "synced" });
    expect(await adapter?.syncUser(alice, "token-second")).toEqual({ adapter: "auth0", status: "synced" });
    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/oauth/token"))).toHaveLength(1);
  });

  it("keeps the factory disabled by default without network access", () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    expect(createAuth0LifecycleAdapter()).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("only requires Management API credentials when the adapter is enabled", () => {
    const environment = { SCIM_BEARER_TOKEN: "local-development-token" };
    expect(loadServiceConfig(environment).auth0Management).toBeUndefined();
    expect(() => loadServiceConfig({ ...environment, AUTH0_SYNC_ENABLED: "true" })).toThrow("Enabling Auth0 sync");
    expect(loadServiceConfig({
      ...environment,
      AUTH0_SYNC_ENABLED: "true",
      AUTH0_MANAGEMENT_DOMAIN: "tenant.example.test",
      AUTH0_MANAGEMENT_CLIENT_ID: "test-client",
      AUTH0_MANAGEMENT_CLIENT_SECRET: "non-secret-test-client-secret"
    }).auth0Management).toEqual({
      domain: "tenant.example.test", clientId: "test-client", clientSecret: "non-secret-test-client-secret"
    });
    expect(() => loadServiceConfig({
      ...environment,
      AUTH0_SYNC_ENABLED: "true",
      AUTH0_MANAGEMENT_DOMAIN: "https://tenant.example.test",
      AUTH0_MANAGEMENT_CLIENT_ID: "test-client",
      AUTH0_MANAGEMENT_CLIENT_SECRET: "non-secret-test-client-secret"
    })).toThrow("Enabling Auth0 sync");
  });
});