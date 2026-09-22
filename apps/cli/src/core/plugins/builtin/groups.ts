import type { HostGroupMetadata } from "../manifest";

export const CODESURF_PROVIDERS_GROUP: HostGroupMetadata = {
  id: "codesurf.providers",
  name: "CodeSurf Providers",
  description: "Model and agent providers shipped with CodeSurf.",
  order: 10,
};

/**
 * Third-party Cordis plugins adopted from outside this repo.
 *
 * Its own group so the /plugins list makes the provenance obvious: these are
 * not ours, they are mounted from npm on the same runtime.
 */
export const CODESURF_EXTERNAL_GROUP: HostGroupMetadata = {
  id: "codesurf.external",
  name: "External Cordis Plugins",
  description: "Third-party Cordis plugins mounted unmodified from npm.",
  order: 80,
};
