import type { LoaderFunctionArgs } from "react-router";
import { getStorage, verifySignedUrl } from "../lib/storage.server";

/**
 * GET /files/<key>?exp=…&sig=… serves a stored file to anyone holding a URL
 * from `signedUrl()`. Netlify Blobs has no signed URLs of its own, so this
 * route stands in for them.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const key = verifySignedUrl(new URL(request.url));
  if (!key) return new Response("Not found", { status: 404 });

  const file = await getStorage().get(key);
  if (!file) return new Response("Not found", { status: 404 });

  return new Response(file.body, {
    headers: {
      "Content-Type": file.contentType,
      // The URL expires, so don't let shared caches keep it longer than the browser.
      "Cache-Control": "private, max-age=300",
      "X-Content-Type-Options": "nosniff",
    },
  });
};
