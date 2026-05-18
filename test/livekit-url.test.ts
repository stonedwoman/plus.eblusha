import assert from "node:assert/strict";
import { buildLivekitPublicUrl } from "../src/lib/livekitUrl";

function makeRequest(
  protocol: string,
  headers: Record<string, string | undefined>
): { protocol: string; get(name: string): string | undefined } {
  const normalized = new Map(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );

  return {
    protocol,
    get(name: string) {
      return normalized.get(name.toLowerCase());
    },
  };
}

function testUsesFirstForwardedValues() {
  const req = makeRequest("http", {
    "x-forwarded-proto": "https, http",
    "x-forwarded-host": "eblusha.org, www.eblusha.org",
    host: "www.eblusha.org",
  });

  assert.equal(buildLivekitPublicUrl(req as any, "api/voice"), "wss://eblusha.org/api/voice");
}

function testOriginKeepsSecureWebsocket() {
  const req = makeRequest("http", {
    "x-forwarded-proto": "http",
    host: "eblusha.org",
    origin: "https://eblusha.org",
  });

  assert.equal(buildLivekitPublicUrl(req as any, "/api/voice"), "wss://eblusha.org/api/voice");
}

function testHttpRequestsStayPlainWs() {
  const req = makeRequest("http", {
    host: "localhost:4000",
    origin: "http://localhost:5173",
  });

  assert.equal(buildLivekitPublicUrl(req as any, "/api/voice"), "ws://localhost:4000/api/voice");
}

function main() {
  testUsesFirstForwardedValues();
  testOriginKeepsSecureWebsocket();
  testHttpRequestsStayPlainWs();
  // eslint-disable-next-line no-console
  console.log("livekit-url: ok");
}

main();
