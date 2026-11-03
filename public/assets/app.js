/* ShipBridge embedded admin UI — multi-page, plain JS + Polaris web components + App Bridge. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const state = { boot: null, orders: [], selected: new Set(), filter: 'all', search: '', page: 'dashboard', smsSource: 'web' };

  // ---------------- helpers ----------------
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function toast(msg, isError) {
    if (window.shopify && shopify.toast) shopify.toast.show(msg, { isError: Boolean(isError), duration: 4000 });
    else console[isError ? 'error' : 'log'](msg);
  }
  async function api(path, opts = {}) {
    const doFetch = async () => {
      const headers = { 'Content-Type': 'application/json' };
      if (window.shopify && shopify.idToken) headers.Authorization = `Bearer ${await shopify.idToken()}`;
      return fetch(`/api${path}`, { method: opts.method || 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
    };
    let res = await doFetch();
    if (res.status === 401) res = await doFetch();
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }
  async function busy(button, fn) {
    button.loading = true; button.setAttribute('loading', '');
    try { return await fn(); } finally { button.loading = false; button.removeAttribute('loading'); }
  }
  const setVal = (id, v) => { const el = $(id); el.value = v == null ? '' : String(v); el.setAttribute('value', el.value); };
  const setChecked = (id, v) => { const el = $(id); el.checked = Boolean(v); if (v) el.setAttribute('checked', ''); else el.removeAttribute('checked'); };
  const setDisabled = (el, d) => { el.disabled = d; if (d) el.setAttribute('disabled', ''); else el.removeAttribute('disabled'); };
  const show = (el, on) => { el.hidden = !on; };
  const money = (n, c) => `${c ? c + ' ' : ''}${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  const when = (iso) => { const d = new Date(iso); return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}, ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`; };
  const setBadge = (el, text, tone) => { el.textContent = text; if (tone) el.setAttribute('tone', tone); else el.removeAttribute('tone'); };

  function applySettings(r) {
    if (r.settings) state.boot.settings = r.settings;
    if (r.couriers) state.boot.couriers = r.couriers;
  }

  // ---------------- routing ----------------
  const ROUTES = { '/': 'dashboard', '/app': 'dashboard', '/couriers': 'couriers', '/sms': 'sms', '/plans': 'plans' };
  function pageFromPath() { return ROUTES[location.pathname.replace(/\/$/, '') || '/'] || 'dashboard'; }
  function showPage(page) {
    state.page = page;
    $$('.page').forEach((p) => show(p, p.dataset.page === page));
    $$('#tabs a').forEach((a) => a.classList.toggle('active', a.dataset.nav === page));
    window.scrollTo(0, 0);
    if (page === 'sms') loadSmsLog();
    if (page === 'dashboard' && state.boot) loadOrders();
  }
  function navigate(path) {
    if (location.pathname !== path) history.pushState({}, '', path + location.search);
    showPage(pageFromPath());
  }
  window.addEventListener('popstate', () => showPage(pageFromPath()));
  document.addEventListener('shopify:navigate', (e) => {
    const href = e.target && e.target.getAttribute && e.target.getAttribute('href');
    if (href) { e.preventDefault && e.preventDefault(); navigate(href); }
  });

  // ---------------- banners ----------------
  function renderBanners() {
    const b = state.boot, s = b.settings, out = [];
    if (b.webhooks && b.webhooks.ok === false) out.push(`<s-banner tone="critical" heading="New orders can't reach the app">Shopify refused to set up order notifications: ${esc(b.webhooks.error)}</s-banner>`);
    if (s.pathao_env === 'sandbox') out.push('<s-banner tone="warning">Pathao is in sandbox mode: orders go to the test system, not real couriers.</s-banner>');
    if (b.usage.limit && b.usage.used >= b.usage.limit) out.push(`<s-banner tone="critical" heading="Monthly limit reached">You've used all ${b.usage.limit} orders on the Free plan. <a class="link" href="/plans" data-link>Upgrade to keep shipping</a>.</s-banner>`);
    $('banners').innerHTML = out.join('');
  }

  // ---------------- dashboard ----------------
  function renderDashboard() {
    const b = state.boot, s = b.settings, st = b.stats || {};
    const hour = new Date().getHours();
    $('greeting').textContent = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

    // setup checklist
    const steps = [
      { done: s.connected, text: 'Connect a courier', href: '/couriers' },
      { done: Boolean(s.pathao_store_id), text: 'Choose a pickup store', href: '/couriers' },
      { done: s.auto_send, text: 'Turn on auto-send', href: '/couriers' },
      { done: s.sms.enabled, text: 'Set up customer SMS', href: '/sms' },
    ];
    const done = steps.filter((x) => x.done).length;
    show($('setup'), done < steps.length);
    $('setup-count').textContent = `${done}/${steps.length}`;
    $('setup-ring').style.setProperty('--p', String(Math.round((done / steps.length) * 100)));
    $('checklist').innerHTML = steps.map((x) => `<li class="${x.done ? 'done' : ''}"><span class="check"></span><a href="${x.href}" data-link>${esc(x.text)}</a></li>`).join('');

    // KPIs
    $('k-shipped').textContent = st.shipped || 0;
    const def = (b.couriers || []).find((c) => c.isDefault);
    $('k-shipped-sub').textContent = def && s.connected ? `via ${def.name}` : 'No courier connected yet';
    $('k-attention').textContent = st.shipFailed || 0;
    $('k-sms').textContent = st.smsSent || 0;
    $('k-sms-sub').textContent = s.sms.enabled ? (st.smsFailed ? `${st.smsFailed} failed` : 'All delivered to SSL Wireless') : 'SMS is off';
    const u = b.usage;
    $('k-usage').textContent = u.limit ? `${u.used}/${u.limit}` : String(u.used);
    const pct = u.limit ? Math.min(100, Math.round((u.used / u.limit) * 100)) : 100;
    $('usage-bar').style.width = `${pct}%`;
    $('usage-bar').classList.toggle('warn', Boolean(u.limit && pct >= 80));
    $('k-usage-sub').textContent = u.limit ? `${Math.max(0, u.limit - u.used)} orders left` : 'Unlimited on Pro';
    $('auto-line').innerHTML = s.auto_send
      ? `<span class="tag ok"><span class="d"></span>Auto-send on</span> New orders go to ${esc(def ? def.name : 'your courier')} automatically`
      : 'Auto-send is off. <a class="link" href="/couriers" data-link>Turn it on</a> or send orders manually.';
  }

  const canSend = (o) => !o.cancelled && (!o.shipment || ['failed', 'skipped'].includes(o.shipment.status));
  function bucket(o) {
    if (o.cancelled || (o.shipment && o.shipment.status === 'processing')) return 'other';
    if (!o.shipment) return 'todo';
    return o.shipment.status === 'sent' ? 'sent' : 'problem';
  }
  function deliveryCell(o) {
    const s = o.shipment;
    if (o.cancelled) return '<s-badge>Cancelled</s-badge>';
    if (!s) return '<s-badge>Not sent</s-badge>';
    if (s.status === 'sent') {
      const label = s.pathaoStatus && s.pathaoStatus !== 'Pending' ? String(s.pathaoStatus).replace(/[-_]/g, ' ') : 'Booked';
      const tone = /return|fail|cancel/i.test(label) ? 'critical' : 'success';
      return `<s-badge tone="${tone}">${esc(label.charAt(0).toUpperCase() + label.slice(1))}</s-badge><span class="sub">Pathao ${esc(s.consignmentId || '')}${s.deliveryFee != null ? ` · ৳${esc(s.deliveryFee)}` : ''}</span>`;
    }
    if (s.status === 'processing') return '<s-badge tone="info">Sending…</s-badge>';
    if (s.status === 'skipped') return `<s-badge tone="warning">Skipped</s-badge><span class="err">${esc(s.error)}</span>`;
    return `<s-badge tone="critical">Failed</s-badge><span class="err">${esc(s.error)}</span>`;
  }
  function smsCell(o) {
    if (!o.sms) return '<span class="tag">—</span>';
    if (o.sms.status === 'sent') return '<span class="tag ok"><span class="d"></span>Sent</span>';
    if (o.sms.status === 'failed') return `<span class="tag bad" title="${esc(o.sms.error)}"><span class="d"></span>Failed</span>`;
    if (o.sms.status === 'skipped') return `<span class="tag" title="${esc(o.sms.error)}">Skipped</span>`;
    return '<span class="tag">Sending…</span>';
  }

  function renderOrders() {
    const counts = { all: state.orders.length, todo: 0, sent: 0, problem: 0 };
    state.orders.forEach((o) => { const k = bucket(o); if (counts[k] != null) counts[k] += 1; });
    Object.keys(counts).forEach((k) => { $(`c-${k}`).textContent = counts[k] || ''; });
    $$('.pill').forEach((p) => p.classList.toggle('active', p.dataset.filter === state.filter));
    const q = state.search.trim().toLowerCase();
    const rows = state.orders.filter((o) => (state.filter === 'all' || bucket(o) === state.filter)
      && (!q || `${o.name} ${o.customer} ${o.city}`.toLowerCase().includes(q)));
    const empty = $('orders-empty');
    if (!rows.length) {
      $('orders-body').innerHTML = '';
      show($('orders-table'), false); show(empty, true);
      empty.innerHTML = state.orders.length ? '<b>Nothing here</b>No orders match this view.' : '<b>No orders yet</b>New orders from your store will appear here.';
      return updateSendButton();
    }
    show($('orders-table'), true); show(empty, false);
    $('orders-body').innerHTML = rows.map((o) => {
      const sendable = canSend(o);
      let action = '';
      if (sendable) action = `<s-button data-send="${esc(o.id)}">${o.shipment ? 'Retry' : 'Send'}</s-button>`;
      else if (o.shipment && o.shipment.status === 'sent') action = `<s-button variant="tertiary" data-refresh="${esc(o.id)}">Track</s-button>`;
      return `<s-table-row>
        <s-table-cell>${sendable ? `<s-checkbox accessibilitylabel="Select ${esc(o.name)}" data-select="${esc(o.id)}" ${state.selected.has(o.id) ? 'checked' : ''}></s-checkbox>` : ''}</s-table-cell>
        <s-table-cell><span class="order-name">${esc(o.name)}</span><span class="sub">${esc(when(o.createdAt))}</span></s-table-cell>
        <s-table-cell>${esc(o.customer) || '—'}${o.city ? `<span class="sub">${esc(o.city)}</span>` : ''}</s-table-cell>
        <s-table-cell>${o.cod > 0 ? esc(money(o.cod, o.currency)) : '<span class="sub">Prepaid</span>'}</s-table-cell>
        <s-table-cell>${deliveryCell(o)}</s-table-cell>
        <s-table-cell>${smsCell(o)}</s-table-cell>
        <s-table-cell>${action}</s-table-cell>
      </s-table-row>`;
    }).join('');
    updateSendButton();
  }
  function updateSendButton() {
    const btn = $('send-selected');
    setDisabled(btn, state.selected.size === 0);
    btn.textContent = state.selected.size ? `Send ${state.selected.size} to courier` : 'Send to courier';
  }
  async function loadOrders() {
    $('orders-table').setAttribute('loading', '');
    try {
      state.orders = (await api('/orders')).orders;
      const ids = new Set(state.orders.filter(canSend).map((o) => o.id));
      for (const id of [...state.selected]) if (!ids.has(id)) state.selected.delete(id);
      renderOrders();
    } catch (e) { toast(e.message, true); } finally { $('orders-table').removeAttribute('loading'); }
  }
  async function sendOrders(ids) {
    const r = await api('/orders/send', { method: 'POST', body: { ids } });
    const ok = r.results.filter((x) => x.ok).length;
    const failed = r.results.filter((x) => !x.ok && !x.duplicate);
    if (ok) toast(`${ok} order${ok > 1 ? 's' : ''} sent to the courier`);
    if (failed.length) toast(`${failed.length} failed: ${failed[0].error}`, true);
    ids.forEach((id) => state.selected.delete(id));
    await refreshBoot(); await loadOrders();
  }

  // ---------------- couriers ----------------
  const STATUS = {
    connected: ['Connected', 'success'], needs_store: ['Choose a store', 'warning'],
    not_connected: ['Not connected', null], coming_soon: ['Coming soon', null],
  };
  function renderCouriers() {
    const list = state.boot.couriers || [];
    $('courier-grid').innerHTML = list.map((c) => {
      const [label, tone] = STATUS[c.status] || STATUS.not_connected;
      const btn = c.available
        ? `<s-button ${c.status === 'connected' ? '' : 'variant="primary"'} data-manage="${esc(c.key)}">${c.status === 'connected' ? 'Manage' : 'Connect'}</s-button>`
        : '<s-button disabled>Not available yet</s-button>';
      const isDef = c.isDefault && c.available;
      return `<div class="card courier ${isDef ? 'active' : ''} ${c.available ? '' : 'soon'}">
        <div class="courier-top"><span class="mono" style="--c:${esc(c.color)}">${esc(c.name.charAt(0))}</span>
          <div><div class="courier-name">${esc(c.name)}</div><div class="courier-tag">${esc(c.tagline)}</div></div></div>
        <div class="row-between"><span>${c.available ? `<s-badge ${tone ? `tone="${tone}"` : ''}>${esc(label)}</s-badge>` : '<span class="tag">Coming soon</span>'}</span>${isDef ? '<span class="default-flag">Default</span>' : ''}</div>
        ${c.detail ? `<div class="sub">${esc(c.detail)}</div>` : ''}
        <div class="foot">${btn}</div>
      </div>`;
    }).join('');

    const s = state.boot.settings;
    const ready = s.connected && s.pathao_store_id;
    setBadge($('pathao-badge'), ready ? 'Connected' : s.connected ? 'Choose a store' : 'Not connected', ready ? 'success' : s.connected ? 'warning' : null);
    $('pathao-sub').textContent = ready
      ? `${s.pathao_username} · ${s.pathao_store_name || 'Store #' + s.pathao_store_id} · ${s.pathao_env === 'sandbox' ? 'Sandbox' : 'Live'}`
      : 'Enter your Pathao Merchant API credentials to connect.';
    $('save-connection').textContent = s.connected ? 'Save & reconnect' : 'Connect Pathao';
    setChecked('auto_send', s.auto_send);
    setDisabled($('auto_send'), !ready);
  }
  function fillPathaoForm() {
    const s = state.boot.settings;
    setVal('pathao_env', s.pathao_env);
    setVal('pathao_client_id', s.pathao_client_id);
    setVal('pathao_username', s.pathao_username);
    setVal('pathao_client_secret', ''); setVal('pathao_password', '');
    $('pathao_client_secret').setAttribute('placeholder', s.has_client_secret ? '•••••••• saved' : '');
    $('pathao_password').setAttribute('placeholder', s.has_password ? '•••••••• saved' : '');
    if (s.pathao_store_id && !$('pathao_store_id').querySelector(`s-option[value="${s.pathao_store_id}"]`)) {
      $('pathao_store_id').insertAdjacentHTML('beforeend', `<s-option value="${esc(s.pathao_store_id)}">${esc(s.pathao_store_name || 'Store #' + s.pathao_store_id)}</s-option>`);
    }
    setVal('pathao_store_id', s.pathao_store_id || '');
    setVal('wh_url', state.boot.pathaoWebhook.url);
    setVal('wh_secret', state.boot.pathaoWebhook.secret);
  }
  async function saveConnection() {
    const body = { pathao_env: $('pathao_env').value, pathao_client_id: $('pathao_client_id').value, pathao_username: $('pathao_username').value };
    if ($('pathao_client_secret').value) body.pathao_client_secret = $('pathao_client_secret').value;
    if ($('pathao_password').value) body.pathao_password = $('pathao_password').value;
    if (!body.pathao_client_id || !body.pathao_username) return toast('Enter your Pathao Client ID and login email', true);
    applySettings(await api('/settings', { method: 'POST', body }));
    const test = await api('/pathao/test', { method: 'POST' });
    if (!test.ok) { toast(`Pathao rejected the login: ${test.error}`, true); fillPathaoForm(); renderAll(); return; }
    const sel = $('pathao_store_id');
    const prev = sel.value || state.boot.settings.pathao_store_id;
    sel.innerHTML = '<s-option value="">Choose a store</s-option>' + test.stores.map((st) => `<s-option value="${esc(st.id)}">${esc(st.name)}${st.active ? '' : ' (inactive)'}</s-option>`).join('');
    const store = test.stores.find((st) => String(st.id) === String(prev)) || (test.stores.length === 1 ? test.stores[0] : null);
    if (store) {
      setVal('pathao_store_id', store.id);
      applySettings(await api('/settings', { method: 'POST', body: { pathao_store_id: store.id, pathao_store_name: store.name } }));
      toast('Pathao connected');
    } else toast(`Connected — choose your pickup store (${test.stores.length} found)`);
    fillPathaoForm(); renderAll();
  }
  async function saveStore() {
    const sel = $('pathao_store_id');
    if (!sel.value || !/^\d+$/.test(sel.value)) return;
    const opt = sel.querySelector(`s-option[value="${sel.value}"]`);
    applySettings(await api('/settings', { method: 'POST', body: { pathao_store_id: sel.value, pathao_store_name: opt ? opt.textContent.replace(' (inactive)', '') : null } }));
    toast('Pickup store saved'); renderAll();
  }
  async function toggleAutoSend(on) {
    let msg, err = false;
    try { applySettings(await api('/settings', { method: 'POST', body: { auto_send: on } })); msg = on ? 'Auto-send is on' : 'Auto-send is off'; }
    catch (e) { msg = e.message; err = true; }
    renderAll(); toast(msg, err);
  }

  // ---------------- SMS ----------------
  const SAMPLE = { name: 'Rahim', order_number: '#1001', items: 'Laddu box x2', total: '1250.00', currency: 'BDT' };
  const SOURCE_HELP = {
    all: 'Every new order gets an SMS.',
    web: 'Only orders customers place on your online store.',
    manual: 'Only orders you create yourself in Shopify admin (draft orders).',
  };
  function smsParts(text) {
    const unicode = /[^\x00-\x7F]/.test(text);
    const per = unicode ? (text.length > 70 ? 67 : 70) : (text.length > 160 ? 153 : 160);
    return { parts: Math.max(1, Math.ceil(text.length / per)), unicode };
  }
  function previewSms() {
    const t = $('sms_template').value || '';
    const text = Object.entries(SAMPLE).reduce((x, [k, v]) => x.split(`{{${k}}}`).join(v), t);
    $('sms-preview').textContent = text || 'Your message preview appears here.';
    const p = smsParts(text);
    $('sms-count').textContent = `${text.length} characters · ${p.parts} SMS part${p.parts > 1 ? 's' : ''}${p.unicode ? ' (Bangla/Unicode)' : ''}`;
    $('phone-sid').textContent = ($('sms_sid').value || 'SENDER').toUpperCase();
  }
  function renderSmsSource() {
    $$('#sms-source button').forEach((b) => b.classList.toggle('active', b.dataset.source === state.smsSource));
    $('source-help').textContent = SOURCE_HELP[state.smsSource];
  }
  function renderSms() {
    const m = state.boot.settings.sms, st = state.boot.stats || {};
    setChecked('sms_enabled', m.enabled);
    setDisabled($('sms_enabled'), !m.configured);
    setBadge($('sms-badge'), m.enabled ? 'Active' : m.configured ? 'Off' : 'Not set up', m.enabled ? 'success' : m.configured ? null : 'warning');
    $('s-sent').textContent = st.smsSent || 0;
    $('s-failed').textContent = st.smsFailed || 0;
    $('s-mode').textContent = (m.sources.find((x) => x.key === m.source) || {}).label || '';
  }
  function fillSmsForm() {
    const m = state.boot.settings.sms;
    state.smsSource = m.source;
    setVal('sms_sid', m.sid);
    setVal('sms_token', '');
    $('sms_token').setAttribute('placeholder', m.has_token ? '•••••••• saved' : '');
    setVal('sms_template', m.template);
    renderSmsSource(); previewSms();
  }
  async function saveSms() {
    const body = { sms_source: state.smsSource, sms_sid: $('sms_sid').value, sms_template: $('sms_template').value };
    if ($('sms_token').value) body.sms_token = $('sms_token').value;
    applySettings(await api('/settings', { method: 'POST', body }));
    fillSmsForm(); renderAll(); toast('SMS settings saved');
  }
  async function toggleSms(on) {
    let msg, err = false;
    try { applySettings(await api('/settings', { method: 'POST', body: { sms_enabled: on } })); msg = on ? 'SMS notifications are on' : 'SMS notifications are off'; }
    catch (e) { msg = e.message; err = true; }
    renderAll(); toast(msg, err);
  }
  async function testSms() {
    const r = await api('/sms/test', { method: 'POST', body: { phone: $('sms_test_phone').value } });
    toast(`Test SMS sent to +${r.to}`);
  }
  async function loadSmsLog() {
    if (!state.boot) return;
    try {
      const { items } = await api('/sms/log');
      $('sms-log').innerHTML = items.length
        ? items.map((i) => `<div class="log-row">
            <span class="order-name">${esc(i.orderName || '#' + i.orderId)}</span>
            <span>${i.status === 'sent' ? '<span class="tag ok"><span class="d"></span>Sent</span>' : i.status === 'failed' ? '<span class="tag bad"><span class="d"></span>Failed</span>' : `<span class="tag">${esc(i.status === 'skipped' ? 'Skipped' : 'Sending')}</span>`}
              ${i.error ? `<span class="why">${esc(i.error)}</span>` : ''}</span>
            <span class="muted">${i.phone ? '+' + esc(i.phone) : ''}</span>
            <span class="muted">${esc(when(i.at))}</span></div>`).join('')
        : '<div class="empty"><b>No messages yet</b>Messages appear here once customers place orders.</div>';
    } catch (e) { $('sms-log').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  }

  // ---------------- plans ----------------
  function renderPlans() {
    const b = state.boot, u = b.usage;
    $('plan-usage-num').textContent = u.limit ? `${u.used} / ${u.limit}` : `${u.used}`;
    $('plan-usage-text').textContent = u.limit ? `orders sent to couriers on the Free plan` : 'orders sent — unlimited on Pro';
    const pct = u.limit ? Math.min(100, Math.round((u.used / u.limit) * 100)) : 100;
    $('plan-usage-bar').style.width = `${pct}%`;
    $('plan-usage-bar').classList.toggle('warn', Boolean(u.limit && pct >= 80));
    $('plans').innerHTML = b.plans.map((p) => {
      const current = p.key === b.plan;
      let cta;
      if (current) cta = '<s-button disabled>Current plan</s-button>';
      else if (p.price > 0) cta = `<s-button variant="primary" data-plan="${esc(p.key)}">${p.trialDays ? `Start ${p.trialDays}-day free trial` : 'Upgrade'}</s-button>`;
      else cta = '<s-button data-downgrade="1">Switch to Free</s-button>';
      return `<div class="card plan ${current ? 'current' : ''} ${p.price > 0 ? 'featured' : ''}">
        ${current ? '<span class="plan-tag">Your plan</span>' : p.price > 0 ? '<span class="plan-tag">Best value</span>' : ''}
        <div class="plan-name">${esc(p.name)}</div>
        <div class="price">$${esc(p.price)}<small> / month</small></div>
        <ul>${p.features.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
        <div class="cta">${cta}</div></div>`;
    }).join('');
  }

  // ---------------- boot ----------------
  function renderAll() { renderBanners(); renderDashboard(); renderCouriers(); renderSms(); renderPlans(); }
  async function refreshBoot() { state.boot = await api('/bootstrap'); renderAll(); }

  document.addEventListener('click', async (ev) => {
    const link = ev.target.closest('a[href^="/"]:not([target])');
    if (link && (link.hasAttribute('data-link') || link.hasAttribute('data-nav'))) { ev.preventDefault(); navigate(link.getAttribute('href')); return; }
    const pill = ev.target.closest('.pill');
    if (pill) { state.filter = pill.dataset.filter; renderOrders(); return; }
    const seg = ev.target.closest('#sms-source button');
    if (seg) { state.smsSource = seg.dataset.source; renderSmsSource(); return; }
    const ph = ev.target.closest('#placeholders button');
    if (ph) { const el = $('sms_template'); el.value = `${el.value || ''}{{${ph.dataset.ph}}}`; previewSms(); return; }
    const t = ev.target.closest('[data-send],[data-refresh],[data-plan],[data-downgrade],[data-manage],#send-selected,#reload-orders,#save-connection,#save-sms,#test-sms,#reload-sms');
    if (!t) return;
    try {
      if (t.dataset.manage) { $('pathao-panel').scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
      if (t.id === 'save-connection') return await busy(t, saveConnection);
      if (t.id === 'save-sms') return await busy(t, saveSms);
      if (t.id === 'test-sms') return await busy(t, testSms);
      if (t.id === 'reload-sms') return await busy(t, loadSmsLog);
      if (t.id === 'reload-orders') return await busy(t, loadOrders);
      if (t.id === 'send-selected') return await busy(t, () => sendOrders([...state.selected]));
      if (t.dataset.send) return await busy(t, () => sendOrders([t.dataset.send]));
      if (t.dataset.refresh) return await busy(t, async () => { await api(`/orders/${t.dataset.refresh}/refresh`, { method: 'POST' }); await loadOrders(); });
      if (t.dataset.plan) return await busy(t, async () => { const r = await api('/billing/subscribe', { method: 'POST', body: { plan: t.dataset.plan } }); window.open(r.confirmationUrl, '_top'); });
      if (t.dataset.downgrade) {
        if (!confirm('Cancel your paid plan and switch to Free?')) return;
        return await busy(t, async () => { await api('/billing/cancel', { method: 'POST' }); await refreshBoot(); toast('Switched to Free'); });
      }
    } catch (e) { toast(e.message, true); }
  });
  document.addEventListener('change', (ev) => {
    const box = ev.target.closest('[data-select]');
    if (!box) return;
    if (box.checked) state.selected.add(box.dataset.select); else state.selected.delete(box.dataset.select);
    updateSendButton();
  });
  // Polaris controls that don't bubble `change`: listen directly.
  $('auto_send').addEventListener('change', () => toggleAutoSend($('auto_send').checked));
  $('sms_enabled').addEventListener('change', () => toggleSms($('sms_enabled').checked));
  $('pathao_store_id').addEventListener('change', () => { if (state.boot && state.boot.settings.connected) saveStore().catch((e) => toast(e.message, true)); });
  $('sms_template').addEventListener('input', previewSms);
  $('sms_sid').addEventListener('input', previewSms);
  $('search').addEventListener('input', (e) => { state.search = e.target.value; renderOrders(); });

  async function start() {
    let embedded = true;
    try { embedded = window.top !== window.self; } catch { embedded = true; }
    if (!embedded || !(window.shopify && shopify.idToken)) {
      $('banners').innerHTML = '<s-banner tone="info" heading="Open this app from your Shopify admin">ShipBridge runs inside Shopify. Go to your store admin → <b>Apps</b> → <b>ShipBridge</b>. If it isn\'t listed, install it first.</s-banner>';
      $$('.page, #tabs').forEach((p) => { p.hidden = true; });
      return;
    }
    showPage(pageFromPath());
    try {
      await refreshBoot();
      fillPathaoForm(); fillSmsForm();
    } catch (e) {
      $('banners').innerHTML = `<s-banner tone="critical" heading="Could not load the app">${esc(e.message)}</s-banner>`;
      return;
    }
    if (state.page === 'dashboard') loadOrders(); else if (state.page === 'sms') loadSmsLog();
  }
  start();
})();
