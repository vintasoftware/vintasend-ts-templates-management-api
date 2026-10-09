#!/usr/bin/env node
/**
 * Server entrypoint: wires environment configuration into the app and listens.
 *
 * Installed as the package's `vintasend-templates-management-api` command, for running the API on
 * its own. A host that already has a server mounts `createApp` instead and never loads this file.
 */

import { serve } from '@hono/node-server';

import { createApp } from './app.js';
import { loadServerConfig } from './config.js';
import { apiKeyAuthenticator } from './middleware/authenticate.js';
import { createServiceProvider } from './services/service-loader.js';

async function main(): Promise<void> {
  const config = loadServerConfig();
  const getService = createServiceProvider(config.serviceModule);

  const app = createApp({
    authenticate: apiKeyAuthenticator(config.apiKey),
    getService,
    corsOrigins: config.corsOrigins,
  });

  // Fail fast on a broken service module instead of surfacing it per request.
  await getService();

  serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
    console.info(`[vintasend-templates-api] listening on http://${config.host}:${info.port}`);
  });
}

main().catch((error) => {
  console.error('[vintasend-templates-api] failed to start', error);
  process.exit(1);
});
