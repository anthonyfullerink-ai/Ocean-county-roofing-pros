#!/usr/bin/env node
/**
 * Prune duplicate automated Facebook posts from Page 1466735946524886
 * posted between Nov 13–16, 2026 by application "Ocean County Roofing Pros Auto",
 * while preserving Manual/Web posts.
 *
 * Usage:
 *   META_ACCESS_TOKEN=... node scripts/prune_duplicate_fb_posts.mjs          # dry-run (default)
 *   META_ACCESS_TOKEN=... node scripts/prune_duplicate_fb_posts.mjs --execute
 */

const GRAPH_BASE = "https://graph.facebook.com/v21.0";
const PAGE_ID = (process.env.META_PAGE_ID || "1466735946524886").trim();
const TOKEN = (process.env.META_ACCESS_TOKEN || "").trim();
const TARGET_APP_NAME = "Ocean County Roofing Pros Auto";
const START_ISO = "2026-11-13T00:00:00Z";
const END_ISO = "2026-11-17T04:59:59Z"; // covers through Nov 16 23:59:59 EST
const EXECUTE = process.argv.includes("--execute");

if (!TOKEN) {
  console.error("ERROR: META_ACCESS_TOKEN environment variable is required.");
  process.exit(1);
}

async function fetchAllPosts() {
  const posts = [];
  let nextUrl = `${GRAPH_BASE}/${encodeURIComponent(PAGE_ID)}/published_posts?fields=id,created_time,message,application&limit=100&access_token=${encodeURIComponent(TOKEN)}`;
  while (nextUrl) {
    const res = await fetch(nextUrl);
    const data = await res.json();
    if (!res.ok) {
      throw new Error(`Graph API list error (${res.status}): ${JSON.stringify(data)}`);
    }
    if (Array.isArray(data.data)) {
      posts.push(...data.data);
    }
    nextUrl = data?.paging?.next || null;
  }
  return posts;
}

async function main() {
  const startMs = Date.parse(START_ISO);
  const endMs = Date.parse(END_ISO);
  const allPosts = await fetchAllPosts();

  const toDelete = [];
  const preserved = [];

  for (const post of allPosts) {
    const appName = post?.application?.name || "Manual/Web";
    const createdMs = Date.parse(post.created_time || "");
    const inWindow = Number.isFinite(createdMs) && createdMs >= startMs && createdMs <= endMs;

    if (appName === TARGET_APP_NAME && inWindow) {
      toDelete.push(post);
    } else {
      preserved.push({ id: post.id, created_time: post.created_time, appName });
    }
  }

  console.log(`Total posts scanned: ${allPosts.length}`);
  console.log(`Preserved posts: ${preserved.length}`);
  console.log(`Target duplicate automated posts to delete (${TARGET_APP_NAME}, Nov 13-16): ${toDelete.length}`);

  if (!EXECUTE) {
    console.log("Dry-run complete. Re-run with --execute to delete the target posts.");
    return;
  }

  let deleted = 0;
  let failed = 0;
  const BATCH_SIZE = 8;
  for (let i = 0; i < toDelete.length; i += BATCH_SIZE) {
    const batch = toDelete.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async (post) => {
        const delRes = await fetch(
          `${GRAPH_BASE}/${encodeURIComponent(post.id)}?access_token=${encodeURIComponent(TOKEN)}`,
          { method: "DELETE" }
        );
        if (delRes.ok) {
          deleted++;
        } else {
          failed++;
          const errBody = await delRes.text().catch(() => "");
          console.error(`Failed to delete ${post.id} (${delRes.status}): ${errBody}`);
        }
      })
    );
  }
  console.log(`Done. Deleted: ${deleted}, Failed: ${failed}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
