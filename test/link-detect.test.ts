import assert from "node:assert/strict";
import { detectLinks, extractFirstPreviewableUrl } from "../src/lib/link-detect";

type Expected = Array<{ href: string; shouldPreview: boolean }>;

type Case = {
  name: string;
  input: string;
  expected: Expected;
  expectedFirst: string | null;
};

const cases: Case[] = [
  {
    name: "http scheme: preview allowed",
    input: "See https://example.com for details",
    expected: [{ href: "https://example.com/", shouldPreview: true }],
    expectedFirst: "https://example.com/",
  },
  {
    name: "bare domain: preview allowed (score >= 3)",
    input: "example.com/test?x=1",
    expected: [{ href: "https://example.com/test?x=1", shouldPreview: true }],
    expectedFirst: "https://example.com/test?x=1",
  },
  {
    name: "www domain: preview allowed",
    input: "www.example.com",
    expected: [{ href: "https://www.example.com/", shouldPreview: true }],
    expectedFirst: "https://www.example.com/",
  },
  {
    name: "trailing punctuation is trimmed",
    input: "Check (https://example.com).",
    expected: [{ href: "https://example.com/", shouldPreview: true }],
    expectedFirst: "https://example.com/",
  },
  {
    name: "do not match inside inline backticks",
    input: "Use `https://example.com` but open https://openai.com instead",
    expected: [{ href: "https://openai.com/", shouldPreview: true }],
    expectedFirst: "https://openai.com/",
  },
  {
    name: "do not match inside fenced code blocks",
    input: "```\ncurl https://example.com\n```\nhttps://openai.com",
    expected: [{ href: "https://openai.com/", shouldPreview: true }],
    expectedFirst: "https://openai.com/",
  },
  {
    name: "exclude terminal/command-like lines ($, sudo, docker, kubectl, git, npm, curl...)",
    input: "$ curl https://example.com\nsudo curl https://openai.com\nOK: https://github.com/",
    expected: [{ href: "https://github.com/", shouldPreview: true }],
    expectedFirst: "https://github.com/",
  },
  {
    name: "exclude windows cmd shims like npm.cmd",
    input: "npm.cmd install\nnpm.cmd install https://example.com\nok: example.com",
    expected: [{ href: "https://example.com/", shouldPreview: true }],
    expectedFirst: "https://example.com/",
  },
  {
    name: "do not match host:port without scheme",
    input: "Service at example.com:8080 is up",
    expected: [],
    expectedFirst: null,
  },
  {
    name: "do not match localhost/.local/.lan without scheme",
    input: "printer.lan and host.local and localhost are not previews",
    expected: [],
    expectedFirst: null,
  },
  {
    name: "do not match after @ (email-like)",
    input: "Contact me at user@example.com or visit example.com",
    expected: [{ href: "https://example.com/", shouldPreview: true }],
    expectedFirst: "https://example.com/",
  },
  {
    name: "do not match as part of an identifier",
    input: "id_example.com_v2 should not match, but example.com should",
    expected: [{ href: "https://example.com/", shouldPreview: true }],
    expectedFirst: "https://example.com/",
  },
  {
    name: "exclude unix paths and relative paths",
    input: "See /etc/hosts and ./scripts/build.sh and ../src/index.ts",
    expected: [],
    expectedFirst: null,
  },
  {
    name: "exclude windows paths",
    input: "C:\\Windows\\System32\\drivers\\etc\\hosts and \\\\server\\share\\file.txt",
    expected: [],
    expectedFirst: null,
  },
];

for (const tc of cases) {
  const links = detectLinks(tc.input).map((l) => ({ href: l.href, shouldPreview: l.shouldPreview }));
  try {
    assert.deepEqual(links, tc.expected);
    assert.equal(extractFirstPreviewableUrl(tc.input), tc.expectedFirst);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("FAILED:", tc.name);
    // eslint-disable-next-line no-console
    console.error("input:", tc.input);
    // eslint-disable-next-line no-console
    console.error("got:", links, "first:", extractFirstPreviewableUrl(tc.input));
    // eslint-disable-next-line no-console
    console.error("expected:", tc.expected, "first:", tc.expectedFirst);
    throw e;
  }
}

// eslint-disable-next-line no-console
console.log(`link-detect: ${cases.length} cases passed`);

