/**
 * What `openapi.yaml` declares, read the way the tests need it.
 *
 * The parse is a small scan rather than a YAML library: the shape it reads — a `paths:` block of
 * two-space-indented paths, each with four-space-indented methods whose `responses:` list
 * eight-space-indented quoted status codes — is fixed by the generator, and a dependency for a few
 * lines of it would be the larger cost.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

export type Operation = {
  method: (typeof HTTP_METHODS)[number];
  path: string;
  /** The status codes the operation declares, as the YAML spells them (`'200'`, `'404'`). */
  statuses: string[];
};

export function readOpenApi(): string[] {
  return readFileSync(fileURLToPath(new URL('../../openapi.yaml', import.meta.url)), 'utf8').split(
    '\n',
  );
}

export function declaredOperations(): Operation[] {
  const operations: Operation[] = [];
  let inPaths = false;
  let currentPath: string | null = null;
  let current: Operation | null = null;
  let inResponses = false;

  for (const line of readOpenApi()) {
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
      current = null;
      continue;
    }

    const methodMatch = /^ {4}([a-z]+):\s*$/.exec(line);
    if (methodMatch && currentPath !== null) {
      const method = methodMatch[1] as string;
      current = null;
      if ((HTTP_METHODS as readonly string[]).includes(method)) {
        current = { method: method as Operation['method'], path: currentPath, statuses: [] };
        operations.push(current);
      }
      continue;
    }

    if (/^ {6}\S/.test(line)) {
      inResponses = line.trim() === 'responses:';
      continue;
    }

    const statusMatch = /^ {8}'(\d{3})':\s*$/.exec(line);
    if (statusMatch && inResponses && current !== null) {
      current.statuses.push(statusMatch[1] as string);
    }
  }

  return operations;
}

let cache: Operation[] | undefined;

/** The operation a concrete request path and method belong to, preferring literal segments. */
export function operationFor(method: string, url: string): Operation | undefined {
  cache ??= declaredOperations();
  const segments = new URL(url, 'http://localhost').pathname.split('/');

  const candidates = cache.filter((operation) => {
    const template = operation.path.split('/');
    return (
      operation.method === method.toLowerCase() &&
      template.length === segments.length &&
      template.every((part, index) => part.startsWith('{') || part === segments[index])
    );
  });

  const literals = (operation: Operation) =>
    operation.path.split('/').filter((part) => !part.startsWith('{')).length;
  return candidates.sort((a, b) => literals(b) - literals(a))[0];
}

/**
 * Why `status` breaks the contract for this request, or `undefined` if it does not.
 *
 * Only client errors are checked. A 500 is the generic answer to anything unexpected and is
 * documented once, not per route, and a request no operation names is not the contract's.
 */
export function undeclaredStatus(method: string, url: string, status: number): string | undefined {
  if (status < 400 || status >= 500) {
    return undefined;
  }
  const operation = operationFor(method, url);
  if (operation === undefined || operation.statuses.includes(String(status))) {
    return undefined;
  }
  return (
    `${method.toUpperCase()} ${operation.path} answered ${status}, which it does not declare ` +
    `(${operation.statuses.join(', ')})`
  );
}
