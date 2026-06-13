import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import cron from 'node-cron';
import XLSX from 'xlsx';
import { fileURLToPath } from 'url';
import { createPost, deletePost, duePosts, getCategories, getPost, getStats, listPosts, recentPostMemory, updatePost, postedPostsForAnalytics, analyticsOverview, claimPostForPublishing } from './db.js';
import { publishPost, fetchPostAnalytics } from './xClient.js';
import { generateOpenAIBrainGlitch, generateOpenAIBrainGlitchBatch, generateOpenAIImage, isDuplicateIdea } from './openaiGenerator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const uploadDir = path.join(process.cwd(), 'public', 'uploads');
const importDir = path.join(process.cwd(), 'data', 'imports');
fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(importDir, { recursive: true });


const generationJobs = new Map();

function createJob(kind) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const job = { id, kind, status: 'running', progress: 0, message: 'Starting...', createdAt: new Date().toISOString(), result: null, error: null };
  generationJobs.set(id, job);
  return job;
}

function updateJob(id, patch) {
  const current = generationJobs.get(id);
  if (!current) return null;
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  generationJobs.set(id, next);
  return next;
}

function publicJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    progress: Math.max(0, Math.min(100, Math.round(job.progress || 0))),
    message: job.message || '',
    result: job.result || null,
    error: job.error || null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt || job.createdAt
  };
}

function cleanupOldJobs() {
  const cutoff = Date.now() - 1000 * 60 * 60 * 6;
  for (const [id, job] of generationJobs.entries()) {
    const t = Date.parse(job.updatedAt || job.createdAt || 0);
    if (Number.isFinite(t) && t < cutoff) generationJobs.delete(id);
  }
}
setInterval(cleanupOldJobs, 1000 * 60 * 30).unref?.();

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase() || '.jpg';
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Only images are allowed'));
    cb(null, true);
  }
});

const importUpload = multer({ dest: importDir, limits: { fileSize: 5 * 1024 * 1024 } });

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/uploads', express.static(uploadDir));
app.use('/static', express.static(path.join(__dirname, '..', 'public')));

function requirePassword(req, res, next) {
  // Home Assistant Ingress already protects the UI with HA authentication.
  // In add-on mode we skip the app-level ?key=... check so sidebar/Ingress works.
  if (process.env.HA_INGRESS === 'true') return next();

  const password = process.env.APP_PASSWORD;
  const provided = req.headers.authorization?.replace('Bearer ', '') || req.query.key || req.body?.key;
  if (!password || password === 'change-me-now') return next();
  if (provided === password) return next();
  res.status(401).send('Unauthorized. Add ?key=YOUR_APP_PASSWORD to the URL or use Authorization: Bearer token.');
}

function keyQuery(req) {
  return req.query.key ? `?key=${encodeURIComponent(req.query.key)}` : '';
}

function hiddenKey(req) {
  return req.query.key ? `<input type="hidden" name="key" value="${escapeAttr(req.query.key)}">` : '';
}

function relativePrefix(req) {
  const depth = String(req.path || '').split('/').filter(Boolean).length;
  // Browser-relative URLs are resolved from the current route's directory.
  // For /edit/1, "../" returns to the add-on root; "../../" escapes the
  // Home Assistant Ingress token path and causes /api/hassio_ingress/ 404s.
  return depth > 1 ? '../'.repeat(depth - 1) : '';
}

function page(req, title, body) {
  let inlineCss = '';
  let inlineJs = '';
  try { inlineCss = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8'); } catch {}
  try { inlineJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8'); } catch {}
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${inlineCss}</style></head><body><main><h1>${title}</h1>${body}</main><script>${inlineJs}</script></body></html>`;
}

function appTimezone() {
  return process.env.TIMEZONE || 'Europe/Berlin';
}

function localParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: appTimezone(),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(date);
  const get = type => parts.find(p => p.type === type)?.value;
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute') };
}

function toLocalInputValue(value) {
  if (!value) return '';
  return String(value).slice(0, 16);
}

function formatLocalDisplay(value) {
  if (!value) return '';
  const raw = String(value).slice(0, 16);
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return raw;
  return `${m[3]}.${m[2]}.${m[1]} ${m[4]}:${m[5]}`;
}

function localDateFromStored(value) {
  const raw = String(value || '').slice(0, 16);
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0);
}

function relativeLocal(value) {
  const target = localDateFromStored(value);
  const now = localDateFromStored(nowLocalMinute());
  if (!target || !now) return '';
  const diffMin = Math.round((target.getTime() - now.getTime()) / 60000);
  if (Math.abs(diffMin) < 1) return 'now';
  const past = diffMin < 0;
  const abs = Math.abs(diffMin);
  const days = Math.floor(abs / 1440);
  const hours = Math.floor((abs % 1440) / 60);
  const mins = abs % 60;
  let text = '';
  if (days) text = `${days}d ${hours}h`;
  else if (hours) text = `${hours}h ${mins}m`;
  else text = `${mins}m`;
  return past ? `${text} ago` : `in ${text}`;
}

function scheduleCell(value) {
  if (!value) return '';
  const display = formatLocalDisplay(value);
  const rel = relativeLocal(value);
  return `${escapeHtml(display)}${rel ? `<br><small>${escapeHtml(rel)}</small>` : ''}`;
}

function nowLocalMinute() {
  const p = localParts();
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

function addMinutesToLocal(dateStr, minutes) {
  // dateStr is stored as a local wall-clock value (YYYY-MM-DDTHH:mm).
  // Do arithmetic without converting through UTC, so Docker host timezone cannot shift it.
  const [datePart, timePart = '00:00'] = String(dateStr).split('T');
  const [y, m, d] = datePart.split('-').map(Number);
  const [hh, mm] = timePart.split(':').map(Number);
  const dt = new Date(y, m - 1, d, hh || 0, mm || 0, 0);
  dt.setMinutes(dt.getMinutes() + minutes);
  const pad = n => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth()+1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}

function todayLocalDate() {
  return nowLocalMinute().slice(0, 10);
}

function publicImageUrl(imagePath) {
  return imagePath ? String(imagePath).replace('public/','') : '';
}

function imageUrl(req, imagePath) {
  const url = publicImageUrl(imagePath);
  if (!url) return '';
  return `${relativePrefix(req)}${url}`;
}

function imageLink(req, imagePath, imgClass = 'thumb') {
  const url = publicImageUrl(imagePath);
  if (!url) return '';
  const fallback = imageUrl(req, imagePath);
  const attr = escapeAttr(url);
  const href = escapeAttr(fallback);
  return `<a href="${href}" data-bg-url="${attr}" target="_blank" rel="noopener"><img class="${escapeAttr(imgClass)}" src="${href}" data-bg-url="${attr}"></a>`;
}

function rel(req, target = '') {
  const clean = String(target || '').replace(/^\/+/, '');
  return `${relativePrefix(req)}${clean}`;
}

function parseCategories(value) {
  if (Array.isArray(value)) return value.flatMap(v => parseCategories(v));
  return String(value || '').split(',').map(v => v.trim()).filter(Boolean);
}

const DEFAULT_CATEGORIES = ['History','Space','Science','Nature','Weird Facts','Human Body','Statistics','Technology','Geography'];

function existingIdeasMemory(extra = []) {
  return [...recentPostMemory(Number(process.env.DEDUPE_MEMORY_LIMIT || 300)), ...extra];
}

function applyRequestedCategory(generated, requestedCategory = '') {
  const requested = String(requestedCategory || '').trim();
  if (!requested) return generated;
  return { ...generated, category: requested };
}

function assertCreated(info, context = 'post') {
  if (!info || Number(info.changes) !== 1 || !info.id) {
    throw new Error(`Database insert failed for ${context}`);
  }
  return info;
}

async function generateUniqueBrainGlitch({ category = '', topic = '' } = {}) {
  const existing = existingIdeasMemory();
  let last = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    let generated = await generateOpenAIBrainGlitch({ category, topic, avoidFacts: existing });
    generated = applyRequestedCategory(generated, category);
    last = generated;
    if (!isDuplicateIdea(generated, existing)) return { generated, duplicateAttempts: attempt - 1 };
    existing.unshift(generated);
  }
  throw new Error(`OpenAI kept generating duplicate facts. Last candidate: ${last?.fact || last?.text || 'unknown'}`);
}

async function generateUniqueBrainGlitchBatch({ count, categories = [], topic = '' } = {}) {
  const wanted = Math.max(1, Math.min(Number(count) || 5, 12));
  const existing = existingIdeasMemory();
  const accepted = [];
  let duplicateCount = 0;

  for (let attempt = 1; attempt <= 4 && accepted.length < wanted; attempt++) {
    const remaining = wanted - accepted.length;
    const requestCount = Math.min(12, Math.max(remaining + 2, remaining));
    const candidates = await generateOpenAIBrainGlitchBatch({
      count: requestCount,
      categories,
      topic,
      avoidFacts: existing
    });

    for (let candidate of candidates) {
      if (accepted.length >= wanted) break;
      if (categories.length === 1) candidate = applyRequestedCategory(candidate, categories[0]);
      const memory = [...existing, ...accepted];
      if (isDuplicateIdea(candidate, memory)) {
        duplicateCount++;
        existing.unshift(candidate);
        continue;
      }
      accepted.push(candidate);
    }
  }

  if (!accepted.length) throw new Error('OpenAI generated only duplicate facts. Try different categories or a topic hint.');
  return { items: accepted, duplicateCount };
}

function categoryMultiSelect(selected = []) {
  const set = new Set(selected);
  return `<div class="checkbox-grid">${DEFAULT_CATEGORIES.map(cat => `
    <label class="check-pill"><input type="checkbox" name="categories" value="${escapeAttr(cat)}" ${set.has(cat) ? 'checked' : ''}> ${escapeHtml(cat)}</label>`).join('')}
  </div>
  <label>Additional categories, comma separated <input name="categories_extra" placeholder="e.g. Football, Ancient Civilizations"></label>`;
}

function requestedGenerateMode(body = {}) {
  return body.mode || body.action || '';
}

function statusForGenerate(body = {}) {
  const mode = requestedGenerateMode(body);
  if (mode === 'post_now') return 'posting';
  if (mode === 'schedule') return 'scheduled';
  return body.status || 'draft';
}

function scheduleForGenerate(body = {}) {
  const mode = requestedGenerateMode(body);
  if (mode === 'schedule') return body.scheduled_at || addMinutesToLocal(nowLocalMinute(), 15);
  if ((body.status || '') === 'scheduled') return body.scheduled_at || addMinutesToLocal(nowLocalMinute(), 15);
  return body.scheduled_at || null;
}

async function publishExistingPost(id) {
  const claim = claimPostForPublishing(id);
  if (!claim.claimed) {
    const reason = claim.reason || 'not_claimed';
    if (reason === 'already_posted') {
      console.warn('[post-now:blocked-already-posted]', { postId: Number(id), xPostId: claim.post?.x_post_id || null });
      return { postId: claim.post?.x_post_id || null, commentId: claim.post?.x_comment_id || null, skipped: true, reason };
    }
    if (reason === 'already_posting') {
      console.warn('[post-now:blocked-already-posting]', { postId: Number(id) });
      throw new Error(`Post ${id} is already being published. Please wait.`);
    }
    throw new Error(`Post ${id} could not be claimed for publishing: ${reason}`);
  }
  try {
    const latest = claim.post;
    const result = await publishPost(latest);
    updatePost(latest.id, {
      status: 'posted',
      posted_at: nowLocalMinute(),
      x_post_id: result.postId,
      x_comment_id: result.commentId,
      error: result.commentError ? `First comment failed: ${result.commentError}` : null
    });
    return result;
  } catch (e) {
    updatePost(Number(id), { status: 'failed', error: readableError(e) });
    throw e;
  }
}

function minutesFromTime(time = '00:00') {
  const [h, m] = String(time).split(':').map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

function localFromDateAndMinutes(date, totalMinutes) {
  const dayOffset = Math.floor(totalMinutes / 1440);
  const minutesInDay = ((totalMinutes % 1440) + 1440) % 1440;
  const [y, m, d] = String(date).split('-').map(Number);
  const dt = new Date(y, m - 1, d + dayOffset, 0, minutesInDay, 0);
  const pad = n => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth()+1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}

function randomScheduleSlots({ date, startTime, endTime, count }) {
  const n = Math.max(1, Number(count) || 1);
  let start = minutesFromTime(startTime || '09:00');
  let end = minutesFromTime(endTime || '21:00');
  if (end <= start) end += 1440;
  const span = Math.max(1, end - start);
  if (n === 1) {
    const minute = start + Math.floor(Math.random() * (span + 1));
    return [localFromDateAndMinutes(date, minute)];
  }

  // Divide the selected range into one slot per post. Pick one random time inside each slot.
  // This keeps posts random while avoiding clusters and keeping natural spacing.
  const slot = span / n;
  const times = [];
  for (let i = 0; i < n; i++) {
    const slotStart = start + slot * i;
    const slotEnd = start + slot * (i + 1);
    const margin = Math.min(20, Math.floor(slot * 0.18));
    const min = Math.ceil(slotStart + margin);
    const max = Math.floor(slotEnd - margin);
    const picked = max > min ? min + Math.floor(Math.random() * (max - min + 1)) : Math.round((slotStart + slotEnd) / 2);
    times.push(localFromDateAndMinutes(date, picked));
  }
  return times.sort();
}

function postForm(req, post = null) {
  const isEdit = Boolean(post);
  const action = isEdit ? `${keyQuery(req) || ''}` : `${rel(req, 'posts')}${keyQuery(req)}`;
  return `
    <form method="post" action="${action}" enctype="multipart/form-data">
      ${hiddenKey(req)}
      <div class="grid2">
        <label>Category <input name="category" placeholder="Nature" value="${escapeAttr(post?.category || '')}"></label>
        <label>Status <select name="status">
          ${['draft','scheduled','posted','failed'].map(s => `<option value="${s}" ${post?.status === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select></label>
      </div>
      <label>Schedule <input type="datetime-local" name="scheduled_at" value="${escapeAttr(toLocalInputValue(post?.scheduled_at))}"><small>Uses your local time. No manual 2-hour workaround needed anymore.</small></label>
      <label>Post text <textarea name="text" required rows="6">${escapeHtml(post?.text || '')}</textarea></label>
      <label>First comment <textarea name="first_comment" rows="3">${escapeHtml(post?.first_comment || '')}</textarea></label>
      <label>Image prompt <textarea name="image_prompt" rows="3" placeholder="Prompt for image generation, no text, no watermark...">${escapeHtml(post?.image_prompt || '')}</textarea></label>
      <label>Verification query <input name="verification_query" placeholder="Search query to fact-check before posting" value="${escapeAttr(post?.verification_query || '')}"></label>
      ${post?.image_path ? `<div class="current-image"><p>Current image:</p>${imageLink(req, post.image_path, 'thumb large')}<p><a href="${escapeAttr(imageUrl(req, post.image_path))}" data-bg-url="${escapeAttr(publicImageUrl(post.image_path))}" target="_blank" rel="noopener">Open full-size image</a></p><label class="inline danger-check"><input type="checkbox" name="remove_image" value="1"> Remove current image</label></div>` : ''}
      <label>${isEdit ? 'Replace image' : 'Image'} <input type="file" name="image" accept="image/*"></label>
      <div class="button-row">
        <button type="submit" name="action" value="save">${isEdit ? 'Save changes' : 'Save draft'}</button>
        <button type="submit" name="action" value="schedule">Save & schedule</button>
        <button type="submit" name="action" value="post_now" class="secondary" onclick="if(!confirm('Post this to X now?')) return false; this.disabled=true; this.textContent='Posting...'; this.form.submit(); return false;">Post now</button>
      </div>
    </form>`;
}

function appLink(req, params = {}) {
  const q = new URLSearchParams();
  if (req.query.key) q.set('key', req.query.key);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') q.set(k, v);
  }
  const qs = q.toString();
  const prefix = relativePrefix(req);
  // Under Home Assistant Ingress, routes like /edit/1 or /publish/1 live below
  // /api/hassio_ingress/<token>/. Navigation must climb back to the add-on root.
  // A plain ?tab=queue would stay on /edit/1?tab=queue and break all tabs/forms.
  return `${prefix || './'}${qs ? '?' + qs : ''}`;
}

function backLink(req, tab = 'queue', label = 'Back') {
  return `<p><a href="${appLink(req, { tab })}">${escapeHtml(label)}</a></p>`;
}

function tabNav(req, active) {
  const tabs = [
    ['queue', 'Queue'],
    ['new', 'New Post'],
    ['generate', 'Generate'],
    ['dayplanner', 'Plan Day'],
    ['import', 'Import'],
    ['stats', 'Stats'],
    ['analytics', 'Analytics'],
  ];
  return `<nav class="tabs">${tabs.map(([id, label]) => `<a class="tab ${active === id ? 'active' : ''}" href="${appLink(req, { tab: id })}">${label}</a>`).join('')}</nav>`;
}


function headerBlock(req) {
  return `<div class="topbar"><div><strong>DRY_RUN:</strong> ${escapeHtml(process.env.DRY_RUN || '')} · <strong>Scheduler time:</strong> ${escapeHtml(nowLocalMinute())} · <strong>TIMEZONE:</strong> ${escapeHtml(appTimezone())}</div><form method="post" action="${rel(req, 'scheduler/run-now')}${keyQuery(req)}" class="inline-form">${hiddenKey(req)}<button type="submit">Run scheduler now</button><span class="hint">Useful for testing due posts immediately.</span></form></div>`;
}

app.get('/', requirePassword, (req, res) => {
  const tab = req.query.tab || 'queue';
  const status = req.query.status || '';
  const category = req.query.category || '';

  const rows = listPosts({ status, category }).map(p => `
    <tr>
      <td><span class="badge ${p.status}">${p.status}</span></td>
      <td>${scheduleCell(p.scheduled_at)}</td>
      <td>${escapeHtml(p.category || '')}</td>
      <td class="textcell">${escapeHtml(p.text).replaceAll('\n','<br>')}${p.first_comment ? `<details><summary>First comment</summary>${escapeHtml(p.first_comment).replaceAll('\n','<br>')}</details>` : ''}${p.image_prompt ? `<details><summary>Image prompt</summary>${escapeHtml(p.image_prompt).replaceAll('\n','<br>')}</details>` : ''}${p.verification_query ? `<details><summary>Verify</summary>${escapeHtml(p.verification_query)}</details>` : ''}</td>
      <td>${p.image_path ? imageLink(req, p.image_path, 'thumb') : ''}</td>
      <td class="metrics"><strong>${Number(p.impressions || 0).toLocaleString('en-US')}</strong> views<br>${Number(p.likes || 0).toLocaleString('en-US')} likes · ${Number(p.reposts || 0).toLocaleString('en-US')} reposts<br>${p.analytics_synced_at ? `<small>sync ${escapeHtml(p.analytics_synced_at)}</small>` : '<small>not synced</small>'}</td>
      <td>${p.x_post_id ? `<a target="_blank" href="https://x.com/BrainGlitchX/status/${p.x_post_id}">Open</a>` : escapeHtml(p.error || '')}</td>
      <td class="actions">
        <a class="buttonlink" href="${rel(req, `edit/${p.id}`)}${keyQuery(req)}">Edit</a>
        ${p.status !== 'posted' ? `<form method="post" action="${rel(req, `publish/${p.id}`)}${keyQuery(req)}" onsubmit="if(!confirm('Post this to X now?')) return false; this.querySelector('button').disabled=true; this.querySelector('button').textContent='Posting...'; return true;">${hiddenKey(req)}<button class="secondary">Post now</button></form>` : ''}
        <form method="post" action="${rel(req, `delete/${p.id}`)}${keyQuery(req)}" onsubmit="return confirm('Delete post?')"><button>Delete</button></form>
      </td>
    </tr>`).join('');

  const categories = getCategories({ status });
  const stats = getStats();
  const categoryOptions = categories.map(c => `<option value="${escapeAttr(c.category)}" ${category === c.category ? 'selected' : ''}>${escapeHtml(c.category)} (${c.count})</option>`).join('');
  const statsRows = stats.map(s => `<tr><td>${escapeHtml(s.category)}</td><td>${s.total}</td><td>${s.draft}</td><td>${s.scheduled}</td><td>${s.posted}</td><td>${s.failed}</td><td>${Number(s.impressions || 0).toLocaleString('en-US')}</td><td>${Number(s.likes || 0).toLocaleString('en-US')}</td><td>${Number(s.reposts || 0).toLocaleString('en-US')}</td></tr>`).join('');
  const analytics = analyticsOverview();
  const analyticsTotals = analytics.totals || {};
  const analyticsRows = analytics.topPosts.map(p => `<tr><td>${scheduleCell(p.posted_at)}</td><td>${escapeHtml(p.category || '')}</td><td class="textcell">${escapeHtml(p.text || '').replaceAll('\n','<br>')}</td><td>${Number(p.impressions || 0).toLocaleString('en-US')}</td><td>${Number(p.likes || 0).toLocaleString('en-US')}</td><td>${Number(p.reposts || 0).toLocaleString('en-US')}</td><td>${Number(p.replies || 0).toLocaleString('en-US')}</td><td>${Number(p.quotes || 0).toLocaleString('en-US')}</td><td>${p.x_post_id ? `<a target="_blank" href="https://x.com/BrainGlitchX/status/${p.x_post_id}">Open</a>` : ''}</td></tr>`).join('');
  const analyticsCategoryRows = analytics.byCategory.map(c => `<tr><td>${escapeHtml(c.category)}</td><td>${c.posts}</td><td>${Number(c.impressions || 0).toLocaleString('en-US')}</td><td>${Number(c.avg_impressions || 0).toLocaleString('en-US')}</td><td>${Number(c.likes || 0).toLocaleString('en-US')}</td><td>${Number(c.reposts || 0).toLocaleString('en-US')}</td><td>${Number(c.replies || 0).toLocaleString('en-US')}</td></tr>`).join('');

  const header = headerBlock(req);

  const progressPanel = `<div class="progress-panel" id="generation-progress" hidden><div class="progress-head"><strong id="progress-title">Generating...</strong><span id="progress-percent">0%</span></div><div class="progress-bar"><div id="progress-fill" style="width:0%"></div></div><p id="progress-message" class="hint">Starting...</p><p id="progress-result"></p></div>`;

  const sections = {
    queue: `
      <section class="card">
        <h2>Queue</h2>
        <form method="get" action="${appLink(req)}" class="filters">
          ${req.query.key ? `<input type="hidden" name="key" value="${escapeAttr(req.query.key)}">` : ''}
          <input type="hidden" name="tab" value="queue">
          <select name="status"><option value="">All statuses</option>${['draft','scheduled','posting','posted','failed'].map(s => `<option value="${s}" ${status === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
          <select name="category"><option value="">All categories</option>${categoryOptions}</select>
          <button type="submit">Filter</button>
        </form>
        <table><thead><tr><th>Status</th><th>Schedule</th><th>Category</th><th>Text</th><th>Image</th><th>Metrics</th><th>X/Error</th><th></th></tr></thead><tbody>${rows}</tbody></table>
      </section>`,
    new: `
      <section class="card">
        <h2>New post</h2>
        ${postForm(req)}
      </section>`,
    generate: `
      <section class="card">
        <h2>Generate BrainGlitch Post</h2>
        <p class="hint">Uses OpenAI when OPENAI_API_KEY is set. Otherwise it falls back to built-in templates. Always fact-check before posting.</p>
        <form method="post" action="${rel(req, 'generate/start')}${keyQuery(req)}" class="async-generate" data-progress-title="Generating BrainGlitch post">
          ${hiddenKey(req)}
          <div class="grid2">
            <label>Category <select name="category"><option value="">Random</option><option>Nature</option><option>Space</option><option>History</option><option>Science</option><option>Human Body</option><option>Statistics</option><option>Technology</option><option>Geography</option><option>Weird Facts</option></select></label>
            <label>Status <select name="status"><option value="draft">Draft</option><option value="scheduled">Scheduled</option></select></label>
          </div>
          <label>Optional topic/hint <input name="topic" placeholder="e.g. space, football, ancient history, oceans"></label>
          <label>Optional schedule <input type="datetime-local" name="scheduled_at"><small>Used by Generate & Schedule. If empty, the post is scheduled for now + 15 minutes.</small></label>
          <label class="inline"><input type="checkbox" name="generate_image" value="1" checked> Generate image with OpenAI and attach it</label>
          <div class="button-row">
            <button type="submit" name="mode" value="draft">Generate Draft</button>
            <button type="submit" name="mode" value="schedule">Generate & Schedule</button>
            <button type="submit" name="mode" value="post_now" class="secondary" onclick="return confirm('Generate and post directly to X now?')">Generate & Post Now</button>
          </div>
        </form>
        ${progressPanel}
      </section>`,
    dayplanner: `
      <section class="card">
        <h2>Plan a Full Day</h2>
        <p class="hint">Generates several OpenAI posts, creates images, and schedules them across one day. They are still editable before posting.</p>
        <form method="post" action="${rel(req, 'generate-day/start')}${keyQuery(req)}" class="async-generate" data-progress-title="Planning full day">
          ${hiddenKey(req)}
          <div class="grid2">
            <label>Date <input type="date" name="date" value="${todayLocalDate()}"></label>
            <label>Number of posts <input type="number" name="count" min="1" max="12" value="5"></label>
          </div>
          <div class="grid2">
            <label>Start time <input type="time" name="start_time" value="09:00"></label>
            <label>End time <input type="time" name="end_time" value="21:00"></label>
          </div>
          <label>Categories <small>Select one or more. The generator will mix posts across these categories.</small>${categoryMultiSelect(['History','Space','Science','Nature','Weird Facts'])}</label>
          <p class="hint">Times are generated randomly inside the selected range. The range is split into slots based on the number of posts, so posts keep sensible spacing instead of always using the same times.</p>
          <label>Optional topic/hint for the day <input name="topic" placeholder="e.g. surprising science and history facts"></label>
          <label>Status <select name="status"><option value="scheduled">Scheduled</option><option value="draft">Draft</option></select></label>
          <label class="inline"><input type="checkbox" name="generate_images" value="1" checked> Generate and attach images for all posts</label>
          <button type="submit">Generate full day</button>
        </form>
        ${progressPanel}
      </section>`,
    import: `
      <section class="card">
        <h2>CSV / Excel Import</h2>
        <p class="hint">Supports columns like Category, Fact, Suggested Post Text, First Comment, Image Prompt, Status, Scheduled At.</p>
        <form method="post" action="${rel(req, 'import')}${keyQuery(req)}" enctype="multipart/form-data">
          ${hiddenKey(req)}
          <label>CSV/XLSX file <input type="file" name="queue" accept=".csv,.xlsx,.xls" required></label>
          <button type="submit">Import as drafts</button>
        </form>
      </section>`,
    stats: `
      <section class="card">
        <h2>Category Stats</h2>
        <table><thead><tr><th>Category</th><th>Total</th><th>Draft</th><th>Scheduled</th><th>Posted</th><th>Failed</th><th>Impressions</th><th>Likes</th><th>Reposts</th></tr></thead><tbody>${statsRows}</tbody></table>
      </section>`,
    analytics: `
      <section class="card">
        <h2>Analytics</h2>
        <p class="hint">Fetches X public metrics for posts already published by this tool. Impressions are available as public_metrics.impression_count when your X API plan returns them.</p>
        <form method="post" action="${rel(req, 'analytics/sync')}${keyQuery(req)}" class="inline-form">${hiddenKey(req)}<button type="submit">Sync analytics now</button><span class="hint">Syncs latest posted items.</span></form>
        <div class="metric-cards">
          <div><strong>${Number(analyticsTotals.posted_count || 0).toLocaleString('en-US')}</strong><span>posted</span></div>
          <div><strong>${Number(analyticsTotals.impressions || 0).toLocaleString('en-US')}</strong><span>impressions</span></div>
          <div><strong>${Number(analyticsTotals.likes || 0).toLocaleString('en-US')}</strong><span>likes</span></div>
          <div><strong>${Number(analyticsTotals.reposts || 0).toLocaleString('en-US')}</strong><span>reposts</span></div>
          <div><strong>${Number(analyticsTotals.replies || 0).toLocaleString('en-US')}</strong><span>replies</span></div>
        </div>
      </section>
      <section class="card">
        <h2>By Category</h2>
        <table><thead><tr><th>Category</th><th>Posts</th><th>Impressions</th><th>Avg views</th><th>Likes</th><th>Reposts</th><th>Replies</th></tr></thead><tbody>${analyticsCategoryRows}</tbody></table>
      </section>
      <section class="card">
        <h2>Top Posts</h2>
        <table><thead><tr><th>Posted</th><th>Category</th><th>Text</th><th>Views</th><th>Likes</th><th>Reposts</th><th>Replies</th><th>Quotes</th><th>X</th></tr></thead><tbody>${analyticsRows}</tbody></table>
      </section>`
  };

  res.send(page(req, 'BrainGlitchX Poster', `${header}${tabNav(req, tab)}${sections[tab] || sections.queue}`));
});

app.get('/edit/:id', requirePassword, (req, res) => {
  const post = getPost(req.params.id);
  if (!post) return res.status(404).send('Not found');
  res.send(page(req, `Edit Post #${post.id}`, `${headerBlock(req)}${tabNav(req, 'queue')}<p><a class="buttonlink" href="${appLink(req, { tab: 'queue' })}">← Back to queue</a></p><section class="card"><h2>Edit Post #${post.id}</h2>${postForm(req, post)}</section>`));
});

app.post('/posts', requirePassword, upload.single('image'), async (req, res) => {
  const image_path = req.file ? path.join('public', 'uploads', req.file.filename).replaceAll('\\','/') : null;
  const action = req.body.action || 'save';
  const status = action === 'post_now' ? 'posting' : action === 'schedule' ? 'scheduled' : (req.body.status || 'draft');
  const scheduled_at = action === 'schedule' ? (req.body.scheduled_at || addMinutesToLocal(nowLocalMinute(), 15)) : (req.body.scheduled_at || null);
  const created = createPost({
    status,
    category: req.body.category || '',
    text: req.body.text,
    first_comment: req.body.first_comment || '',
    image_prompt: req.body.image_prompt || '',
    verification_query: req.body.verification_query || '',
    image_path,
    scheduled_at
  });
  if (action === 'post_now') {
    try {
      const result = await publishExistingPost(created.id);
      console.log('[post-now:created]', { postId: created.id, xPostId: result.postId });
    } catch (e) {
      updatePost(created.id, { status: 'failed', error: readableError(e) });
      console.error('[post-now:create-failed]', created.id, e);
    }
  }
  res.redirect(appLink(req, { tab: 'queue' }));
});

app.post('/edit/:id', requirePassword, upload.single('image'), async (req, res) => {
  const existing = getPost(req.params.id);
  if (!existing) return res.status(404).send('Not found');
  let image_path = existing.image_path;
  if (req.body.remove_image === '1') image_path = null;
  if (req.file) image_path = path.join('public', 'uploads', req.file.filename).replaceAll('\\','/');
  const action = req.body.action || 'save';
  const status = action === 'post_now' ? 'posting' : action === 'schedule' ? 'scheduled' : (req.body.status || 'draft');
  const scheduled_at = action === 'schedule' ? (req.body.scheduled_at || addMinutesToLocal(nowLocalMinute(), 15)) : (req.body.scheduled_at || null);
  updatePost(existing.id, {
    status,
    category: req.body.category || '',
    text: req.body.text,
    first_comment: req.body.first_comment || '',
    image_prompt: req.body.image_prompt || '',
    verification_query: req.body.verification_query || '',
    image_path,
    scheduled_at,
    error: null,
  });
  if (action === 'post_now') {
    try {
      const result = await publishExistingPost(existing.id);
      console.log('[post-now:edited]', { postId: existing.id, xPostId: result.postId });
    } catch (e) {
      updatePost(existing.id, { status: 'failed', error: readableError(e) });
      console.error('[post-now:edit-failed]', existing.id, e);
    }
  }
  res.redirect(appLink(req, { tab: 'queue' }));
});

app.post('/delete/:id', requirePassword, (req, res) => {
  deletePost(req.params.id);
  res.redirect(appLink(req, { tab: 'queue' }));
});


app.get('/jobs/:id', requirePassword, (req, res) => {
  const job = generationJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(publicJob(job));
});

app.post('/generate/start', requirePassword, (req, res) => {
  console.log('[generate:start]', { category: req.body.category || '', topic: req.body.topic || '', status: req.body.status || 'draft', image: req.body.generate_image === '1' });
  const job = createJob('single');
  res.json(publicJob(job));
  (async () => {
    try {
      updateJob(job.id, { progress: 5, message: 'Generating fact, post text and image prompt...' });
      let generated;
      if (process.env.OPENAI_API_KEY) {
        ({ generated } = await generateUniqueBrainGlitch({ category: req.body.category || '', topic: req.body.topic || '' }));
      } else {
        generated = generateBrainGlitch(req.body.category || '');
      }
      updateJob(job.id, { progress: 45, message: `Generated text: ${generated.category}` });

      let image_path = null;
      if (req.body.generate_image === '1' && process.env.OPENAI_API_KEY && generated.image_prompt) {
        updateJob(job.id, { progress: 55, message: 'Generating image with OpenAI...' });
        image_path = await generateOpenAIImage({ prompt: generated.image_prompt, uploadDir });
        updateJob(job.id, { progress: 85, message: 'Image generated. Saving draft...' });
      } else {
        updateJob(job.id, { progress: 80, message: 'Saving draft...' });
      }

      const mode = requestedGenerateMode(req.body);
      const created = assertCreated(createPost({
        status: statusForGenerate(req.body),
        category: generated.category,
        text: generated.text,
        first_comment: generated.first_comment,
        image_prompt: generated.image_prompt || '',
        verification_query: generated.verification_query || '',
        image_path,
        scheduled_at: scheduleForGenerate(req.body)
      }), 'generated single post');
      let publishResult = null;
      if (mode === 'post_now') {
        updateJob(job.id, { progress: 92, message: 'Publishing to X now...' });
        publishResult = await publishExistingPost(created.id);
      }
      console.log('[generate:done]', { postId: created.id, category: generated.category, topic: req.body.topic || '', mode, xPostId: publishResult?.postId || null });
      const doneText = mode === 'post_now' ? `Done. Generated and posted (ID ${created.id}).` : mode === 'schedule' ? `Done. Generated and scheduled (ID ${created.id}).` : `Done. Draft created (ID ${created.id}).`;
      updateJob(job.id, { status: 'done', progress: 100, message: doneText, result: { created: 1, postId: created.id, xPostId: publishResult?.postId || null } });
    } catch (e) {
      console.error('OpenAI generation job failed', e);
      updateJob(job.id, { status: 'failed', progress: 100, message: 'Generation failed.', error: readableError(e) });
    }
  })();
});

app.post('/generate-day/start', requirePassword, (req, res) => {
  console.log('[generate-day:start]', { count: req.body.count, categories: req.body.categories, extra: req.body.categories_extra, topic: req.body.topic || '', status: req.body.status || 'scheduled', images: req.body.generate_images === '1' });
  const job = createJob('day');
  res.json(publicJob(job));
  (async () => {
    try {
      if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required for full-day generation');
      const count = Math.max(1, Math.min(Number(req.body.count) || 5, 12));
      const date = req.body.date || todayLocalDate();
      const start = req.body.start_time || '09:00';
      const end = req.body.end_time || '21:00';
      const categories = [...new Set([...parseCategories(req.body.categories), ...parseCategories(req.body.categories_extra)])];
      const scheduleTimes = randomScheduleSlots({ date, startTime: start, endTime: end, count });

      updateJob(job.id, { progress: 5, message: `Generating ${count} post ideas...` });
      const batchResult = await generateUniqueBrainGlitchBatch({ count, categories, topic: req.body.topic || '' });
      const items = batchResult.items;
      const dupeNote = batchResult.duplicateCount ? ` Skipped ${batchResult.duplicateCount} duplicate candidate(s).` : '';
      updateJob(job.id, { progress: 25, message: `Generated ${items.length} unique post ideas.${dupeNote}` });

      let created = 0;
      const createdIds = [];
      const total = Math.max(1, items.length);
      for (let i = 0; i < items.length; i++) {
        const generated = items[i];
        const scheduled_at = req.body.status === 'draft' ? null : scheduleTimes[i];
        let image_path = null;
        const base = 25 + Math.round((i / total) * 70);
        updateJob(job.id, { progress: base, message: `Preparing post ${i + 1} of ${total}: ${generated.category}` });
        if (req.body.generate_images === '1' && generated.image_prompt) {
          try {
            updateJob(job.id, { progress: Math.min(95, base + 3), message: `Generating image ${i + 1} of ${total}...` });
            image_path = await generateOpenAIImage({ prompt: generated.image_prompt, uploadDir });
          } catch (imgErr) {
            console.error('Image generation failed for day item', i + 1, imgErr);
            updateJob(job.id, { progress: Math.min(95, base + 8), message: `Image ${i + 1} failed. Saving post without image...` });
          }
        }
        const info = assertCreated(createPost({
          status: req.body.status || 'scheduled',
          category: generated.category,
          text: generated.text,
          first_comment: generated.first_comment,
          image_prompt: generated.image_prompt || '',
          verification_query: generated.verification_query || '',
          image_path,
          scheduled_at
        }), `day post ${i + 1}`);
        createdIds.push(info.id);
        console.log('[generate-day:item-created]', { id: info.id, category: generated.category, scheduled_at, topic: req.body.topic || '' });
        created++;
        updateJob(job.id, { progress: 25 + Math.round(((i + 1) / total) * 70), message: `Saved post ${i + 1} of ${total}.` });
      }
      updateJob(job.id, { status: 'done', progress: 100, message: `Done. Created ${created} queue items: ${createdIds.join(', ')}.`, result: { created, ids: createdIds } });
    } catch (e) {
      console.error('Full-day generation job failed', e);
      updateJob(job.id, { status: 'failed', progress: 100, message: 'Full-day generation failed.', error: readableError(e) });
    }
  })();
});

app.post('/generate', requirePassword, async (req, res) => {
  console.log('[generate:legacy]', { category: req.body.category || '', topic: req.body.topic || '', status: req.body.status || 'draft', image: req.body.generate_image === '1' });
  let generated;
  try {
    if (process.env.OPENAI_API_KEY) {
      ({ generated } = await generateUniqueBrainGlitch({ category: req.body.category || '', topic: req.body.topic || '' }));
    } else {
      generated = generateBrainGlitch(req.body.category || '');
    }
    let image_path = null;
    if (req.body.generate_image === '1' && process.env.OPENAI_API_KEY && generated.image_prompt) {
      image_path = await generateOpenAIImage({ prompt: generated.image_prompt, uploadDir });
    }
    const created = assertCreated(createPost({
      status: statusForGenerate(req.body),
      category: generated.category,
      text: generated.text,
      first_comment: generated.first_comment,
      image_prompt: generated.image_prompt || '',
      verification_query: generated.verification_query || '',
      image_path,
      scheduled_at: scheduleForGenerate(req.body)
    }), 'legacy generated post');
    if (requestedGenerateMode(req.body) === 'post_now') await publishExistingPost(created.id);
    res.redirect(appLink(req, { tab: 'queue' }));
  } catch (e) {
    console.error('OpenAI generation failed', e);
    res.status(500).send(page(req, 'Generation failed', `<p>${escapeHtml(readableError(e))}</p>${backLink(req, 'generate', 'Back')}`));
  }
});

app.post('/generate-day', requirePassword, async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required for full-day generation');
    const count = Math.max(1, Math.min(Number(req.body.count) || 5, 12));
    const date = req.body.date || todayLocalDate();
    const start = req.body.start_time || '09:00';
    const end = req.body.end_time || '21:00';
    const categories = [...new Set([...parseCategories(req.body.categories), ...parseCategories(req.body.categories_extra)])];
    const scheduleTimes = randomScheduleSlots({ date, startTime: start, endTime: end, count });
    const batchResult = await generateUniqueBrainGlitchBatch({ count, categories, topic: req.body.topic || '' });
    const items = batchResult.items;
    let created = 0;
    for (let i = 0; i < items.length; i++) {
      const generated = items[i];
      const scheduled_at = req.body.status === 'draft' ? null : scheduleTimes[i];
      let image_path = null;
      if (req.body.generate_images === '1' && generated.image_prompt) {
        try {
          image_path = await generateOpenAIImage({ prompt: generated.image_prompt, uploadDir });
        } catch (imgErr) {
          console.error('Image generation failed for day item', i + 1, imgErr);
        }
      }
      createPost({
        status: req.body.status || 'scheduled',
        category: generated.category,
        text: generated.text,
        first_comment: generated.first_comment,
        image_prompt: generated.image_prompt || '',
        verification_query: generated.verification_query || '',
        image_path,
        scheduled_at
      });
      created++;
    }
    res.send(page(req, 'Day planned', `<p>Created ${created} BrainGlitchX queue items.</p>${backLink(req, 'queue', 'Back to queue')}`));
  } catch (e) {
    console.error('Full-day generation failed', e);
    res.status(500).send(page(req, 'Full-day generation failed', `<p>${escapeHtml(readableError(e))}</p>${backLink(req, 'dayplanner', 'Back')}`));
  }
});

app.post('/import', requirePassword, importUpload.single('queue'), (req, res) => {
  if (!req.file) return res.status(400).send('No file uploaded');
  const workbook = XLSX.readFile(req.file.path);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  let imported = 0;
  for (const row of rows) {
    const category = pick(row, ['Category','category','Kategorie']);
    const status = pick(row, ['Status','status']) || 'draft';
    const text = pick(row, ['Suggested Post Text','Post Text','Text','text','Fact','fact']);
    const first_comment = pick(row, ['First Comment','Comment','Kommentar','first_comment']);
    const image_prompt = pick(row, ['Image Prompt','Bildprompt','image_prompt']);
    const verification_query = pick(row, ['Verification Query','Verify','verification_query']);
    const scheduled_at = normalizeSchedule(pick(row, ['Scheduled At','Geplant','Schedule','scheduled_at']));
    if (!String(text).trim()) continue;
    createPost({ status, category, text, first_comment, image_prompt, verification_query, scheduled_at });
    imported++;
  }
  fs.unlink(req.file.path, () => {});
  res.send(page(req, 'Import complete', `<p>Imported ${imported} posts as queue items.</p>${backLink(req, 'queue', 'Back to queue')}`));
});



async function syncAnalytics({ limit = 50 } = {}) {
  const posts = postedPostsForAnalytics(limit);
  let synced = 0;
  let skipped = 0;
  const errors = [];
  for (const post of posts) {
    try {
      const metrics = await fetchPostAnalytics(post.x_post_id);
      updatePost(post.id, { ...metrics, analytics_synced_at: nowLocalMinute(), error: null });
      synced++;
    } catch (e) {
      const message = readableError(e);
      if (e?.code === 'INVALID_X_POST_ID') {
        updatePost(post.id, { analytics_synced_at: nowLocalMinute(), error: message });
        skipped++;
        console.warn('Analytics sync skipped', post.id, message);
        continue;
      }
      updatePost(post.id, { analytics_synced_at: nowLocalMinute(), error: `Analytics sync failed: ${message}` });
      errors.push({ id: post.id, error: message });
      console.error('Analytics sync failed', post.id, e);
    }
  }
  return { requested: posts.length, synced, skipped, errors };
}

app.post('/analytics/sync', requirePassword, async (req, res) => {
  try {
    const result = await syncAnalytics({ limit: Number(req.body.limit || process.env.ANALYTICS_SYNC_LIMIT || 50) });
    res.send(page(req, 'Analytics synced', `<p>Synced ${result.synced}/${result.requested} posts.${result.skipped ? ` Skipped ${result.skipped} item(s) without a real X post id.` : ''}</p>${result.errors.length ? `<pre>${escapeHtml(JSON.stringify(result.errors, null, 2))}</pre>` : ''}<p><a href="${appLink(req, { tab: 'analytics' })}">Back to analytics</a></p>`));
  } catch (e) {
    res.status(500).send(page(req, 'Analytics sync failed', `<p>${escapeHtml(readableError(e))}</p><p><a href="${appLink(req, { tab: 'analytics' })}">Back</a></p>`));
  }
});

app.post('/scheduler/run-now', requirePassword, async (req, res) => {
  await runScheduler({ forceLog: true });
  res.redirect(appLink(req, { tab: 'queue' }));
});


app.get('/publish/:id', requirePassword, async (req, res) => {
  // Safety: never publish via GET. Some browsers/Ingress layers can retry or preload GET routes.
  // Posting to X must be a single explicit POST request protected by claimPostForPublishing().
  console.warn('[post-now:get-blocked]', { postId: Number(req.params.id) });
  res.status(405).send(page(req, 'Use Post Now button', `<p>Publishing by GET is disabled for safety. Go back to the Queue and use the Post now button.</p><p><a href="${appLink(req, { tab: 'queue' })}">Back to queue</a></p>`));
});

app.post('/publish/:id', requirePassword, async (req, res) => {
  const post = getPost(req.params.id);
  if (!post) return res.status(404).send('Not found');
  try {
    const result = await publishExistingPost(post.id);
    if (req.headers.accept?.includes('application/json')) return res.json(result);
    res.redirect(appLink(req, { tab: 'queue' }));
  } catch (e) {
    updatePost(post.id, { status: 'failed', error: readableError(e) });
    if (req.headers.accept?.includes('application/json')) return res.status(500).json({ error: readableError(e) });
    res.status(500).send(page(req, 'Post now failed', `<p>${escapeHtml(readableError(e))}</p><p><a href="${appLink(req, { tab: 'queue' })}">Back to queue</a></p>`));
  }
});

async function runScheduler(options = {}) {
  const now = nowLocalMinute();
  const posts = duePosts(now);
  if (options.forceLog || process.env.SCHEDULER_DEBUG === 'true') {
    console.log(`[scheduler] ${now} ${appTimezone()} · due posts: ${posts.length}`);
  }
  for (const post of posts) {
    try {
      const result = await publishExistingPost(post.id);
      console.log('Posted', post.id, result);
    } catch (e) {
      updatePost(post.id, { status: 'failed', error: readableError(e) });
      console.error('Failed posting', post.id, e);
    }
  }
}

cron.schedule('* * * * *', () => runScheduler().catch(e => console.error('[scheduler] unexpected error', e)), { timezone: appTimezone() });
if (process.env.ANALYTICS_AUTO_SYNC === 'true') {
  const expr = process.env.ANALYTICS_CRON || '17 * * * *';
  cron.schedule(expr, () => syncAnalytics({ limit: Number(process.env.ANALYTICS_SYNC_LIMIT || 50) }).then(r => console.log(`[analytics] synced ${r.synced}/${r.requested}, skipped ${r.skipped || 0}`)).catch(e => console.error('[analytics] sync failed', e)), { timezone: appTimezone() });
  console.log(`Analytics auto-sync active. CRON=${expr}`);
}
console.log(`Scheduler active. TIMEZONE=${appTimezone()} current=${nowLocalMinute()}`);

function generateBrainGlitch(requestedCategory) {
  const items = [
    { category:'Space', text:'A day on Venus is longer than a year on Venus.\n\nVenus takes 243 Earth days to rotate once.\n\nIt takes only 225 Earth days to orbit the Sun.\n\nYour brain has now glitched.', first_comment:'Imagine celebrating your first birthday before your first sunrise.', image_prompt:'Ultra realistic planet Venus in deep space, glowing golden atmosphere, NASA style, cinematic, no text, no watermark', verification_query:'Venus day longer than year rotation orbit NASA' },
    { category:'Science', text:'Lightning is hotter than the surface of the Sun.\n\nA lightning bolt can reach around 30,000°C.\n\nThe Sun\'s surface is about 5,500°C.\n\nYour brain has now glitched.', first_comment:'Nature really looked at electricity and decided to make it hotter than a star.', image_prompt:'Massive lightning strike at night, dramatic storm clouds, ultra realistic weather photography, no text, no watermark', verification_query:'lightning temperature hotter than sun surface NOAA' },
    { category:'History', text:'Oxford University is older than the Aztec Empire.\n\nTeaching began at Oxford around 1096.\n\nThe Aztec Empire was founded in 1428.\n\nYour brain has now glitched.', first_comment:'Students were attending Oxford centuries before the Aztec Empire existed.', image_prompt:'Cinematic medieval Oxford university scene, historical architecture, students, photorealistic, no text, no watermark', verification_query:'Oxford University older than Aztec Empire dates' },
    { category:'Nature', text:'There are more trees on Earth than stars in the Milky Way.\n\nYour brain has now glitched.', first_comment:'Which fact sounded fake until you looked it up?', image_prompt:'Dense forest canopy from above, Milky Way stars faintly visible, cinematic realistic nature scene, no text, no watermark', verification_query:'more trees on Earth than stars in Milky Way estimate' },
    { category:'Space', text:'Saturn would float in water.\n\nIts average density is lower than water.\n\nYou just need a bathtub big enough.\n\nYour brain has now glitched.', first_comment:'The bathtub is the hard part.', image_prompt:'Ultra realistic Saturn in deep space with rings, NASA style, cinematic black background, no text, no watermark', verification_query:'Saturn density less than water would float' },
    { category:'Human Body', text:'Your stomach gets a new lining every few days.\n\nWithout it, your stomach acid would start digesting you.\n\nYour brain has now glitched.', first_comment:'The human body is basically controlled chaos.', image_prompt:'Photorealistic abstract stomach lining medical-inspired macro scene, tasteful, no text, no watermark', verification_query:'stomach lining replaced every few days' },
    { category:'Science', text:'Honey never spoils.\n\nArchaeologists have found honey thousands of years old that was still edible.\n\nYour brain has now glitched.', first_comment:'Some foods expire in days. Honey plays the long game.', image_prompt:'Macro shot of golden honey in ancient ceramic jar, dramatic studio lighting, no text, no watermark', verification_query:'honey never spoils edible ancient honey' },
    { category:'Statistics', text:'A cloud can weigh hundreds of tons.\n\nAnd still float above your head.\n\nYour brain has now glitched.', first_comment:'The sky is heavier than it looks.', image_prompt:'Huge white cloud floating over landscape, ultra realistic sky photography, dramatic scale, no text, no watermark', verification_query:'how much does a cloud weigh' },
  ];
  const filtered = requestedCategory ? items.filter(i => i.category === requestedCategory) : items;
  const pool = filtered.length ? filtered : items;
  return pool[Math.floor(Math.random() * pool.length)];
}

function pick(row, names) {
  for (const name of names) {
    if (row[name] !== undefined && row[name] !== null && String(row[name]).trim() !== '') return String(row[name]).trim();
  }
  return '';
}

function normalizeSchedule(value) {
  if (!value) return null;
  if (typeof value === 'number') {
    const d = XLSX.SSF.parse_date_code(value);
    if (!d) return null;
    return `${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}T${String(d.H).padStart(2,'0')}:${String(d.M).padStart(2,'0')}`;
  }
  const str = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(str)) return str.slice(0,16);
  return str;
}

function readableError(e) {
  if (e?.data?.title || e?.data?.detail) {
    const base = `${e.data.title || 'API error'}: ${e.data.detail || e.message}`;
    if (e.code === 403 || e.data?.status === 403) {
      return `${base} This can happen when X rejects duplicate or otherwise restricted post/reply content. Check whether the post already appeared on X before retrying.`;
    }
    return base;
  }
  return e?.message || String(e);
}

function escapeHtml(str='') {
  return String(str).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
}
function escapeAttr(str='') { return escapeHtml(str); }

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`BrainGlitchX Poster running on http://localhost:${port}`));
