/**
 * @tlockney/reading-room — an editorial document library engine.
 *
 * Serve, build, publish, and annotate a registry of long-form HTML documents.
 * Run the entry points against a content repo (cwd):
 *
 * ```sh
 * deno run --allow-read --allow-write --allow-net --allow-env=PORT,READONLY \
 *   jsr:@tlockney/reading-room/serve
 * deno run --allow-read --allow-write jsr:@tlockney/reading-room/build
 * ```
 *
 * This module exports the library surface for scripting and for content-repo
 * drift tests (EDITORIAL_HEAD / EDITORIAL_BODY are the canonical zoom + theme
 * bundle the editorial-longform-html skill is pinned against):
 *
 * ```ts
 * import { build, makeContext } from "jsr:@tlockney/reading-room";
 *
 * const ctx = await makeContext("/path/to/content-home");
 * await build(ctx);
 * ```
 *
 * @module
 */
export { DEFAULT_SITE, loadSite, makeContext, parseSite, resolveHome } from "./config.ts";
export type { RoomContext, Site } from "./config.ts";
export { ensureHome, initMain } from "./init.ts";
export {
  injectLocalSlots,
  loadCorpus,
  loadSlots,
  portableDoc,
  portableHtml,
  renderIndex,
  stripAdmin,
  transformDoc,
  transformDocBySlug,
} from "./render.ts";
export type { Doc, LocalSlots, Topic } from "./render.ts";
export { build, filterShared } from "./build.ts";
export type { BuildOptions } from "./build.ts";
export { makeHandler } from "./serve.ts";
export type { ServeOptions } from "./serve.ts";
export {
  insertDoc,
  insertTopic,
  removeDoc,
  setDocField,
  slugExists,
  UnknownSlugError,
} from "./registry-edit.ts";
export type { DocEntry, DocPatch, TopicEntry } from "./registry-edit.ts";
export {
  addComment,
  deleteComment,
  loadComments,
  parseCommentInput,
  setCommentReviewed,
} from "./comments.ts";
export type { Comment, CommentInput } from "./comments.ts";
export {
  artifactUrl,
  deriveSlug,
  extractTitle,
  loadManifest,
  publishArtifact,
  removeArtifact,
  renderGallery,
  setArtifactTitle,
  updateArtifact,
} from "./artifacts.ts";
export type { Artifact, Manifest } from "./artifacts.ts";
export { parsePublishConfig, resolveCmd } from "./publish.ts";
export type { PublishConfig } from "./publish.ts";
export { EDITORIAL_BODY, EDITORIAL_HEAD } from "./assets_gen.ts";
export { buildDocPayload, parseReceivedPayload, receiveDoc, sendDoc } from "./transfer.ts";
export type { DocMeta, DocPayload } from "./transfer.ts";
