/**
 * Server configuration read from the environment. Validated once at startup so a misconfigured
 * deployment fails immediately instead of on the first request.
 */

export type ServerConfig = {
  port: number;
  host: string;
  apiKey: string;
  corsOrigins: string[];
  serviceModule: string;
};

const DEFAULT_PORT = 3334;
const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_SERVICE_MODULE = './dist/vintasend-templates.config.js';

function splitList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const errors: string[] = [];

  const apiKey = env.MANAGED_TEMPLATE_API_KEY?.trim();
  if (!apiKey) {
    errors.push('MANAGED_TEMPLATE_API_KEY is required');
  }

  const port = Number(env.PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port <= 0) {
    errors.push('PORT must be a positive integer');
  }

  if (errors.length > 0) {
    throw new Error(`Invalid API configuration:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  }

  return {
    port,
    host: env.HOST?.trim() || DEFAULT_HOST,
    apiKey: apiKey as string,
    corsOrigins: splitList(env.MANAGED_TEMPLATE_API_CORS_ORIGINS),
    serviceModule: env.MANAGED_TEMPLATE_SERVICE_MODULE?.trim() || DEFAULT_SERVICE_MODULE,
  };
}
