/**
 * Every path and method `openapi.yaml` declares is one this server routes.
 *
 * The contract is shared with the Python implementation and generated there, so this repository
 * satisfies the file rather than producing it — which means nothing here would otherwise notice a
 * route added on that side, renamed on this one, or spelled with the wrong verb. This walks the
 * declarations and calls each one with a plausible request.
 *
 * What it asserts is narrow on purpose: that the server *routed* the request. A handler answering
 * 404 for a template that does not exist is a route working correctly; the app's own not-found
 * handler answering "No route matches …" is not. The behaviour behind each route is pinned by the
 * other suites.
 *
 * The parse is a small scan rather than a YAML library: the shape it reads — a `paths:` block of
 * two-space-indented paths, each with four-space-indented methods — is fixed by the generator, and
 * a dependency for four lines of it would be the larger cost.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { createHarness, createInput, type Harness } from './helpers/fixtures.js';

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

type Operation = { method: (typeof HTTP_METHODS)[number]; path: string };

function declaredOperations(): Operation[] {
  const yaml = readFileSync(
    fileURLToPath(new URL('../openapi.yaml', import.meta.url)),
    'utf8',
  ).split('\n');

  const operations: Operation[] = [];
  let inPaths = false;
  let currentPath: string | null = null;

  for (const line of yaml) {
    if (line === 'paths:') {
      inPaths = true;
      continue;
    }
    if (!inPaths) {
      continue;
    }
    // A top-level key ends the paths block.
    if (/^\S/.test(line)) {
      break;
    }

    const pathMatch = /^ {2}(\/\S*):\s*$/.exec(line);
    if (pathMatch) {
      currentPath = pathMatch[1] as string;
      continue;
    }

    const methodMatch = /^ {4}([a-z]+):\s*$/.exec(line);
    if (methodMatch && currentPath !== null) {
      const method = methodMatch[1] as string;
      if ((HTTP_METHODS as readonly string[]).includes(method)) {
        operations.push({ method: method as Operation['method'], path: currentPath });
      }
    }
  }

  return operations;
}

/** Fill `{key}` / `{version}` / `{slug}` with values the fixture store actually holds. */
function concretePath(path: string): string {
  return path.replace('{key}', 'welcome').replace('{version}', '1').replace('{slug}', 'onboarding');
}

/** A body each write route will accept, so a 400 never masks a missing route. */
const BODIES: Record<string, unknown> = {
  'post /api/v1/templates': {
    key: 'another',
    name: 'Another',
    templateManagedBackend: 'in-memory',
    bodyTemplate: 'x',
  },
  'post /api/v1/templates/{key}/versions': {},
  'post /api/v1/templates/{key}/status': { status: 'active' },
  'post /api/v1/templates/{key}/activate': {},
  'post /api/v1/templates/{key}/deactivate': {},
  'post /api/v1/templates/{key}/archive': {},
  'post /api/v1/templates/{key}/preview': {},
  'put /api/v1/templates/{key}/tags': { tags: [] },
  'post /api/v1/tags': { text: 'brand new tag' },
  'patch /api/v1/tags/{slug}': { text: 'renamed' },
};

async function seed(api: Harness): Promise<void> {
  await api.service.createTemplate(createInput('welcome', { tags: ['onboarding'] }));
}

describe('openapi.yaml', () => {
  it('declares the endpoints this repository is expected to serve', () => {
    const operations = declaredOperations();

    expect(operations.length).toBeGreaterThan(20);
    expect(operations).toContainEqual({ method: 'get', path: '/health' });
    expect(operations).toContainEqual({ method: 'get', path: '/api/v1/capabilities' });
    expect(operations).toContainEqual({ method: 'delete', path: '/api/v1/tags/{slug}' });
  });

  it.each(declaredOperations())('routes $method $path', async ({ method, path }) => {
    const api = createHarness();
    await seed(api);

    const body = BODIES[`${method} ${path}`];
    const response = await api.request(concretePath(path), {
      method: method.toUpperCase(),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    // 404 is a legitimate answer from a handler; "no route matches" is not.
    if (response.status === 404) {
      const payload = (await response.json()) as { error: { message: string } };
      expect(payload.error.message).not.toMatch(/No route matches/);
    }

    expect(response.status).toBeLessThan(500);
  });
});
