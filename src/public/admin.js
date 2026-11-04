// Kaksha admin page: list tuitions and allow / block / extend their access.
(() => {
  const $ = (id) => document.getElementById(id);
  const KEY = 'kaksha_admin_key';
  let key = sessionStorage.getItem(KEY) || '';
  let searchTimer;

  const esc = (v) =>
    String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const date = (v) => (v ? new Date(v).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '');

  function toast(text) {
    const m = $('msg');
    m.textContent = text;
    m.style.display = 'block';
    clearTimeout(toast.t);
    toast.t = setTimeout(() => (m.style.display = 'none'), 2500);
  }

  async function api(path, options = {}) {
    const res = await fetch(`/api/v1/admin${path}`, {
      ...options,
      headers: { 'content-type': 'application/json', 'x-admin-key': key },
    });
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    if (res.status === 401) {
      signOut();
      throw new Error('Wrong admin key');
    }
    if (!res.ok) throw new Error(data?.error?.message || `Error ${res.status}`);
    return data;
  }

  function show(signedIn) {
    $('login').classList.toggle('hidden', signedIn);
    $('panel').classList.toggle('hidden', !signedIn);
    $('logout').classList.toggle('hidden', !signedIn);
  }

  function signOut() {
    key = '';
    sessionStorage.removeItem(KEY);
    show(false);
  }

  function statusBadge(it) {
    if (it.status === 'blocked') return '<span class="badge b-blocked">Blocked</span>';
    if (it.status === 'active') {
      return it.allowed
        ? `<span class="badge b-active">Allowed</span><div class="muted">${it.accessUntil ? `until ${date(it.accessUntil)}` : 'no end date'}</div>`
        : `<span class="badge b-ended">Plan ended</span><div class="muted">${date(it.accessUntil)}</div>`;
    }
    return it.allowed
      ? `<span class="badge b-trial">Trial</span><div class="muted">${it.trialDaysRemaining} day(s) left</div>`
      : `<span class="badge b-ended">Trial ended</span><div class="muted">${date(it.trialEndsAt)}</div>`;
  }

  function row(it) {
    const o = it.owner || {};
    return `<tr data-id="${esc(it.id)}">
      <td><b>${esc(it.name)}</b><div class="muted">Joined ${date(it.createdAt)}</div></td>
      <td>${esc(o.name)}<div class="muted">${esc(o.email)}<br>${esc(o.mobile)}${it.ownerVerified === false ? '<br>(email not verified)' : ''}</div></td>
      <td class="muted">${it.studentCount} students<br>${it.staffCount} staff</td>
      <td>${statusBadge(it)}</td>
      <td><div class="actions">
        <div class="row">
          <select data-until>
            <option value="">No end date</option>
            <option value="30">1 month</option>
            <option value="90">3 months</option>
            <option value="180">6 months</option>
            <option value="365">1 year</option>
          </select>
          <button class="green" data-act="allow">Allow</button>
        </div>
        <div class="row">
          <button class="ghost" data-act="trial7">+7 days trial</button>
          <button class="red" data-act="block" ${it.status === 'blocked' ? 'disabled' : ''}>Block</button>
        </div>
      </div></td>
    </tr>`;
  }

  async function load() {
    const q = $('q').value.trim();
    const { institutes } = await api(`/institutes${q ? `?q=${encodeURIComponent(q)}` : ''}`);
    const allowed = institutes.filter((i) => i.allowed).length;
    $('counts').textContent = `${institutes.length} tuition(s) · ${allowed} with access · ${institutes.length - allowed} without`;
    $('rows').innerHTML = institutes.length
      ? institutes.map(row).join('')
      : '<tr><td colspan="5" class="muted">No tuitions found.</td></tr>';
  }

  async function act(id, action, tr) {
    let body;
    if (action === 'allow') {
      const days = tr.querySelector('[data-until]').value;
      body = { action: 'allow', accessUntil: days ? new Date(Date.now() + days * 86400000).toISOString() : null };
    } else if (action === 'block') {
      if (!confirm('Block this tuition? The owner and all staff will lose access.')) return;
      body = { action: 'block' };
    } else {
      body = { extendTrialDays: 7 };
    }
    await api(`/institutes/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
    toast(action === 'allow' ? 'Allowed' : action === 'block' ? 'Blocked' : 'Trial extended by 7 days');
    await load();
  }

  $('rows').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const tr = btn.closest('tr');
    btn.disabled = true;
    act(tr.dataset.id, btn.dataset.act === 'trial7' ? 'trial7' : btn.dataset.act, tr)
      .catch((err) => toast(err.message))
      .finally(() => (btn.disabled = false));
  });

  async function signIn() {
    key = $('key').value.trim();
    if (!key) return;
    try {
      await load();
      sessionStorage.setItem(KEY, key);
      show(true);
    } catch (err) {
      toast(err.message);
    }
  }

  $('signin').addEventListener('click', signIn);
  $('key').addEventListener('keydown', (e) => e.key === 'Enter' && signIn());
  $('logout').addEventListener('click', signOut);
  $('refresh').addEventListener('click', () => load().catch((err) => toast(err.message)));
  $('q').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => load().catch((err) => toast(err.message)), 300);
  });

  if (key) {
    load()
      .then(() => show(true))
      .catch(() => show(false));
  }
})();
