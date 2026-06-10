/**
 * Reading Room — server-only admin layer injection.
 *
 * Appends the management bundle (assets/admin/) plus a page-context payload
 * to pages served by serve.ts. build.ts MUST NOT import this module — that is
 * what keeps published static output free of management chrome, and
 * admin_test.ts pins it.
 */
import { ADMIN_END, ADMIN_START } from "./render.ts";

export interface DocState {
  slug: string;
  review: boolean;
  visibility: "private" | "shared";
}
export type AdminContext =
  | { page: "index"; readonly: boolean; docs: Record<string, Omit<DocState, "slug">> }
  | { page: "doc"; readonly: boolean; doc: DocState };

const BODY_END_RE = /<\/body>/i;

/** Serialize for a <script> body: <-escape so "</script>" can't break out. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

export function injectAdmin(html: string, ctx: AdminContext): string {
  const block = `${ADMIN_START}
<script>window.__RR = ${scriptJson(ctx)};</script>
<link rel="stylesheet" href="/assets/admin/admin.css">
<script type="module" src="/assets/admin/admin.js"></script>
${ADMIN_END}`;
  if (BODY_END_RE.test(html)) return html.replace(BODY_END_RE, () => block + "\n</body>");
  return html + "\n" + block;
}
