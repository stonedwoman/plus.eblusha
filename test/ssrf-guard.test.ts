import assert from "node:assert/strict";
import { isBlockedHostname, isBlockedIp } from "../src/security/ssrf";

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

testBlockedHostnames();
testBlockedIps();

// eslint-disable-next-line no-console
console.log("ssrf-guard: ok");

