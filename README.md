# vintasend-templates-management-api

REST API for managing
[VintaSend managed templates](https://github.com/vintasoftware/vintasend-ts-managed-templates):
their versions, their status lifecycle, their tags, what they compose into, and what a version
renders to before anyone publishes it.

It ships no template store of its own. You point it at a module that builds a configured
`ManagedTemplateService` — over Medplum, or over any other implementation of the storage seam —
and it exposes that service over HTTP.

## The contract

[`openapi.yaml`](./openapi.yaml) is normative, and it is shared **verbatim** with the Python
implementation at
[vintasend-templates-management-api](https://github.com/vintasoftware/vintasend-templates-management-api).
A client generated from it works against either server, operationIds included.

This repository does not generate the file — it satisfies it. `test/contract.test.ts` walks every
path and method the file declares and asserts the server routes them, so a route added on one side
and not the other is a failing test rather than a surprise for a client. Every request the test
suite makes is also checked against the statuses its operation declares, so a route answering a
status a generated client was never told about fails the test that provoked it.

`src/contract/types.ts` is the same contract as TypeScript types, importable by a UI.

## Two ways to run it

**Mounted in your own server** — the usual case for an app that already has one. `createApp` returns
a [Hono](https://hono.dev) app, which takes a standard `Request` and returns a `Response`, so it
mounts in a Next.js route handler, in TanStack Start, behind Express, or anywhere else that speaks
`fetch`. You hand it the `ManagedTemplateService` you already built and your own check of who is
calling. See [Mounting it](#mounting-it).

**On its own** — the `vintasend-templates-management-api` command runs a server configured from
environment variables, behind one shared API key. See [Running it on its own](#running-it-on-its-own).

## Installing

```bash
npm install vintasend-templates-management-api vintasend vintasend-managed-templates
```

`vintasend` and `vintasend-managed-templates` are peer dependencies, and they have to be: the API
recognises the library's errors — a missing template, a refused transition, a template that cannot
be composed — by their class, so it must share one copy of the library with the service you build.
With two copies those answers would all come back as 500s. Install the same release line for all
three; they are released together, and their versions match.

The standalone server also needs `@hono/node-server`. It is an optional peer dependency, so a host
that mounts `createApp` in its own server does not install a Node HTTP server it never starts:

```bash
npm install @hono/node-server   # only to run the vintasend-templates-management-api command
```

The package has three entry points:

| Import | What it holds |
|---|---|
| `vintasend-templates-management-api` | `createApp`, the authenticators, `ApiError` and the wire types. No Node built-ins: it loads in a browser. |
| `vintasend-templates-management-api/testing` | The API in memory, for tests and stories. See [Testing your mount](#testing-your-mount). Loads in a browser too. |
| `vintasend-templates-management-api/server` | What the standalone command is built from: `loadServerConfig` and the service-module loader. Node only. |

## Running it on its own

```bash
MANAGED_TEMPLATE_API_KEY=… MANAGED_TEMPLATE_SERVICE_MODULE=./templates.config.js \
  npx vintasend-templates-management-api
```

To work on this repository instead:

```bash
cp .env.example .env            # set MANAGED_TEMPLATE_API_KEY
cp src/vintasend-templates.config.example.ts src/vintasend-templates.config.ts
# ...build your service in that file...
npm install
npm run dev
```

```bash
curl -H "Authorization: Bearer $MANAGED_TEMPLATE_API_KEY" \
  http://localhost:3334/api/v1/templates
```

### Configuring the service

`MANAGED_TEMPLATE_SERVICE_MODULE` names a module that default-exports a function returning a
configured `ManagedTemplateService`. The API calls it once at startup and fails fast if it throws,
so a broken deployment does not wait for the first request to say so.

```ts
// src/vintasend-templates.config.ts
import { MedplumClient } from '@medplum/core';
import { ManagedTemplateEmailRenderer, ManagedTemplateService } from 'vintasend-managed-templates';
import { MedplumTemplateManagerBackend } from 'vintasend-medplum-template-manager';
import { LiquidEmailTemplateRendererFactory } from 'vintasend-liquidjs';

export default async function createManagedTemplateService() {
  const medplum = new MedplumClient({ baseUrl: process.env.MEDPLUM_BASE_URL });
  await medplum.startClientLogin(process.env.MEDPLUM_CLIENT_ID, process.env.MEDPLUM_CLIENT_SECRET);

  const managerBackend = new MedplumTemplateManagerBackend(medplum);
  const innerRenderer = new LiquidEmailTemplateRendererFactory<Config>().create({
    // Whoever can edit a template here can make it expensive to render. Bound it.
    parseLimit: 1_000_000, // characters, the longest template this API accepts
    renderLimit: 1_000, // milliseconds per render
    memoryLimit: 100_000_000,
    strictFilters: true,
  });
  const renderer = new ManagedTemplateEmailRenderer<Config>(managerBackend, innerRenderer);

  return new ManagedTemplateService<Config>(managerBackend, renderer);
}
```

**Use a renderer that cannot run code.** Managed templates are source anyone with access to this
API can edit, so the engine that renders them is reachable by everyone who can. Liquid
(`vintasend-liquidjs`) evaluates expressions and filters only. Pug (`vintasend-pug`) compiles a
template to JavaScript and runs it — including any `- code` line in it — so with Pug, editing a
template is running code on the server. Keep Pug for templates that live in your repository.

A service loaded from `MANAGED_TEMPLATE_SERVICE_MODULE` is checked at startup by the methods it has
rather than with `instanceof`: the operator's module resolves its own copy of
`vintasend-managed-templates`, and two copies of a class fail `instanceof` even when they are the
same code. A service missing a method is a startup error naming which one, not a `TypeError` on the
first request that reaches it. A service a host passes to `createApp` is checked by its type
instead.

### Environment

| Variable | Meaning |
|---|---|
| `MANAGED_TEMPLATE_API_KEY` | **Required.** Shared secret; every `/api/v1` request must send `Authorization: Bearer <key>` |
| `MANAGED_TEMPLATE_SERVICE_MODULE` | Module that builds the service. Default `./dist/vintasend-templates.config.js` |
| `MANAGED_TEMPLATE_API_CORS_ORIGINS` | Comma-separated browser origins. Leave empty for server-side clients only |
| `PORT` / `HOST` | Default `3334` / `0.0.0.0` |

## Endpoints

Every `/api/v1` route goes through the configured authenticator — the API key, for the standalone
server. `/health` does not — load balancers have no credentials.

### Templates

| | |
|---|---|
| `GET /api/v1/templates` | List, filtered and optionally ordered. One row per key by default |
| `POST /api/v1/templates` | Create a template's first version |
| `GET /api/v1/templates/{key}` | One version; latest when `version` is omitted |
| `DELETE /api/v1/templates/{key}` | Delete one never-published version; latest when `version` is omitted |
| `GET /api/v1/templates/{key}/versions` | Every version, newest first |
| `POST /api/v1/templates/{key}/versions` | Create the next version from the latest |
| `GET /api/v1/templates/{key}/versions/{version}` | One version |
| `DELETE /api/v1/templates/{key}/versions/{version}` | Delete one never-published version |
| `GET /api/v1/templates/{key}/composition` | What the engine will actually receive |
| `POST /api/v1/templates/{key}/preview` | Render a version against a supplied context |
| `PUT /api/v1/templates/{key}/tags` | Retag a version, in place |

### Statuses

| | |
|---|---|
| `GET /api/v1/templates/{key}/status-history` | The audit trail, most recent first |
| `POST /api/v1/templates/{key}/status` | Move to an explicitly named status |
| `POST /api/v1/templates/{key}/activate` | Publish one version |
| `POST /api/v1/templates/{key}/deactivate` | Retire it, reversibly |
| `POST /api/v1/templates/{key}/archive` | Retire it for good |

### Tags

| | |
|---|---|
| `GET /api/v1/tags` · `POST /api/v1/tags` | List and define |
| `GET`/`PATCH`/`DELETE /api/v1/tags/{slug}` | Read, rename, delete |
| `POST /api/v1/tags/{slug}/archive` · `/restore` | Take out of the pickers, and put back |

### System

| | |
|---|---|
| `GET /api/v1/capabilities` | Which filters the configured backend can honour |
| `GET /health` | Unauthenticated liveness check |

## Things worth knowing before you build against it

**A row is a version, not a template.** `GET /templates` therefore defaults to
`mostRecentActiveVersion=true`, which collapses the store to one row per key — the highest-numbered
`active` or `draft` version. Send `false` for the raw listing. A key whose versions are all
`inactive` or `archived` has no current version and does not appear in the default listing.

That is also why `?status=archived` on its own finds nothing: the status filter applies on top of
the one row kept per key, which is never `inactive` or `archived`. To find those, send
`?status=archived&mostRecentActiveVersion=false`.

**`hasMore` means another page has a row.** There is no total — the storage seam cannot count — so
after a full page the API reads the one row that would come next. A list that exactly fills its
last page reports `hasMore: false` there.

**Request bodies are JSON.** A request that declares `application/json` (or any `application/*+json`)
must carry valid JSON, so an empty body there is a 400. A request that declares no media type, or
another one, counts as an omitted body when its body is empty — which is how the all-optional
bodies of `activate`, `deactivate`, `archive`, `preview` and `POST /templates/{key}/versions` are
left out — and is a 400 otherwise. `curl -d` sends form encoding unless told otherwise, so pass
`-H 'Content-Type: application/json'`; read as `{}`, its body would have acted on the latest version.

**Writes create versions; retagging does not.** `POST /templates/{key}/versions` copies the latest
version forward and starts the copy in `draft`, so a published version's body never changes under a
notification that already referenced it. `PUT /templates/{key}/tags` is the one write that edits a
version in place: tags describe how a template is *found*, not what it renders, so relabelling
should not fork a version and drop it back to draft.

**`allowedTransitions` is on every template payload.** Read it rather than discovering the
lifecycle by catching 409s. A move it does not list comes back as a 409 with code
`INVALID_STATUS_TRANSITION`. A version may hold several `active` siblings at once; an unpinned send
renders the highest-numbered active version, and never a draft.

**Only a never-published version can be deleted.** A version that was ever activated is refused
with a 409 `CONFLICT` — a notification may be pinned to it, and its status history is the record of
who published it. Archive it instead. That applies to `DELETE /templates/{key}` with no `version`
too, which resolves to the latest version, so prefer naming the version you mean.

**Attribution is the host's to resolve.** The status routes accept `changedBy` in the body, but a
host that knows who is calling should return it as `actor` from its authenticator (see
[Mounting it](#mounting-it)). It then replaces whatever the body says, so a caller cannot write
someone else's name into the audit trail.

**Composition happens before any engine runs.** The stored `bodyTemplate` is only half the template
when it extends a base — `GET /templates/{key}/composition` is what actually renders, and
`POST /templates/{key}/preview` is that rendered against a context. Both report a template that
cannot be assembled as a 409 `TEMPLATE_COMPOSITION_ERROR` rather than a 500: the request was fine and
the *template* is what needs fixing, so the message names the chain that broke. A preview of a
template that assembles but will not render is a 409 `PREVIEW_UNAVAILABLE` carrying the renderer's
message, so the code says whether to fix the chain or the template. A store failing while
assembling is a generic 500: its message stays on the server.

**Preview pins a version on purpose.** That is what lets a draft be reviewed before anyone
activates it. The `context` you send is rendered verbatim — this API has no notification to resolve
a registered context generator from.

**Filters are negotiated, not assumed.** `GET /api/v1/capabilities` reports what the configured
backend can do, and a filter it cannot honour is *dropped* rather than failing the request. A
string filter degrades in steps: case-insensitive substring, then case-insensitive exact, then
plain equality.

**Ordering is negotiated the other way — it 400s.** `orderByField` and `orderByDirection` on
`GET /api/v1/templates` are checked against the `orderBy.*` capability keys, and an order the
backend cannot apply is refused. The asymmetry with filters is the point:

| | Unsupported filter | Unsupported order |
|---|---|---|
| What happens | dropped, request succeeds | `400 BAD_REQUEST` |
| If it were ignored | more rows than asked for | the same rows in an arbitrary sequence |
| Can the client tell? | yes, from the rows | no |

A client that rendered an unordered page under a highlighted "sorted by name" header would be
showing a sort that never happened. Build the sortable columns from `/api/v1/capabilities` and the
400 never fires.

Neither parameter has a default: every `orderBy.*` key defaults to false, so a default would make
the ordinary listing a 400 against most backends. Omitting them asks for the backend's own order.
`orderByDirection` on its own is a 400 too — silently ignoring it looks exactly like a backend that
cannot sort, which hides the client bug.

**Errors carry a code.** Branch on `error.code`, not on `error.message`.

| Code | Status | Means |
|---|---|---|
| `BAD_REQUEST` | 400 | Invalid input; `details.issues` lists what was wrong |
| `UNAUTHORIZED` | 401 | No valid credential: a missing or wrong API key, or whatever your authenticator refuses |
| `FORBIDDEN` | 403 | The caller is known and may not do this. Your authenticator's answer; the API key never gives it |
| `NOT_FOUND` | 404 | No such template, version, tag or route |
| `CONFLICT` | 409 | A tag whose text already slugs onto an existing one, or deleting a published version |
| `INVALID_STATUS_TRANSITION` | 409 | The lifecycle does not allow that move |
| `PREVIEW_UNAVAILABLE` | 409 | The template would not render |
| `TEMPLATE_COMPOSITION_ERROR` | 409 | The template could not be assembled |
| `INTERNAL_ERROR` | 500 | Unexpected; reported generically, with an `X-Request-Id` header |

Every 400 carries `details.issues: [{ path, message }]`, whatever the mistake was, so a client reads
one shape: `path` is the field (dotted when nested), `version` for an invalid version in the path,
and empty for a body that is not valid JSON or not sent as JSON, or for a refusal from the library
(which repeats the message). An unsupported order also names `orderByField` and `capability` beside
`issues`.

An unexpected error is logged as one line — its class name, the request id and the route pattern —
and never with its message, its stack, the request body or a preview context: errors from the
template store or the engine can carry template content and context values, which in the
applications this API serves can be health data. Pass `onUnhandledError` to `createApp` to send
errors somewhere with its own scrubbing instead; if it throws, the default line is logged in its
place, and what it threw is not.

## Mounting it

The package's main entrypoint exports the app rather than starting a server, so it mounts inside a
server you already run. In a Next.js app router, one catch-all route handler serves every route:

```ts
// app/api/v1/[...path]/route.ts
import { ApiError, createApp } from 'vintasend-templates-management-api';

const app = createApp({
  // Runs before every /api/v1 route. Throw to refuse; return the caller as `actor`.
  authenticate: async (c) => {
    const user = await mySession(c);
    if (!user) throw ApiError.unauthorized('Sign in to manage templates.');
    if (!user.canEditTemplates) throw ApiError.forbidden('You cannot manage templates.');
    // Recorded as `changedBy` on every status change, in place of anything the body says.
    return { actor: user.email };
  },
  getService: async () => myConfiguredService,
  // Every new template is stored under this backend name, whatever the create request says.
  templateManagedBackend: 'medplum',
  corsOrigins: ['https://admin.example'],
  // Every error not mapped to a contract error. Defaults to a single redacted log line.
  onUnhandledError: (error, c, { requestId }) => errorTracker.capture(error, { requestId }),
});

const handler = (request: Request) => app.fetch(request);
export { handler as GET, handler as POST, handler as PUT, handler as PATCH, handler as DELETE };
```

Behind Express, hand `getRequestListener(app.fetch)` from `@hono/node-server` to a route that keeps
the path whole — `server.all(...)`, not `server.use('/api/v1', ...)`, which strips the prefix the
API's routes include.

`authenticate` may be async. Throw `ApiError.unauthorized` for a caller with no valid credential and
`ApiError.forbidden` for one you know and refuse: a 401 would tell a signed-in user to sign in
again. An `actor` of `null` records the change as unattributed. Leave `actor` out and `changedBy`
comes from the request body — fine only when everyone who passes the check is trusted to attribute
honestly.

For one shared secret, which is what the standalone server uses, pass
`authenticate: apiKeyAuthenticator(key)`. It compares in constant time and names no actor. To check
a token yourself, such as the caller's own identity-provider token, read it with `bearerToken`:

```ts
import { ApiError, bearerToken } from 'vintasend-templates-management-api';

authenticate: async (c) => {
  const token = bearerToken(c.req.header('authorization')); // null when there is none
  const user = token === null ? null : await verifyToken(token);
  if (!user) throw ApiError.unauthorized('Sign in to manage templates.');
  return { actor: user.id };
},
```

`templateManagedBackend` is for a host that serves one template backend. Set, it is the name every
new template is stored under, so a browser cannot label a template with another backend. Unset, the
create request's value is stored. The field stays required in the request either way, so clients
written against the contract keep working.

`authenticate` has the same shape in
[`vintasend-api`](https://github.com/vintasoftware/vintasend-ts-api), the notifications API, so an
app mounting both passes them one function. It may throw the `ApiError` of either package: both
recognise an error by its name and code, not by its class.

The app uses Web APIs only — no Node built-ins — so it also runs in a browser, over the library's
in-memory store, for a Storybook or a demo. The standalone server (`src/index.ts`) and the
module-path service loader on `./server` are the Node-only parts.

## Testing your mount

`./testing` runs the whole API in memory: the library's real `ManagedTemplateService` over its
`InMemoryTemplateManagerBackend`, and `createApp` over that. It is what this repository's own route
tests run on, and it loads in a browser, so a UI's stories and tests can use it as their server.

```ts
import { createHarness, createInput, post } from 'vintasend-templates-management-api/testing';

const api = createHarness();
await api.service.createTemplate(createInput('welcome', { bodyTemplate: '<p>Hi {{ name }}</p>' }));

const { status, body } = await api.json('/api/v1/templates/welcome/preview', post({
  context: { name: 'Ana' },
}));
// 200, body.data.renderedBody === '<p>Hi Ana</p>'
```

- `createHarness(options?)` returns `{ app, backend, service, request, json }`. `request` sends a
  path to the app with `Authorization: Bearer ${API_KEY}`, and `content-type: application/json`
  when there is a body; `json` also parses the response.
- Its options:
  - `authenticate`, `onUnhandledError` and `templateManagedBackend` go to `createApp`. The default
    authenticator is `apiKeyAuthenticator(API_KEY)`;
  - `capabilities` replaces what the store reports from `getFilterCapabilities`;
  - `now` is the store's clock, for seeding status history with fixed dates;
  - `renderer` replaces the test renderer;
  - `onResponse` sees every response before `request` returns it.
- The test renderer, `TestEmailRenderer`, fills plain `{{ name }}` variables from the context and
  leaves any it cannot fill as written. It throws on a template containing `boom`, so a story can
  show a preview that fails (a 409 `PREVIEW_UNAVAILABLE`) with no template engine installed.
- `createInput(key, overrides?)` is a valid first version; `post`, `put` and `patch(body)` build a
  `RequestInit`.

## Development

```bash
npm install
npm test
npm run typecheck
npm run lint
```

The tests run the real `ManagedTemplateService` over the library's in-memory store — only the store
is a fixture. An API test that stubbed the service would prove the routes call *something*, not
that they call it correctly, and the parts most worth pinning (which filter a query becomes, which
error a refused transition produces) live on the far side of that boundary.

## License

MIT
