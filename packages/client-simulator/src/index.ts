import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { SCIM_CONTENT_TYPE, SCIM_ENTERPRISE_USER_SCHEMA, SCIM_PATCH_OP_SCHEMA, SCIM_USER_SCHEMA } from "@scim-lifecycle-lab/scim-contract";

type Scenario = "lifecycle" | "provision" | "disable" | "enable" | "cleanup";

interface ScimResource {
  id: string;
  [attribute: string]: unknown;
}

interface ScimListResponse<Resource extends ScimResource> {
  totalResults: number;
  Resources: Resource[];
}

interface SimulatorConfig {
  baseUrl: string;
  bearerToken: string;
  auth0Subject?: string;
}

const aliceUserName = "alice@example.test";
const bobUserName = "bob@example.test";
const engineeringDisplayName = "Engineering";

function loadConfig(): SimulatorConfig {
  const environmentFile = existsSync(".env") ? ".env" : new URL("../../../.env", import.meta.url);

  if (existsSync(environmentFile)) {
    process.loadEnvFile(environmentFile);
  }

  const bearerToken = process.env.SCIM_BEARER_TOKEN;
  const auth0Subject = process.env.SCIM_AUTH0_SUBJECT?.trim();

  if (bearerToken === undefined || bearerToken.length === 0) {
    throw new Error("SCIM_BEARER_TOKEN is required to run the client simulator.");
  }

  return {
    baseUrl: (process.env.SCIM_BASE_URL ?? "http://127.0.0.1:3000").replace(/\/$/, ""),
    bearerToken,
    ...(auth0Subject === undefined || auth0Subject.length === 0 ? {} : { auth0Subject })
  };
}

function parseScenario(argument: string | undefined): Scenario {
  if (argument === undefined || argument === "lifecycle") {
    return "lifecycle";
  }

  if (argument === "provision" || argument === "disable" || argument === "enable" || argument === "cleanup") {
    return argument;
  }

  throw new Error(
    "Usage: npm run simulate:lifecycle, npm run simulate:provision, npm run simulate:disable, npm run simulate:enable, or npm run simulate:cleanup"
  );
}

function escapeFilterValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

async function request<Resource>(
  config: SimulatorConfig,
  label: string,
  method: string,
  path: string,
  expectedStatus: number,
  body?: unknown
): Promise<Resource> {
  const correlationId = `sim-${randomUUID()}`;
  const response = await fetch(`${config.baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${config.bearerToken}`,
      "x-correlation-id": correlationId,
      ...(body === undefined ? {} : { "content-type": SCIM_CONTENT_TYPE })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const responseText = await response.text();

  console.log(`${label}: ${method} ${path} requestId=${correlationId} expected=${expectedStatus} actual=${response.status}`);

  if (response.status !== expectedStatus) {
    throw new Error(
      `${label} failed. Expected HTTP ${expectedStatus}, received ${response.status}. Response: ${responseText}`
    );
  }

  if (responseText.length === 0) {
    return undefined as Resource;
  }

  return JSON.parse(responseText) as Resource;
}

async function listByFilter(
  config: SimulatorConfig,
  resourceType: "Users" | "Groups",
  attribute: "userName" | "displayName",
  value: string
): Promise<ScimResource[]> {
  const filter = `${attribute} eq "${escapeFilterValue(value)}"`;
  const encodedFilter = encodeURIComponent(filter);
  const response = await request<ScimListResponse<ScimResource>>(
    config,
    `Find ${value}`,
    "GET",
    `/${resourceType}?filter=${encodedFilter}`,
    200
  );

  return response.Resources;
}

async function cleanup(config: SimulatorConfig): Promise<void> {
  for (const group of await listByFilter(config, "Groups", "displayName", engineeringDisplayName)) {
    await request<void>(config, "Delete Engineering", "DELETE", `/Groups/${group.id}`, 204);
  }

  for (const userName of [aliceUserName, bobUserName]) {
    for (const user of await listByFilter(config, "Users", "userName", userName)) {
      await request<void>(config, `Delete ${userName}`, "DELETE", `/Users/${user.id}`, 204);
    }
  }
}

interface ProvisionedResources {
  alice: ScimResource;
  engineering: ScimResource;
}

async function provisionResources(config: SimulatorConfig): Promise<ProvisionedResources> {
  await cleanup(config);

  const alice = await request<ScimResource>(config, "Create Alice", "POST", "/Users", 201, {
    schemas: [SCIM_USER_SCHEMA, SCIM_ENTERPRISE_USER_SCHEMA],
    externalId: config.auth0Subject ?? "simulator-alice-001",
    userName: aliceUserName,
    name: { givenName: "Alice", familyName: "Example" },
    displayName: "Alice Example",
    active: true,
    [SCIM_ENTERPRISE_USER_SCHEMA]: { department: "Operations", employeeNumber: "E-001" }
  });
  await request<ScimResource>(config, "Create Bob", "POST", "/Users", 201, {
    schemas: [SCIM_USER_SCHEMA, SCIM_ENTERPRISE_USER_SCHEMA],
    externalId: "simulator-bob-002",
    userName: bobUserName,
    name: { givenName: "Bob", familyName: "Example" },
    displayName: "Bob Example",
    active: true,
    [SCIM_ENTERPRISE_USER_SCHEMA]: { department: "Engineering", employeeNumber: "E-002" }
  });
  const engineering = await request<ScimResource>(config, "Create Engineering", "POST", "/Groups", 201, {
    displayName: engineeringDisplayName
  });

  await request<ScimResource>(config, "Add Alice to Engineering", "PATCH", `/Groups/${engineering.id}`, 200, {
    schemas: [SCIM_PATCH_OP_SCHEMA],
    Operations: [{ op: "add", path: "members", value: [{ value: alice.id }] }]
  });
  await request<ScimResource>(config, "Update Alice department", "PATCH", `/Users/${alice.id}`, 200, {
    schemas: [SCIM_PATCH_OP_SCHEMA],
    Operations: [
      {
        op: "replace",
        path: `${SCIM_ENTERPRISE_USER_SCHEMA}:department`,
        value: "Engineering"
      }
    ]
  });

  return { alice, engineering };
}

async function findAlice(config: SimulatorConfig): Promise<ScimResource> {
  const users = await listByFilter(config, "Users", "userName", aliceUserName);

  if (users.length !== 1) {
    throw new Error(`Expected exactly one Alice resource, found ${users.length}. Run npm run simulate:provision first.`);
  }

  const alice = users[0];

  if (alice === undefined) {
    throw new Error("Alice resource was not found. Run npm run simulate:provision first.");
  }

  return alice;
}

async function setAliceActive(config: SimulatorConfig, active: boolean): Promise<void> {
  const alice = await findAlice(config);
  await request<ScimResource>(config, active ? "Enable Alice" : "Disable Alice", "PATCH", `/Users/${alice.id}`, 200, {
    schemas: [SCIM_PATCH_OP_SCHEMA],
    Operations: [{ op: "replace", path: "active", value: active }]
  });
}

async function runLifecycle(config: SimulatorConfig): Promise<void> {
  const { alice, engineering } = await provisionResources(config);
  await setAliceActive(config, false);
  await setAliceActive(config, true);
  await request<ScimResource>(config, "Remove Alice from Engineering", "PATCH", `/Groups/${engineering.id}`, 200, {
    schemas: [SCIM_PATCH_OP_SCHEMA],
    Operations: [{ op: "remove", path: "members", value: [{ value: alice.id }] }]
  });
  await request<void>(config, "Delete Alice", "DELETE", `/Users/${alice.id}`, 204);
}

async function main(): Promise<void> {
  const scenario = parseScenario(process.argv[2]);
  const config = loadConfig();

  if (scenario === "cleanup") {
    await cleanup(config);
    console.log("Cleanup complete.");
    return;
  }

  if (scenario === "provision") {
    await provisionResources(config);
    console.log("Provisioning scenario complete.");
    return;
  }

  if (scenario === "disable") {
    await setAliceActive(config, false);
    console.log("Alice is inactive.");
    return;
  }

  if (scenario === "enable") {
    await setAliceActive(config, true);
    console.log("Alice is active.");
    return;
  }

  await runLifecycle(config);
  console.log("Lifecycle scenario complete.");
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});