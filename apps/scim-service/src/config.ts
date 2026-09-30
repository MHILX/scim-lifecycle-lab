import { BlockList, isIP } from "node:net";

import { z } from "zod";

import type { Auth0ManagementConfig } from "./auth0-adapter.js";

const logLevelSchema = z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);
const loopbackAddresses = new BlockList();
loopbackAddresses.addSubnet("127.0.0.0", 8, "ipv4");
loopbackAddresses.addAddress("::1", "ipv6");

export function isLoopbackHost(host: string): boolean {
  const family = isIP(host);
  return (
    host.toLowerCase() === "localhost" ||
    (family !== 0 && loopbackAddresses.check(host, family === 4 ? "ipv4" : "ipv6"))
  );
}

const environmentSchema = z.object({
  SCIM_HOST: z.string().min(1).default("127.0.0.1"),
  SCIM_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  SCIM_DATABASE_PATH: z.string().min(1).default("./data/scim-lifecycle-lab.sqlite"),
  SCIM_BEARER_TOKEN: z.string().min(16, "SCIM_BEARER_TOKEN must be at least 16 characters."),
  SCIM_ENFORCE_HTTPS: z.enum(["true", "false"]).optional(),
  SCIM_TRUST_PROXY: z.string().default(""),
  SCIM_LOG_LEVEL: logLevelSchema.default("info"),
  SCIM_ENABLE_INSPECTION: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  SCIM_AUDIT_REDACT_ATTRIBUTES: z.string().default("password,token,secret,authorization"),
  AUTH0_SYNC_ENABLED: z.enum(["true", "false"]).default("false"),
  AUTH0_MANAGEMENT_DOMAIN: z.string().optional(),
  AUTH0_MANAGEMENT_CLIENT_ID: z.string().optional(),
  AUTH0_MANAGEMENT_CLIENT_SECRET: z.string().optional()
});

const auth0ManagementSchema = z.object({
  domain: z.string().trim().regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i),
  clientId: z.string().trim().min(1),
  clientSecret: z.string().min(1)
});

export interface ScimServiceConfig {
  host: string;
  port: number;
  databasePath: string;
  bearerToken: string;
  enforceHttps: boolean;
  trustedProxies: string[];
  logLevel: z.infer<typeof logLevelSchema>;
  enableInspection: boolean;
  auditRedactAttributes: string[];
  auth0Management?: Auth0ManagementConfig;
}

export function loadServiceConfig(environment: NodeJS.ProcessEnv = process.env): ScimServiceConfig {
  const parsed = environmentSchema.safeParse(environment);

  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => issue.message).join(" ");
    throw new Error(`Invalid SCIM service configuration: ${details}`);
  }

  const localHost = isLoopbackHost(parsed.data.SCIM_HOST);
  const enforceHttps = parsed.data.SCIM_ENFORCE_HTTPS === undefined
    ? !localHost
    : parsed.data.SCIM_ENFORCE_HTTPS === "true";

  if (!localHost && !enforceHttps) {
    throw new Error("SCIM_ENFORCE_HTTPS cannot be disabled when SCIM_HOST is not a loopback address.");
  }

  let auth0Management: Auth0ManagementConfig | undefined;
  if (parsed.data.AUTH0_SYNC_ENABLED === "true") {
    const management = auth0ManagementSchema.safeParse({
      domain: parsed.data.AUTH0_MANAGEMENT_DOMAIN,
      clientId: parsed.data.AUTH0_MANAGEMENT_CLIENT_ID,
      clientSecret: parsed.data.AUTH0_MANAGEMENT_CLIENT_SECRET
    });
    if (!management.success) {
      throw new Error("Enabling Auth0 sync requires a valid AUTH0_MANAGEMENT_DOMAIN, CLIENT_ID, and CLIENT_SECRET.");
    }
    auth0Management = management.data;
  }

  return {
    host: parsed.data.SCIM_HOST,
    port: parsed.data.SCIM_PORT,
    databasePath: parsed.data.SCIM_DATABASE_PATH,
    bearerToken: parsed.data.SCIM_BEARER_TOKEN,
    enforceHttps,
    trustedProxies: parsed.data.SCIM_TRUST_PROXY.split(",")
      .map((address) => address.trim())
      .filter((address) => address.length > 0),
    logLevel: parsed.data.SCIM_LOG_LEVEL,
    enableInspection: parsed.data.SCIM_ENABLE_INSPECTION,
    auditRedactAttributes: parsed.data.SCIM_AUDIT_REDACT_ATTRIBUTES.split(",")
      .map((attribute) => attribute.trim())
      .filter((attribute) => attribute.length > 0),
    ...(auth0Management === undefined ? {} : { auth0Management })
  };
}
