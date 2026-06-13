import Database from 'better-sqlite3';
import fs from 'fs';

fs.mkdirSync('data', { recursive: true });
const db = new Database('data/queue.sqlite');

db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL DEFAULT 'draft',
  category TEXT,
  text TEXT NOT NULL,
  first_comment TEXT,
  image_prompt TEXT,
  verification_query TEXT,
  image_path TEXT,
  scheduled_at TEXT,
  posted_at TEXT,
  x_post_id TEXT,
  x_comment_id TEXT,
  error TEXT,
  impressions INTEGER DEFAULT 0,
  likes INTEGER DEFAULT 0,
  reposts INTEGER DEFAULT 0,
  replies INTEGER DEFAULT 0,
  quotes INTEGER DEFAULT 0,
  bookmarks INTEGER DEFAULT 0,
  analytics_synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_posts_status_schedule ON posts(status, scheduled_at);
`);

// Lightweight migrations for existing installations.
const postColumns = db.prepare(`PRAGMA table_info(posts)`).all().map(c => c.name);
const migrations = {
  image_prompt: 'TEXT',
  verification_query: 'TEXT',
  impressions: 'INTEGER DEFAULT 0',
  likes: 'INTEGER DEFAULT 0',
  reposts: 'INTEGER DEFAULT 0',
  replies: 'INTEGER DEFAULT 0',
  quotes: 'INTEGER DEFAULT 0',
  bookmarks: 'INTEGER DEFAULT 0',
  analytics_synced_at: 'TEXT'
};
for (const [column, type] of Object.entries(migrations)) {
  if (!postColumns.includes(column)) db.prepare(`ALTER TABLE posts ADD COLUMN ${column} ${type}`).run();
}


function normalizeStatus(status = 'draft') {
  const allowed = ['draft', 'scheduled', 'posting', 'posted', 'failed'];
  return allowed.includes(status) ? status : 'draft';
}

export function listPosts({ status = '', category = '' } = {}) {
  let sql = `SELECT * FROM posts WHERE 1=1`;
  const params = {};
  if (status) { sql += ` AND status = @status`; params.status = status; }
  if (category) { sql += ` AND category = @category`; params.category = category; }
  sql += ` ORDER BY COALESCE(scheduled_at, created_at) DESC`;
  return db.prepare(sql).all(params);
}

export function getCategories({ status = '' } = {}) {
  let sql = `
    SELECT category, COUNT(*) as count
    FROM posts
    WHERE category IS NOT NULL AND trim(category) <> ''
  `;
  const params = {};
  if (status) {
    sql += ` AND status = @status`;
    params.status = status;
  }
  sql += `
    GROUP BY category
    ORDER BY category COLLATE NOCASE ASC
  `;
  return db.prepare(sql).all(params);
}

export function getStats() {
  return db.prepare(`
    SELECT
      COALESCE(NULLIF(trim(category), ''), 'Uncategorized') AS category,
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) AS draft,
      SUM(CASE WHEN status = 'scheduled' THEN 1 ELSE 0 END) AS scheduled,
      SUM(CASE WHEN status = 'posted' THEN 1 ELSE 0 END) AS posted,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
      COALESCE(SUM(impressions), 0) AS impressions,
      COALESCE(SUM(likes), 0) AS likes,
      COALESCE(SUM(reposts), 0) AS reposts,
      COALESCE(SUM(replies), 0) AS replies,
      COALESCE(SUM(quotes), 0) AS quotes
    FROM posts
    GROUP BY COALESCE(NULLIF(trim(category), ''), 'Uncategorized')
    ORDER BY total DESC, category COLLATE NOCASE ASC
  `).all();
}

export function getPost(id) {
  return db.prepare(`SELECT * FROM posts WHERE id = ?`).get(id);
}

export function claimPostForPublishing(id) {
  const tx = db.transaction((postId) => {
    const existing = db.prepare(`SELECT * FROM posts WHERE id = ?`).get(postId);
    if (!existing) return { claimed: false, reason: 'not_found', post: null };
    if (existing.status === 'posted') return { claimed: false, reason: 'already_posted', post: existing };
    if (existing.status === 'posting') return { claimed: false, reason: 'already_posting', post: existing };
    const info = db.prepare(`
      UPDATE posts
      SET status = 'posting', error = NULL, updated_at = datetime('now')
      WHERE id = @id AND status NOT IN ('posted', 'posting')
    `).run({ id: postId });
    if (info.changes !== 1) return { claimed: false, reason: 'claim_failed', post: existing };
    return { claimed: true, reason: 'claimed', post: db.prepare(`SELECT * FROM posts WHERE id = ?`).get(postId) };
  });
  return tx(Number(id));
}

export function createPost({ status='draft', category='', text, first_comment='', image_prompt='', verification_query='', image_path=null, scheduled_at=null }) {
  const info = db.prepare(`
    INSERT INTO posts (status, category, text, first_comment, image_prompt, verification_query, image_path, scheduled_at)
    VALUES (@status, @category, @text, @first_comment, @image_prompt, @verification_query, @image_path, @scheduled_at)
  `).run({ status: normalizeStatus(status), category, text, first_comment, image_prompt, verification_query, image_path, scheduled_at });
  return { id: Number(info.lastInsertRowid), changes: info.changes };
}

export function updatePost(id, fields) {
  const allowed = ['status','category','text','first_comment','image_prompt','verification_query','image_path','scheduled_at','posted_at','x_post_id','x_comment_id','error','impressions','likes','reposts','replies','quotes','bookmarks','analytics_synced_at'];
  if (fields.status) fields.status = normalizeStatus(fields.status);
  const keys = Object.keys(fields).filter(k => allowed.includes(k));
  if (!keys.length) return;
  const set = keys.map(k => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE posts SET ${set}, updated_at = datetime('now') WHERE id = @id`).run({ id, ...fields });
}

export function deletePost(id) {
  db.prepare(`DELETE FROM posts WHERE id = ?`).run(id);
}

export function recentPostMemory(limit = 300) {
  return db.prepare(`
    SELECT id, category, text, first_comment, image_prompt, verification_query, created_at, scheduled_at
    FROM posts
    WHERE text IS NOT NULL AND trim(text) <> ''
    ORDER BY id DESC
    LIMIT ?
  `).all(Number(limit) || 300);
}

export function postedPostsForAnalytics(limit = 50) {
  return db.prepare(`
    SELECT * FROM posts
    WHERE status = 'posted'
      AND x_post_id IS NOT NULL
      AND trim(x_post_id) <> ''
    ORDER BY COALESCE(analytics_synced_at, '1970-01-01') ASC, posted_at DESC
    LIMIT ?
  `).all(Number(limit) || 50);
}

export function analyticsOverview() {
  const totals = db.prepare(`
    SELECT
      COUNT(*) AS posted_count,
      COALESCE(SUM(impressions), 0) AS impressions,
      COALESCE(SUM(likes), 0) AS likes,
      COALESCE(SUM(reposts), 0) AS reposts,
      COALESCE(SUM(replies), 0) AS replies,
      COALESCE(SUM(quotes), 0) AS quotes,
      COALESCE(SUM(bookmarks), 0) AS bookmarks
    FROM posts
    WHERE status = 'posted'
  `).get();
  const topPosts = db.prepare(`
    SELECT id, category, text, scheduled_at, posted_at, x_post_id, impressions, likes, reposts, replies, quotes, bookmarks, analytics_synced_at
    FROM posts
    WHERE status = 'posted'
    ORDER BY impressions DESC, likes DESC, id DESC
    LIMIT 20
  `).all();
  const byCategory = db.prepare(`
    SELECT
      COALESCE(NULLIF(trim(category), ''), 'Uncategorized') AS category,
      COUNT(*) AS posts,
      COALESCE(SUM(impressions), 0) AS impressions,
      COALESCE(SUM(likes), 0) AS likes,
      COALESCE(SUM(reposts), 0) AS reposts,
      COALESCE(SUM(replies), 0) AS replies,
      COALESCE(SUM(quotes), 0) AS quotes,
      COALESCE(SUM(bookmarks), 0) AS bookmarks,
      ROUND(COALESCE(AVG(impressions), 0), 1) AS avg_impressions
    FROM posts
    WHERE status = 'posted'
    GROUP BY COALESCE(NULLIF(trim(category), ''), 'Uncategorized')
    ORDER BY impressions DESC
  `).all();
  return { totals, topPosts, byCategory };
}

export function duePosts(nowLocal) {
  return db.prepare(`
    SELECT * FROM posts
    WHERE status = 'scheduled'
      AND scheduled_at IS NOT NULL
      AND scheduled_at <= ?
    ORDER BY scheduled_at ASC
    LIMIT 5
  `).all(nowLocal);
}
