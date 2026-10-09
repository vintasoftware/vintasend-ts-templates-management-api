#!/usr/bin/env node
/**
 * Server entrypoint: wires environment configuration into the app and listens.
 *
 * Installed as the package's `vintasend-templates-management-api` command, for running the API on
 * its own. A host that already has a server mounts `createApp` instead and never loads this file.
 */

import { createApp } from './app.js';
import { apiKeyAuthenticator } from './middleware/authenticate.js';
import { createServiceProvider, loadServerConfig } from './server.js';

/**
 * `@hono/node-server`, which only this command uses. It is an optional peer dependency, so a host
 * that mounts `createApp` in its own server does not install it.
 */
async function loadNodeServer(): Promise<typeof import('@hono/node-server')> {
  try {
    return await import('@hono/node-server');
  } catch (error) {
    const { code, message } = error as { code?: string; message?: string };
    if (code === 'ERR_MODULE_NOT_FOUND' && message?.includes("'@hono/node-server'")) {
      throw new Error(
        'The standalone server needs @hono/node-server: npm install @hono/node-server',
      );
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const config = loadServerConfig();
  const { serve } = await loadNodeServer();
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
