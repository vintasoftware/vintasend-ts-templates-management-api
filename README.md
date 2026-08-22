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
and not the other is a failing test rather than a surprise for a client.

`src/contract/types.ts` is the same contract as TypeScript types, importable by a UI.

## Quick start

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
import { PugEmailTemplateRendererFactory } from 'vintasend-pug';

export default async function createManagedTemplateService() {
  const medplum = new MedplumClient({ baseUrl: process.env.MEDPLUM_BASE_URL });
  await medplum.startClientLogin(process.env.MEDPLUM_CLIENT_ID, process.env.MEDPLUM_CLIENT_SECRET);

  const managerBackend = new MedplumTemplateManagerBackend(medplum);
  const innerRenderer = new PugEmailTemplateRendererFactory<Config>().create();
  const renderer = new ManagedTemplateEmailRenderer<Config>(managerBackend, innerRenderer);

  return new ManagedTemplateService<Config>(managerBackend, renderer);
}
```

The service is checked at startup by the methods it has rather than with `instanceof`: the
operator's module resolves its own copy of `vintasend-managed-templates`, and two copies of a class
fail `instanceof` even when they are the same code. A service missing a method is a startup error
naming which one, not a `TypeError` on the first request that reaches it.

### Environment

| Variable | Meaning |
|---|---|
| `MANAGED_TEMPLATE_API_KEY` | **Required.** Shared secret; every `/api/v1` request must send `Authorization: Bearer <key>` |
| `MANAGED_TEMPLATE_SERVICE_MODULE` | Module that builds the service. Default `./dist/vintasend-templates.config.js` |
| `MANAGED_TEMPLATE_API_CORS_ORIGINS` | Comma-separated browser origins. Leave empty for server-side clients only |
| `PORT` / `HOST` | Default `3334` / `0.0.0.0` |

## Endpoints

Every `/api/v1` route requires the API key. `/health` does not — load balancers have none.

### Templates

| | |
|---|---|
| `GET /api/v1/templates` | List, filtered and optionally ordered. One row per key by default |
| `POST /api/v1/templates` | Create a template's first version |
| `GET /api/v1/templates/{key}` | One version; latest when `version` is omitted |
| `DELETE /api/v1/templates/{key}` | Delete one version; latest when `version` is omitted |
| `GET /api/v1/templates/{key}/versions` | Every version, newest first |
| `POST /api/v1/templates/{key}/versions` | Create the next version from the latest |
| `GET /api/v1/templates/{key}/versions/{version}` | One version |
| `DELETE /api/v1/templates/{key}/versions/{version}` | Delete one version |
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

**Writes create versions; retagging does not.** `POST /templates/{key}/versions` copies the latest
version forward and starts the copy in `draft`, so a published version's body never changes under a
notification that already referenced it. `PUT /templates/{key}/tags` is the one write that edits a
version in place: tags describe how a template is *found*, not what it renders, so relabelling
should not fork a version and drop it back to draft.

**`allowedTransitions` is on every template payload.** Read it rather than discovering the
lifecycle by catching 409s. A move it does not list comes back as a 409 with code
`INVALID_STATUS_TRANSITION`; a version may hold several `active` siblings at once, because choosing
between them is the host application's call.

**Composition happens before any engine runs.** The stored `bodyTemplate` is only half the template
when it extends a base — `GET /templates/{key}/composition` is what actually renders, and
`POST /templates/{key}/preview` is that rendered against a context. Both report a template that
cannot be assembled as a 409 (`TEMPLATE_COMPOSITION_ERROR` / `PREVIEW_UNAVAILABLE`) rather than a
500: the request was fine and the *template* is what needs fixing, so the message names the chain
that broke.

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
| `BAD_REQUEST` | 400 | Invalid input; `details.issues` lists the fields |
| `UNAUTHORIZED` | 401 | Missing or wrong API key |
| `NOT_FOUND` | 404 | No such template, version, tag or route |
| `CONFLICT` | 409 | A tag whose text already slugs onto an existing one |
| `INVALID_STATUS_TRANSITION` | 409 | The lifecycle does not allow that move |
| `PREVIEW_UNAVAILABLE` | 409 | The template would not render |
| `TEMPLATE_COMPOSITION_ERROR` | 409 | The template could not be assembled |
| `INTERNAL_ERROR` | 500 | Unexpected; logged in full, reported generically |

## Embedding it

The package's main entrypoint exports the app rather than starting a server, so it can be mounted
inside an existing Node process:

```ts
import { createApp } from 'vintasend-templates-management-api';

const app = createApp({
  apiKey: process.env.MANAGED_TEMPLATE_API_KEY,
  getService: async () => myConfiguredService,
  corsOrigins: ['https://admin.example'],
});
```

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
