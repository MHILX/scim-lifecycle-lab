import { z } from "zod";

const logLevelSchema = z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);

const environmentSchema = z.object({
  SCIM_HOST: z.string().min(1).default("127.0.0.1"),
  SCIM_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  SCIM_DATABASE_PATH: z.string().min(1).default("./data/scim-lifecycle-lab.sqlite"),
  SCIM_BEARER_TOKEN: z.string().min(16, "SCIM_BEARER_TOKEN must be at least 16 characters."),
  SCIM_ENFORCE_HTTPS: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  SCIM_LOG_LEVEL: logLevelSchema.default("info"),
  SCIM_ENABLE_INSPECTION: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  SCIM_AUDIT_REDACT_ATTRIBUTES: z.string().default("password,token,secret,authorization")
});

export interface ScimServiceConfig {
  host: string;
  port: number;
  databasePath: string;
  bearerToken: string;
  enforceHttps: boolean;
  logLevel: z.infer<typeof logLevelSchema>;
  enableInspection: boolean;
  auditRedactAttributes: string[];
}

export function loadServiceConfig(environment: NodeJS.ProcessEnv = process.env): ScimServiceConfig {
  const parsed = environmentSchema.safeParse(environment);

  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => issue.message).join(" ");
    throw new Error(`Invalid SCIM service configuration: ${details}`);
  }

  return {
    host: parsed.data.SCIM_HOST,
    port: parsed.data.SCIM_PORT,
    databasePath: parsed.data.SCIM_DATABASE_PATH,
    bearerToken: parsed.data.SCIM_BEARER_TOKEN,
    enforceHttps: parsed.data.SCIM_ENFORCE_HTTPS,
    logLevel: parsed.data.SCIM_LOG_LEVEL,
    enableInspection: parsed.data.SCIM_ENABLE_INSPECTION,
    auditRedactAttributes: parsed.data.SCIM_AUDIT_REDACT_ATTRIBUTES.split(",")
      .map((attribute) => attribute.trim())
      .filter((attribute) => attribute.length > 0)
  };
}
