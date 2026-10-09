/**
 * Example managed-template service factory.
 *
 * Copy this file to `src/vintasend-templates.config.ts` (gitignored) and adapt it to your own
 * template backend and renderer. It is compiled with the rest of `src`, so the running server
 * finds it at `MANAGED_TEMPLATE_SERVICE_MODULE=./dist/vintasend-templates.config.js` — or, under
 * `npm run dev`, directly at `./src/vintasend-templates.config.ts`.
 *
 * The only contract is: default-export a function returning a configured `ManagedTemplateService`
 * (or a promise of one). The API calls it once at startup.
 *
 * The imports below are illustrative — install the packages your deployment actually uses.
 */

// import { MedplumClient } from '@medplum/core';
// import { ManagedTemplateEmailRenderer, ManagedTemplateService } from 'vintasend-managed-templates';
// import { MedplumTemplateManagerBackend } from 'vintasend-medplum-template-manager';
// import { LiquidEmailTemplateRendererFactory } from 'vintasend-liquidjs';

export default async function createManagedTemplateService() {
  throw new Error(
    'No managed-template service configured. Copy vintasend-templates.config.example.ts to ' +
      'vintasend-templates.config.ts and build your service there.',
  );

  // const medplum = new MedplumClient({ baseUrl: process.env.MEDPLUM_BASE_URL });
  // await medplum.startClientLogin(
  //   process.env.MEDPLUM_CLIENT_ID,
  //   process.env.MEDPLUM_CLIENT_SECRET,
  // );
  //
  // const managerBackend = new MedplumTemplateManagerBackend(medplum);
  //
  // // The inner renderer is handed template *source*, not a path — every VintaSend renderer
  // // implements `renderFromTemplateContent`, which is the seam that takes source.
  // //
  // // Liquid rather than Pug: managed templates are source anyone with access to this API can
  // // edit, and Pug compiles a template to JavaScript and runs it. The limits bound what an edited
  // // template can cost to render.
  // const innerRenderer = new LiquidEmailTemplateRendererFactory<Config>().create({
  //   parseLimit: 1_000_000,
  //   renderLimit: 1_000,
  //   memoryLimit: 100_000_000,
  //   strictFilters: true,
  // });
  // const renderer = new ManagedTemplateEmailRenderer<Config>(managerBackend, innerRenderer);
  //
  // return new ManagedTemplateService<Config>(managerBackend, renderer);
}
