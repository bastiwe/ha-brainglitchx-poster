(function () {
  function qs(sel, root = document) { return root.querySelector(sel); }


  function ingressAssetUrl(relPath) {
    const clean = String(relPath || '').replace(/^\/+/, '');
    const path = window.location.pathname || '/';
    const marker = '/api/hassio_ingress/';
    const idx = path.indexOf(marker);
    if (idx >= 0) {
      const prefixStart = path.slice(0, idx + marker.length);
      const rest = path.slice(idx + marker.length).split('/').filter(Boolean);
      if (rest.length > 0) return prefixStart + rest[0] + '/' + clean;
      return prefixStart + clean;
    }
    return new URL(clean, window.location.href).toString();
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
        const created = result && result.created ? result.created : 1;
        resultEl.innerHTML = `<a href="${queueUrl()}">Open Queue</a> · Created ${created} item${created === 1 ? '' : 's'}.`;
      } else if (status === 'failed') {
        resultEl.textContent = result || '';
      } else {
        resultEl.textContent = '';
      }
    }
  }

  function queueUrl() {
    const url = new URL(window.location.href);
    url.searchParams.set('tab', 'queue');
    return url.pathname + '?' + url.searchParams.toString();
  }

  async function pollJob(jobId, panel, submitButton) {
    const url = new URL(`jobs/${jobId}`, window.location.href);
    const current = new URL(window.location.href);
    if (current.searchParams.get('key')) url.searchParams.set('key', current.searchParams.get('key'));

    while (true) {
      const res = await fetch(url.toString());
      const job = await res.json();
      if (!res.ok) throw new Error(job.error || 'Could not read job');
      setProgress(panel, job.progress, job.error || job.message, job.status, job.status === 'failed' ? job.error : job.result);
      if (job.status === 'done' || job.status === 'failed') {
        if (submitButton) submitButton.disabled = false;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  }

  document.addEventListener('DOMContentLoaded', rewriteIngressAssets);

  document.addEventListener('submit', async (event) => {
    const form = event.target.closest('form.async-generate');
    if (!form) return;
    event.preventDefault();

    const panel = qs('#generation-progress');
    if (!panel) return form.submit();

    const title = qs('#progress-title', panel);
    if (title) {
      title.textContent = form.dataset.progressTitle || 'Generating...';
      title.dataset.defaultTitle = title.textContent;
    }
    const submitButton = qs('button[type="submit"]', form);
    if (submitButton) submitButton.disabled = true;
    setProgress(panel, 1, 'Request sent. Starting generation...', 'running');

    try {
      // Send URL-encoded data instead of multipart FormData.
      // Express does not parse multipart bodies on generation routes unless multer is attached,
      // so FormData caused category/topic/status to arrive empty at the backend.
      const params = new URLSearchParams();
      for (const [key, value] of new FormData(form).entries()) params.append(key, value);
      const res = await fetch(form.action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: params.toString()
      });
      const job = await res.json();
      if (!res.ok) throw new Error(job.error || 'Could not start generation');
      setProgress(panel, job.progress, job.message, job.status, job.result);
      await pollJob(job.id, panel, submitButton);
    } catch (err) {
      setProgress(panel, 100, err.message || String(err), 'failed', err.message || String(err));
      if (submitButton) submitButton.disabled = false;
    }
  });
})();
