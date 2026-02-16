import assert from "node:assert/strict";
import { fetchLinkPreview } from "../src/jobs/workers/linkPreview.fetchers";

async function main() {
  const originalFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => {
    throw new Error("direct_fetch_used");
  };

  const prevApiKey = process.env.YOUTUBE_API_KEY;
  delete process.env.YOUTUBE_API_KEY;

  try {
    const calls: Array<{
      url: string;
      init?: RequestInit;
      opts?: any;
    }> = [];

    const stubSsrfFetch = async (urlString: string, init: RequestInit, opts: any) => {
      calls.push({ url: urlString, init, opts });
      return {
        finalUrl: urlString,
        status: 200,
        headers: new Headers({ "content-type": "application/json; charset=utf-8" }),
        body: Buffer.from(
          JSON.stringify({
            title: "Test video",
            author_name: "Test channel",
            thumbnail_url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
            thumbnail_width: 480,
            thumbnail_height: 360,
          }),
          "utf8"
        ),
      };
    };

    const preview = await fetchLinkPreview("https://www.youtube.com/watch?v=dQw4w9WgXcQ", {
      ssrfFetch: stubSsrfFetch as any,
    });

    assert.ok(preview);
    assert.equal(preview.siteName, "YouTube");
    assert.equal(preview.youtube?.videoId, "dQw4w9WgXcQ");

    // Key property: YouTube branch must go through ssrfFetch (not direct fetch).
    assert.equal(calls.length, 1);
    assert.ok(calls[0]!.url.includes("youtube.com/oembed"));

    // Limits must match SSRF policy.
    assert.equal(calls[0]!.opts?.maxRedirects, 3);
    assert.equal(calls[0]!.opts?.timeoutMs, 5_000);
    assert.ok(typeof calls[0]!.opts?.maxBodyBytes === "number" && calls[0]!.opts.maxBodyBytes <= 512 * 1024);
    assert.ok(Array.isArray(calls[0]!.opts?.allowedContentTypes));
  } finally {
    (globalThis as any).fetch = originalFetch;
    if (typeof prevApiKey === "string") process.env.YOUTUBE_API_KEY = prevApiKey;
    else delete process.env.YOUTUBE_API_KEY;
  }
}

void main().then(
  () => {
    // eslint-disable-next-line no-console
    console.log("link-preview-ssrf: ok");
  },
  (err) => {
    // eslint-disable-next-line no-console
    console.error("link-preview-ssrf: failed", err);
    process.exit(1);
  }
);

