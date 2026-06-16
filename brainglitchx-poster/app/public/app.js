(function () {
  function qs(sel, root = document) { return root.querySelector(sel); }

  function ingressRootPath() {
    const path = window.location.pathname || '/';
    const marker = '/api/hassio_ingress/';
    const idx = path.indexOf(marker);
    if (idx < 0) return null;
    const prefixStart = path.slice(0, idx + marker.length);
    const rest = path.slice(idx + marker.length).split('/').filter(Boolean);
    if (!rest.length) return prefixStart;
    return prefixStart + rest[0] + '/';
  }

  function normalizeIngressLocation() {
    const root = ingressRootPath();
    if (!root) return;
    if (window.location.pathname === root.slice(0, -1)) {
      window.history.replaceState(null, '', root + window.location.search + window.location.hash);
    }
  }

  function appRootUrl(path = '') {
    const clean = String(path || '').replace(/^\/+/, '');
    const root = ingressRootPath();
    if (root) return new URL(root + clean, window.location.origin).toString();
    return new URL(clean || '.', window.location.href).toString();
  }

  function isExternalOrSpecialUrl(value) {
    return /^(?:[a-z][a-z0-9+.-]*:|#)/i.test(String(value || ''));
  }

  function rewriteIngressNavigation() {
    if (!ingressRootPath()) return;
    document.querySelectorAll('a[href]').forEach((el) => {
      const raw = el.getAttribute('href');
      if (!raw || isExternalOrSpecialUrl(raw) || el.hasAttribute('data-bg-url')) return;
      const clean = raw.replace(/^(\.\/|\.\.\/)+/, '').replace(/^\/+/, '');
      el.setAttribute('href', appRootUrl(clean));
    });
    document.querySelectorAll('form[action]').forEach((form) => {
      const raw = form.getAttribute('action');
      if (!raw || isExternalOrSpecialUrl(raw)) return;
      const clean = raw.replace(/^(\.\/|\.\.\/)+/, '').replace(/^\/+/, '');
      form.setAttribute('action', appRootUrl(clean));
    });
  }

  function ingressAssetUrl(relPath) {
    const clean = String(relPath || '').replace(/^\/+/, '');
    return appRootUrl(clean);
  }

  function rewriteIngressAssets() {
    document.querySelectorAll('[data-bg-url]').forEach((el) => {
      const rel = el.getAttribute('data-bg-url');
      if (!rel) return;
      const url = ingressAssetUrl(rel);
      if (el.tagName === 'IMG') el.setAttribute('src', url);
      if (el.tagName === 'A') el.setAttribute('href', url);
    });
  }

  function updateCharCounter(textarea) {
    const limit = Number(textarea.dataset.charLimit || 0);
    if (!limit) return true;
    let counter = textarea.nextElementSibling;
    if (!counter || !counter.classList?.contains('char-counter')) {
      counter = document.createElement('small');
      counter.className = 'char-counter';
      textarea.insertAdjacentElement('afterend', counter);
    }
    const length = Array.from(textarea.value || '').length;
    const remaining = limit - length;
    counter.textContent = remaining >= 0 ? `${remaining} characters left` : `${Math.abs(remaining)} characters over limit`;
    counter.classList.toggle('over', remaining < 0);
    return remaining >= 0;
  }

  function setupCharCounters() {
    document.querySelectorAll('textarea[data-char-limit]').forEach((textarea) => {
      updateCharCounter(textarea);
      textarea.addEventListener('input', () => updateCharCounter(textarea));
    });
  }

  function setProgress(panel, pct, message, status, result) {
    panel.hidden = false;
    const fill = qs('#progress-fill', panel);
    const percent = qs('#progress-percent', panel);
    const msg = qs('#progress-message', panel);
    const title = qs('#progress-title', panel);
    const resultEl = qs('#progress-result', panel);
    const value = Math.max(0, Math.min(100, Math.round(pct || 0)));
    if (fill) fill.style.width = value + '%';
    if (percent) percent.textContent = value + '%';
    if (msg) msg.textContent = message || '';
    if (title && status) title.textContent = status === 'done' ? 'Done' : status === 'failed' ? 'Failed' : title.dataset.defaultTitle || title.textContent;
    if (resultEl) {
      if (status === 'done') {
        if (result?.reload) {
          resultEl.textContent = 'Done. Reloading...';
          window.setTimeout(() => window.location.reload(), 900);
          return;
        }
        const created = result && result.created ? result.created : 1;
        if (result?.postId) {
          resultEl.innerHTML = `<a href="${postUrl(result.postId)}">Open generated post</a> · Created ${created} item${created === 1 ? '' : 's'}.`;
        } else if (Array.isArray(result?.ids) && result.ids.length === 1) {
          resultEl.innerHTML = `<a href="${postUrl(result.ids[0])}">Open generated post</a> · Created 1 item.`;
        } else {
          resultEl.innerHTML = `<a href="${queueUrl()}">Open Queue</a> · Created ${created} item${created === 1 ? '' : 's'}.`;
        }
      } else if (status === 'failed') {
        resultEl.textContent = result || '';
      } else {
        resultEl.textContent = '';
      }
    }
  }

  function queueUrl() {
    return withCurrentKey(appRootUrl(), { tab: 'queue' });
  }

  function postUrl(postId) {
    return withCurrentKey(appRootUrl(`edit/${postId}`));
  }

  function withCurrentKey(rawUrl, extraParams = {}) {
    const target = new URL(rawUrl);
    const current = new URL(window.location.href);
    const key = current.searchParams.get('key');
    if (key) target.searchParams.set('key', key);
    Object.entries(extraParams).forEach(([name, value]) => target.searchParams.set(name, value));
    return target.toString();
  }

  async function pollJob(jobId, panel, submitButton) {
    const url = new URL(appRootUrl(`jobs/${jobId}`));
    const current = new URL(window.location.href);
    if (current.searchParams.get('key')) url.searchParams.set('key', current.searchParams.get('key'));

    while (true) {
      const res = await fetch(url.toString());
      const job = await readJsonResponse(res, 'Could not read job');
      if (!res.ok) throw new Error(job.error || 'Could not read job');
      if (job.invalidJson) throw new Error(job.error || 'Could not read job');
      setProgress(panel, job.progress, job.error || job.message, job.status, job.status === 'failed' ? job.error : job.result);
      if (job.status === 'done' || job.status === 'failed') {
        if (submitButton) submitButton.disabled = false;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  }

  async function readJsonResponse(res, fallbackMessage) {
    const text = await res.text();
    try {
      return text ? JSON.parse(text) : {};
    } catch (_err) {
      const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 220);
      const message = `${fallbackMessage}: HTTP ${res.status}${snippet ? ` - ${snippet}` : ''}`;
      return { error: message, invalidJson: true };
    }
  }

  normalizeIngressLocation();
  document.addEventListener('DOMContentLoaded', () => {
    rewriteIngressNavigation();
    rewriteIngressAssets();
    setupCharCounters();
  });

  document.addEventListener('submit', async (event) => {
    const limited = Array.from(event.target.querySelectorAll?.('textarea[data-char-limit]') || []);
    const tooLong = limited.filter((textarea) => !updateCharCounter(textarea));
    if (tooLong.length) {
      event.preventDefault();
      tooLong[0].focus();
      alert('Please shorten the post/comment before publishing.');
      return;
    }

    const form = event.target;
    const submitter = event.submitter;
    const isAsyncJob = form.matches?.('form.async-generate') || submitter?.dataset.asyncJob === '1';
    if (!isAsyncJob) return;
    event.preventDefault();

    const panel = qs('#generation-progress');
    if (!panel) return form.submit();

    const title = qs('#progress-title', panel);
    if (title) {
      title.textContent = submitter?.dataset.progressTitle || form.dataset.progressTitle || 'Generating...';
      title.dataset.defaultTitle = title.textContent;
    }
    const submitButton = submitter || qs('button[type="submit"]', form);
    if (submitButton) submitButton.disabled = true;
    setProgress(panel, 1, 'Request sent. Starting generation...', 'running');

    try {
      // Send URL-encoded data instead of multipart FormData.
      // Express does not parse multipart bodies on generation routes unless multer is attached,
      // so FormData caused category/topic/status to arrive empty at the backend.
      const params = new URLSearchParams();
      for (const [key, value] of new FormData(form).entries()) {
        if (typeof value === 'string') params.append(key, value);
      }
      if (submitter?.name) params.set(submitter.name, submitter.value || '');
      const targetAction = submitter?.hasAttribute?.('formaction') ? submitter.formAction : form.action;
      const res = await fetch(targetAction, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: params.toString()
      });
      const job = await readJsonResponse(res, 'Could not start generation');
      if (!res.ok) throw new Error(job.error || 'Could not start generation');
      if (job.invalidJson || !job.id) throw new Error(job.error || 'Could not start generation');
      setProgress(panel, job.progress, job.message, job.status, job.result);
      await pollJob(job.id, panel, submitButton);
    } catch (err) {
      setProgress(panel, 100, err.message || String(err), 'failed', err.message || String(err));
      if (submitButton) submitButton.disabled = false;
    }
  });
})();
