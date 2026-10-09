/**
 * The package's own `./testing` harness, with every response checked against `openapi.yaml`.
 *
 * The route tests run on the same harness a host gets, which is what shows that entry works. What
 * this adds is the contract check: a client error the route does not declare fails the test that
 * provoked it. The declarations are written by hand on the Python side, so this is what notices a
 * route answering a status a generated client was never told about. It reads `openapi.yaml` from
 * disk, which is why it is not part of `./testing`: that one loads in a browser.
 */

import {
  createHarness as createTestingHarness,
  type Harness,
  type HarnessOptions,
} from '../../src/testing.js';
import { undeclaredStatus } from './contract.js';

export {
  API_KEY,
  createInput,
  type Harness,
  type HarnessOptions,
  patch,
  post,
  put,
  type TestConfig,
  TestEmailRenderer,
} from '../../src/testing.js';

export function createHarness(options: HarnessOptions = {}): Harness {
  return createTestingHarness({
    ...options,
    onResponse: (request, response) => {
      options.onResponse?.(request, response);
      const problem = undeclaredStatus(request.method, request.path, response.status);
      if (problem !== undefined) {
        throw new Error(`openapi.yaml: ${problem}`);
      }
    },
  });
}
