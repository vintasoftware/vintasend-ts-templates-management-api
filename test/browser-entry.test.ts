/**
 * The package entry and `./testing` load in a browser.
 *
 * A host's UI runs the API in memory for its stories and tests, and a bundler that refuses Node
 * built-ins on a browser target (esbuild with `platform: 'browser'`) fails outright on one.
 *
 * `vintasend` and `vintasend-managed-templates` are peer dependencies: the host installs them, and
 * each tests its own entry the same way. Here they are stand-ins, so what is checked is this
 * package's own modules and the dependencies it brings.
 */

import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as vm from 'node:vm';
import { build, type Plugin } from 'esbuild';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ENTRIES = {
  'vintasend-templates-management-api': fileURLToPath(
    new URL('../src/exports.ts', import.meta.url),
  ),
  'vintasend-templates-management-api/testing': fileURLToPath(
    new URL('../src/testing.ts', import.meta.url),
  ),
};
const PEERS = ['vintasend', 'vintasend-managed-templates'];
const NODE_BUILTINS = new Set(builtinModules);

function isNodeBuiltin(specifier: string): boolean {
  return specifier.startsWith('node:') || NODE_BUILTINS.has(specifier.split('/')[0] as string);
}

/** Each peer becomes a module whose every export is an empty class. */
const peerStandIns: Plugin = {
  name: 'peer-stand-ins',
  setup(build) {
    build.onResolve({ filter: /^vintasend(-managed-templates)?$/ }, (args) => ({
      path: args.path,
      namespace: 'peer',
    }));
    build.onLoad({ filter: /.*/, namespace: 'peer' }, () => ({
      contents:
        'module.exports = new Proxy({}, { get: (_, name) => name === "__esModule" ? true : class {} });',
      loader: 'js',
    }));
  },
};

/**
 * What a browser provides that the bundle may use as it loads: Web APIs, and none of Node's own
 * globals (`process`, `Buffer`, `require`, `module`).
 */
const BROWSER_GLOBALS = {
  TextEncoder,
  TextDecoder,
  URL,
  URLSearchParams,
  Headers,
  Request,
  Response,
  ReadableStream,
  crypto,
  atob,
  btoa,
  console,
};

async function loadInBrowserContext(source: string): Promise<Record<string, unknown>> {
  const result = await build({
    stdin: { contents: source, resolveDir: ROOT, loader: 'ts' },
    alias: ENTRIES,
    plugins: [peerStandIns],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    globalName: 'bundle',
    write: false,
    logLevel: 'silent',
  });
  const context = vm.createContext({ ...BROWSER_GLOBALS });
  vm.runInContext(result.outputFiles[0]?.text ?? '', context);
  return context.bundle as Record<string, unknown>;
}

describe('in a browser', () => {
  it('bundles createApp and loads it with no Node globals', async () => {
    const bundle = await loadInBrowserContext(
      "export { createApp } from 'vintasend-templates-management-api';",
    );

    expect(typeof bundle.createApp).toBe('function');
  });

  it('bundles every export of the entry and loads it', async () => {
    const bundle = await loadInBrowserContext(
      "export * from 'vintasend-templates-management-api';",
    );

    expect(typeof bundle.apiKeyAuthenticator).toBe('function');
  });

  it('bundles ./testing and loads it', async () => {
    const bundle = await loadInBrowserContext(
      "export * from 'vintasend-templates-management-api/testing';",
    );

    expect(typeof bundle.createHarness).toBe('function');
  });

  it.each(Object.entries(ENTRIES))('imports no Node built-in from %s', async (_name, entry) => {
    // Bundled for Node, built-ins stay external, so the metafile lists every import of one,
    // static or dynamic, from this package's modules and from the dependencies it brings.
    const result = await build({
      entryPoints: [entry],
      external: PEERS,
      bundle: true,
      platform: 'node',
      format: 'esm',
      write: false,
      metafile: true,
      logLevel: 'silent',
    });

    const builtinImports = Object.entries(result.metafile.inputs).flatMap(([file, input]) =>
      input.imports
        .filter((imported) => isNodeBuiltin(imported.path))
        .map((imported) => `${file} -> ${imported.path}`),
    );

    expect(builtinImports).toEqual([]);
  });
});
