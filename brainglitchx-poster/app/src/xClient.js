import { TwitterApi, TwitterApiV2Settings } from 'twitter-api-v2';
import fs from 'fs';
import path from 'path';

TwitterApiV2Settings.deprecationWarnings = false;

const required = ['X_APP_KEY','X_APP_SECRET','X_ACCESS_TOKEN','X_ACCESS_SECRET'];
const X_TEXT_LIMIT = 280;

function getClient() {
  for (const key of required) {
    if (!process.env[key]) throw new Error(`Missing ${key} in .env`);
  }
  return new TwitterApi({
    appKey: process.env.X_APP_KEY,
    appSecret: process.env.X_APP_SECRET,
    accessToken: process.env.X_ACCESS_TOKEN,
    accessSecret: process.env.X_ACCESS_SECRET,
  });
}

function guessMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/jpeg';
}

export async function publishPost(post) {
  assertTweetLength(post.text, 'Post text');
  if (post.first_comment && post.first_comment.trim()) assertTweetLength(post.first_comment.trim(), 'First comment');

  if (process.env.DRY_RUN === 'true') {
    console.log('[DRY_RUN] Would post:', post.text);
    return { postId: `dry-${Date.now()}`, commentId: post.first_comment ? `dry-comment-${Date.now()}` : null };
  }

  const client = getClient();
  const mediaIds = [];

  if (post.image_path && fs.existsSync(post.image_path)) {
    const mediaId = await client.v1.uploadMedia(post.image_path, {
      mimeType: guessMimeType(post.image_path),
    });
    mediaIds.push(mediaId);
  }

  const tweetPayload = mediaIds.length
    ? { text: post.text, media: { media_ids: mediaIds } }
    : { text: post.text };

  const created = await client.v2.tweet(tweetPayload);
  const postId = created.data.id;

  let commentId = null;
  let commentError = null;
  if (post.first_comment && post.first_comment.trim()) {
    try {
      const reply = await client.v2.tweet({
        text: post.first_comment.trim(),
        reply: { in_reply_to_tweet_id: postId }
      });
      commentId = reply.data.id;
    } catch (e) {
      commentError = readableXError(e);
      console.error('[x:reply-failed-after-post]', { postId, error: commentError });
    }
  }

  return { postId, commentId, commentError };
}

function assertTweetLength(text = '', label = 'Text') {
  const length = [...String(text || '')].length;
  if (length > X_TEXT_LIMIT) {
    const err = new Error(`${label} is ${length - X_TEXT_LIMIT} characters over the X limit (${length}/${X_TEXT_LIMIT}). Shorten it before posting.`);
    err.code = 'X_TEXT_TOO_LONG';
    throw err;
  }
}

function readableXError(e) {
  if (e?.data?.title || e?.data?.detail) return `${e.data.title || 'X API error'}: ${e.data.detail || e.message}`;
  return e?.message || String(e);
}

function normalizeMetrics(tweet) {
  const publicMetrics = tweet?.data?.public_metrics || tweet?.public_metrics || {};
  const nonPublicMetrics = tweet?.data?.non_public_metrics || tweet?.non_public_metrics || {};
  const organicMetrics = tweet?.data?.organic_metrics || tweet?.organic_metrics || {};
  return {
    impressions: Number(publicMetrics.impression_count ?? organicMetrics.impression_count ?? nonPublicMetrics.impression_count ?? 0),
    likes: Number(publicMetrics.like_count ?? 0),
    reposts: Number(publicMetrics.retweet_count ?? 0),
    replies: Number(publicMetrics.reply_count ?? 0),
    quotes: Number(publicMetrics.quote_count ?? 0),
    bookmarks: Number(publicMetrics.bookmark_count ?? 0),
  };
}

export async function fetchPostAnalytics(postId) {
  if (!postId) throw new Error('Missing postId');
  if (!/^\d+$/.test(String(postId))) {
    const err = new Error(`Skipping analytics for non-X post id: ${postId}`);
    err.code = 'INVALID_X_POST_ID';
    throw err;
  }
  const client = getClient();
  const requestedFields = ['public_metrics'];
  if (process.env.ANALYTICS_PRIVATE_METRICS === 'true') {
    requestedFields.push('non_public_metrics', 'organic_metrics');
  }
  try {
    const tweet = await client.v2.singleTweet(String(postId), { 'tweet.fields': requestedFields });
    return normalizeMetrics(tweet);
  } catch (e) {
    // Some plans/tokens do not allow private/organic metrics. Retry with public metrics only.
    if (requestedFields.length > 1) {
      const tweet = await client.v2.singleTweet(String(postId), { 'tweet.fields': ['public_metrics'] });
      return normalizeMetrics(tweet);
    }
    throw e;
  }
}
