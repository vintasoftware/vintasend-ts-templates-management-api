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
import {
  MANAGED_TEMPLATE_ORDER_BY_FIELDS,
  orderByCapabilityKey,
} from 'vintasend-managed-templates';
import { describe, expect, it } from 'vitest';

import {
  templateOrderByDirectionSchema,
  templateOrderByFieldSchema,
} from '../src/domain/schemas.js';
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

/**
 * The ordering vocabulary, pinned in three places at once.
 *
 * `openapi.yaml` is shared with the Python implementation and is the thing that must not drift.
 * These check that the spec, the zod schema this server validates with, and the library's own
 * list of orderable fields all name the same set — so a field added to one of them and forgotten
 * in the others fails here rather than in a client.
 */
describe('the ordering vocabulary', () => {
  /** The enum a query parameter declares in `openapi.yaml`, read without a YAML parser. */
  function declaredEnum(parameterName: string): string[] {
    const yaml = readFileSync(
      fileURLToPath(new URL('../openapi.yaml', import.meta.url)),
      'utf8',
    ).split('\n');

    const start = yaml.findIndex((line) => line.trim() === `name: ${parameterName}`);
    expect(start, `${parameterName} is not declared in openapi.yaml`).toBeGreaterThan(-1);

    const values: string[] = [];
    let inEnum = false;
    for (const line of yaml.slice(start + 1)) {
      const trimmed = line.trim();
      // `anyOf` puts the enum in a list item, so it arrives as `- enum:` rather than `enum:`.
      if (trimmed === 'enum:' || trimmed === '- enum:') {
        inEnum = true;
        continue;
      }
      if (inEnum) {
        if (trimmed.startsWith('- ')) {
          values.push(trimmed.slice(2));
          continue;
        }
        break;
      }
      // Another parameter began before any enum did.
      if (trimmed.startsWith('name: ')) break;
    }
    return values;
  }

  it('declares the same orderable fields in the spec, the schema and the library', () => {
    const inSpec = declaredEnum('orderByField').sort();
    const inSchema = [...templateOrderByFieldSchema.options].sort();
    const inLibrary = [...MANAGED_TEMPLATE_ORDER_BY_FIELDS].sort();

    expect(inSpec).toEqual(inSchema);
    expect(inSpec).toEqual(inLibrary);
  });

  it('declares the same directions in the spec and the schema', () => {
    expect(declaredEnum('orderByDirection').sort()).toEqual(
      [...templateOrderByDirectionSchema.options].sort(),
    );
  });

  it('publishes a capability key for every field the spec accepts', () => {
    // A field the API will accept but the capability report never mentions is one a client
    // cannot discover, and one that falls to the false default and always 400s.
    const api = createHarness({
      capabilities: Object.fromEntries(
        MANAGED_TEMPLATE_ORDER_BY_FIELDS.map((field) => [orderByCapabilityKey(field), true]),
      ),
    });

    const published = api.service.getBackendSupportedFilterCapabilities();

    for (const field of declaredEnum('orderByField')) {
      expect(published).toHaveProperty(`orderBy.${field}`);
    }
  });
});
