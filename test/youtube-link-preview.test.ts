import assert from "node:assert/strict";
import { extractYouTubeVideoId, isYouTubeUrl } from "../src/lib/youtube";

type Case = {
  name: string;
  url: string;
  expectedId: string | null;
  isYouTube: boolean;
};

const ID = "dQw4w9WgXcQ";

const cases: Case[] = [
  { name: "watch", url: `https://www.youtube.com/watch?v=${ID}`, expectedId: ID, isYouTube: true },
  { name: "watch with params", url: `https://youtube.com/watch?v=${ID}&si=abc&t=43&feature=share`, expectedId: ID, isYouTube: true },
  { name: "m.youtube", url: `https://m.youtube.com/watch?v=${ID}&list=PL123`, expectedId: ID, isYouTube: true },
  { name: "music.youtube", url: `https://music.youtube.com/watch?v=${ID}&feature=share`, expectedId: ID, isYouTube: true },
  { name: "gaming.youtube", url: `https://gaming.youtube.com/watch?v=${ID}`, expectedId: ID, isYouTube: true },
  { name: "youtu.be short", url: `https://youtu.be/${ID}?si=xyz&t=12`, expectedId: ID, isYouTube: true },
  { name: "shorts", url: `https://www.youtube.com/shorts/${ID}?feature=share`, expectedId: ID, isYouTube: true },
  { name: "live", url: `https://www.youtube.com/live/${ID}?si=1`, expectedId: ID, isYouTube: true },
  { name: "embed", url: `https://www.youtube.com/embed/${ID}?start=10`, expectedId: ID, isYouTube: true },
  { name: "legacy v", url: `https://www.youtube.com/v/${ID}?version=3`, expectedId: ID, isYouTube: true },
  {
    name: "attribution_link with nested watch",
    url: `https://www.youtube.com/attribution_link?a=foo&u=%2Fwatch%3Fv%3D${ID}%26feature%3Dshare`,
    expectedId: ID,
    isYouTube: true,
  },
  {
    name: "external redirect with nested youtube url",
    url: `https://example.com/redirect?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${ID}&si=tt`)}`,
    expectedId: ID,
    isYouTube: false,
  },
  { name: "non-youtube link", url: "https://vimeo.com/148751763", expectedId: null, isYouTube: false },
];

for (const tc of cases) {
  const got = extractYouTubeVideoId(tc.url);
  try {
    assert.equal(got, tc.expectedId);
    assert.equal(isYouTubeUrl(tc.url), tc.isYouTube);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("FAILED:", tc.name);
    // eslint-disable-next-line no-console
    console.error("url:", tc.url);
    // eslint-disable-next-line no-console
    console.error("got:", got, "isYouTube:", isYouTubeUrl(tc.url));
    // eslint-disable-next-line no-console
    console.error("expected:", tc.expectedId, "isYouTube:", tc.isYouTube);
    throw e;
  }
}

// eslint-disable-next-line no-console
console.log(`youtube-link-preview: ${cases.length} cases passed`);
