import assert from "node:assert/strict";
import {
  assertSafeUrl,
  isBlockedHostname,
  isBlockedIp,
  ssrfFetch,
} from "../src/security/ssrf";

function testBlockedHostnames() {
  assert.equal(isBlockedHostname("localhost"), true);
  assert.equal(isBlockedHostname("api.localhost"), true);
  assert.equal(isBlockedHostname("example.local"), true);
  assert.equal(isBlockedHostname("EXAMPLE.LOCAL"), true);
  assert.equal(isBlockedHostname("example.com"), false);
  assert.equal(isBlockedHostname("sub.example.com"), false);
}

function testBlockedIps() {
  // loopback / private / link-local / multicast
  assert.equal(isBlockedIp("127.0.0.1"), true);
  assert.equal(isBlockedIp("10.0.0.1"), true);
  assert.equal(isBlockedIp("172.16.0.1"), true);
  assert.equal(isBlockedIp("192.168.1.10"), true);
  assert.equal(isBlockedIp("169.254.1.1"), true);
  assert.equal(isBlockedIp("224.0.0.1"), true);

  // public
  assert.equal(isBlockedIp("8.8.8.8"), false);
  assert.equal(isBlockedIp("1.1.1.1"), false);

  // ipv6 loopback / link-local / unique-local / multicast
  assert.equal(isBlockedIp("::1"), true);
  assert.equal(isBlockedIp("fe80::1"), true);
  assert.equal(isBlockedIp("fd00::1"), true);
  assert.equal(isBlockedIp("ff02::1"), true);
}

async function testAssertSafeUrl() {
  await assert.rejects(() => assertSafeUrl(new URL("ftp://example.com/file")), /unsupported_protocol/);
  await assert.rejects(() => assertSafeUrl(new URL("http://localhost/path")), /hostname_blocked/);
  await assert.rejects(() => assertSafeUrl(new URL("http://printer.local/path")), /hostname_blocked/);
  await assert.rejects(() => assertSafeUrl(new URL("http://127.0.0.1/path")), /ip_blocked/);
  await assert.doesNotReject(() => assertSafeUrl(new URL("https://8.8.8.8/path")));
}

async function withFetchMock(
  fn: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
  run: () => Promise<void>
) {
  const original = globalThis.fetch;
  (globalThis as any).fetch = fn;
  try {
    await run();
  } finally {
    (globalThis as any).fetch = original;
  }
}

async function testSsrfFetchRedirectLimitAndFinalUrl() {
  await withFetchMock(
    async (input) => {
      const url = String(input);
      if (url.endsWith("/start")) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://8.8.8.8/hop1" },
        });
      }
      if (url.endsWith("/hop1")) {
        return new Response(null, {
          status: 301,
          headers: { location: "/final" },
        });
      }
      return new Response("<html>ok</html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
    async () => {
      const result = await ssrfFetch(
        "https://8.8.8.8/start",
        { method: "GET" },
        {
          maxRedirects: 3,
          timeoutMs: 5_000,
          maxBodyBytes: 512 * 1024,
          allowedContentTypes: ["text/html"],
        }
      );
      assert.equal(result.status, 200);
      assert.equal(result.finalUrl, "https://8.8.8.8/final");
      assert.equal(result.body.toString("utf8"), "<html>ok</html>");
    }
  );
}

async function testSsrfFetchTooManyRedirects() {
  await withFetchMock(
    async (input) => {
      const url = String(input);
      const m = /\/r(\d+)$/.exec(url);
      const idx = m ? Number(m[1]) : 0;
      return new Response(null, {
        status: 302,
        headers: { location: `https://8.8.8.8/r${idx + 1}` },
      });
    },
    async () => {
      await assert.rejects(
        () =>
          ssrfFetch(
            "https://8.8.8.8/r0",
            { method: "GET" },
            {
              maxRedirects: 3,
              timeoutMs: 5_000,
              maxBodyBytes: 512 * 1024,
              allowedContentTypes: ["text/html"],
            }
          ),
        /too_many_redirects/
      );
    }
  );
}

async function testSsrfFetchContentTypeBlock() {
  await withFetchMock(
    async () =>
      new Response("{\"ok\":true}", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    async () => {
      await assert.rejects(
        () =>
          ssrfFetch(
            "https://8.8.8.8/data",
            { method: "GET" },
            {
              maxRedirects: 3,
              timeoutMs: 5_000,
              maxBodyBytes: 512 * 1024,
              allowedContentTypes: ["text/html"],
            }
          ),
        /content_type_blocked/
      );
    }
  );
}

async function testSsrfFetchBodyTooLarge() {
  await withFetchMock(
    async () =>
      new Response("0123456789", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    async () => {
      await assert.rejects(
        () =>
          ssrfFetch(
            "https://8.8.8.8/large",
            { method: "GET" },
            {
              maxRedirects: 3,
              timeoutMs: 5_000,
              maxBodyBytes: 4,
              allowedContentTypes: ["text/plain"],
            }
          ),
        /body_too_large/
      );
    }
  );
}

async function testSsrfFetchTimeout() {
  await withFetchMock(
    async (_input, init) => {
      const signal = init?.signal;
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(new Error("aborted"));
        if (signal?.aborted) {
          reject(new Error("aborted"));
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
        setTimeout(resolve, 50);
      });
      return new Response("never", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    },
    async () => {
      await assert.rejects(
        () =>
          ssrfFetch(
            "https://8.8.8.8/slow",
            { method: "GET" },
            {
              maxRedirects: 3,
              timeoutMs: 10,
              maxBodyBytes: 512 * 1024,
              allowedContentTypes: ["text/plain"],
            }
          )
      );
    }
  );
}

async function main() {
  testBlockedHostnames();
  testBlockedIps();
  await testAssertSafeUrl();
  await testSsrfFetchRedirectLimitAndFinalUrl();
  await testSsrfFetchTooManyRedirects();
  await testSsrfFetchContentTypeBlock();
  await testSsrfFetchBodyTooLarge();
  await testSsrfFetchTimeout();
}

void main().then(
  () => {
    // eslint-disable-next-line no-console
    console.log("ssrf-guard: ok");
  },
  (err) => {
    // eslint-disable-next-line no-console
    console.error("ssrf-guard: failed", err);
    process.exit(1);
  }
);

