/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";
import type * as accountJobs from "../accountJobs.js";
import type * as accounts from "../accounts.js";
import type * as agent from "../agent.js";
import type * as agentSteps from "../agentSteps.js";
import type * as assetGeneration from "../assetGeneration.js";
import type * as assetJobs from "../assetJobs.js";
import type * as assets from "../assets.js";
import type * as authWebhook from "../authWebhook.js";
import type * as cachedFetch from "../cachedFetch.js";
import type * as capturePackages from "../capturePackages.js";
import type * as captures from "../captures.js";
import type * as crons from "../crons.js";
import type * as design from "../design.js";
import type * as extract from "../extract.js";
import type * as files from "../files.js";
import type * as http from "../http.js";
import type * as images from "../images.js";
import type * as messages from "../messages.js";
import type * as migrations from "../migrations.js";
import type * as operations from "../operations.js";
import type * as ownership from "../ownership.js";
import type * as planner from "../planner.js";
import type * as plans from "../plans.js";
import type * as products from "../products.js";
import type * as projects from "../projects.js";
import type * as recommendations from "../recommendations.js";
import type * as roomReconstruction from "../roomReconstruction.js";
import type * as roomReconstructionGeneration from "../roomReconstructionGeneration.js";
import type * as rooms from "../rooms.js";
import type * as sampleDesign from "../sampleDesign.js";
import type * as search from "../search.js";
import type * as sourceCache from "../sourceCache.js";
import type * as storageCleanup from "../storageCleanup.js";
import type * as turns from "../turns.js";

/**
 * A utility for referencing Convex functions in your app's API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
declare const fullApi: ApiFromModules<{
  accountJobs: typeof accountJobs;
  accounts: typeof accounts;
  agent: typeof agent;
  agentSteps: typeof agentSteps;
  assetGeneration: typeof assetGeneration;
  assetJobs: typeof assetJobs;
  assets: typeof assets;
  authWebhook: typeof authWebhook;
  cachedFetch: typeof cachedFetch;
  capturePackages: typeof capturePackages;
  captures: typeof captures;
  crons: typeof crons;
  design: typeof design;
  extract: typeof extract;
  files: typeof files;
  http: typeof http;
  images: typeof images;
  messages: typeof messages;
  migrations: typeof migrations;
  operations: typeof operations;
  ownership: typeof ownership;
  planner: typeof planner;
  plans: typeof plans;
  products: typeof products;
  projects: typeof projects;
  recommendations: typeof recommendations;
  roomReconstruction: typeof roomReconstruction;
  roomReconstructionGeneration: typeof roomReconstructionGeneration;
  rooms: typeof rooms;
  sampleDesign: typeof sampleDesign;
  search: typeof search;
  sourceCache: typeof sourceCache;
  storageCleanup: typeof storageCleanup;
  turns: typeof turns;
}>;
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;
