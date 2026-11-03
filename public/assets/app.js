/* ShipBridge embedded admin UI — Dashboard / Settings / Plans. Plain JS + Polaris web components + App Bridge. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const state = { boot: null, orders: [], selected: new Set(), tab: 'all', search: '', page: 'dashboard', settingsTab: 'couriers', section: 'api', detail: false, menuFor: null, loaded: false };

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
  async function busy(el, fn) {
    if (el.tagName === 'S-BUTTON') { el.loading = true; el.setAttribute('loading', ''); } else el.disabled = true;
    try { return await fn(); } finally { if (el.tagName === 'S-BUTTON') { el.loading = false; el.removeAttribute('loading'); } else el.disabled = false; }
  }
  const setVal = (id, v) => { const el = $(id); el.value = v == null ? '' : String(v); el.setAttribute('value', el.value); };
  const show = (el, on) => { el.hidden = !on; };
  const money = (n) => `৳ ${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const when = (iso) => { const d = new Date(iso); return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`; };
  const courierInfo = (key) => (state.boot.couriers || []).find((c) => c.key === key) || { key, name: key, color: '#6b7280' };
  const mono = (c, cls = '') => `<span class="mono ${cls}" style="--c:${esc(c.color)}">${esc(c.name.charAt(0))}</span>`;
  function apply(r) { if (r.settings) state.boot.settings = r.settings; if (r.couriers) state.boot.couriers = r.couriers; }

  // ---------------- routing ----------------
  const ROUTES = { '/': 'dashboard', '/app': 'dashboard', '/settings': 'settings', '/couriers': 'settings', '/sms': 'settings', '/plans': 'plans' };
  const pageFromPath = () => ROUTES[location.pathname.replace(/\/$/, '') || '/'] || 'dashboard';
  function showPage(page) {
    state.page = page;
    if (location.pathname === '/sms') state.settingsTab = 'sms';
    $$('.page').forEach((p) => show(p, p.dataset.page === page));
    closeMenu();
    window.scrollTo(0, 0);
    if (page === 'dashboard' && state.boot && !state.loaded) loadOrders();
    if (page === 'settings' && state.boot) renderSettings();
  }
  function navigate(path) {
    if (location.pathname !== path) history.pushState({}, '', path + location.search);
    showPage(pageFromPath());
  }
  window.addEventListener('popstate', () => showPage(pageFromPath()));
  document.addEventListener('shopify:navigate', (e) => {
    const href = e.target && e.target.getAttribute && e.target.getAttribute('href');
    if (href) { if (e.preventDefault) e.preventDefault(); navigate(href); }
  });

  // ---------------- banners ----------------
  function renderBanners() {
    const b = state.boot, s = b.settings, out = [];
    if (b.webhooks && b.webhooks.ok === false) out.push(`<s-banner tone="critical" heading="New orders can't reach the app">Shopify refused to set up order notifications: ${esc(b.webhooks.error)}</s-banner>`);
    if (s.pathao_env === 'sandbox') out.push('<s-banner tone="warning">Pathao is in sandbox mode: bookings go to the test system, not real couriers.</s-banner>');
    if (b.usage.limit && b.usage.used >= b.usage.limit) out.push(`<s-banner tone="critical" heading="Monthly limit reached">You've used all ${b.usage.limit} orders on the Free plan. <a class="link" href="/plans" data-link>Upgrade to keep shipping</a>.</s-banner>`);
    $('banners').innerHTML = out.join('');
  }

  // ---------------- dashboard ----------------
  function renderHeader() {
    const u = state.boot.usage;
    $('usage-line').textContent = u.limit ? `Orders: ${u.used} / ${u.limit} this month` : `Orders: ${u.used} this month · Unlimited`;
    const def = courierInfo(state.boot.settings.default_courier || 'pathao');
    $('bulk-default').textContent = `Assign ${def.name}`;
  }
  function renderSetup() {
    const s = state.boot.settings;
    const others = (state.boot.couriers || []).filter((c) => c.key !== 'pathao');
    const steps = [
      { done: s.connected, html: `Add a courier to start assigning deliveries <span class="step-actions"><button class="btn sm" data-open-courier="pathao">Add Pathao</button>${others.map((c) => `<button class="btn sm" disabled title="Coming soon">Add ${esc(c.name)}</button>`).join('')}</span>` },
      { done: Boolean(s.pathao_store_id), html: 'Choose the Pathao store parcels are picked up from <span class="step-actions"><button class="btn sm" data-open-courier="pathao">Choose store</button></span>' },
      { done: s.auto_send, html: 'Send new orders to Pathao automatically <span class="step-actions"><button class="btn sm" data-open-courier="pathao" data-sec="defaults">Turn on auto-send</button></span>' },
    ];
    const done = steps.filter((x) => x.done).length;
    show($('setup'), done < steps.length);
    $('setup-count').textContent = `${done} of ${steps.length} tasks complete`;
    $('setup-bar').style.width = `${Math.round((done / steps.length) * 100)}%`;
    $('steps').innerHTML = steps.map((x) => `<li class="${x.done ? 'done' : ''}"><span class="tick"></span><span class="step-text">${x.done ? x.html.replace(/<span class="step-actions">[\s\S]*<\/span>$/, '') : x.html}</span></li>`).join('');
  }

  // Delivery status bucket (shared by tabs and badges)
  function bucket(o) {
    if (o.cancelled) return 'cancelled';
    const s = o.shipment;
    if (!s) return 'new';
    if (s.status === 'failed' || s.status === 'skipped') return 'failed';
    if (s.status === 'processing') return 'pending';
    const ps = String(s.pathaoStatus || '').toLowerCase();
    if (/deliver/.test(ps) && !/fail/.test(ps)) return 'delivered';
    if (/return/.test(ps)) return 'returned';
    if (/cancel/.test(ps)) return 'cancelled';
    if (/transit|picked|assigned|on.?the.?way|hub|out.?for/.test(ps)) return 'shipping';
    return 'pending';
  }
  const TABS = [['all', 'All'], ['new', 'New'], ['pending', 'Pending'], ['shipping', 'Shipping'], ['delivered', 'Delivered'], ['returned', 'Returned'], ['cancelled', 'Cancelled'], ['failed', 'Failed']];
  const STATUS_BADGE = {
    new: ['Not assigned', ''], pending: ['Pending pickup', 'yellow'], shipping: ['In transit', 'blue'], delivered: ['Delivered', 'green'],
    returned: ['Returned', 'red'], cancelled: ['Cancelled', ''], failed: ['Failed', 'red'],
  };
  const canAssign = (o) => !o.cancelled && (!o.shipment || ['failed', 'skipped'].includes(o.shipment.status));

  function renderTabs() {
    const counts = Object.fromEntries(TABS.map(([k]) => [k, 0]));
    counts.all = state.orders.length;
    state.orders.forEach((o) => { counts[bucket(o)] += 1; });
    $('status-tabs').innerHTML = TABS.map(([k, label]) => `<button data-tab="${k}" class="${state.tab === k ? 'active' : ''}">${label} <span class="count">${counts[k]}</span></button>`).join('');
  }
  function payBadge(o) {
    const f = String(o.financial || '').toUpperCase();
    if (f === 'PAID') return '<span class="badge green">Paid</span>';
    if (f === 'PARTIALLY_PAID') return '<span class="badge yellow">Partially paid</span>';
    if (f === 'REFUNDED' || f === 'PARTIALLY_REFUNDED') return '<span class="badge">Refunded</span>';
    return '<span class="badge yellow">Pending</span>';
  }
  function fulfillBadge(o) {
    const f = String(o.fulfillment || '').toUpperCase();
    if (f === 'FULFILLED') return '<span class="badge">Fulfilled</span>';
    if (f === 'PARTIALLY_FULFILLED') return '<span class="badge yellow">Partial</span>';
    return '<span class="badge yellow">Unfulfilled</span>';
  }
  function statusCell(o) {
    const k = bucket(o), [label, tone] = STATUS_BADGE[k];
    const s = o.shipment;
    let extra = '';
    if (s && s.status === 'sent' && s.consignmentId) extra = `<span class="sub">${esc(s.consignmentId)}${s.deliveryFee != null ? ` · ৳${esc(s.deliveryFee)}` : ''}</span>`;
    if (s && (s.status === 'failed' || s.status === 'skipped')) extra = `<span class="err">${esc(s.error)}</span>`;
    return `<span class="badge ${tone}">${label}</span>${extra}`;
  }
  function courierCell(o) {
    if (canAssign(o)) return `<button class="assign" data-assign="${esc(o.id)}"><svg viewBox="0 0 24 24"><path d="M3 7h11v9H3zM14 10h4l3 3v3h-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="7" cy="17.5" r="1.6" fill="currentColor"/><circle cx="17" cy="17.5" r="1.6" fill="currentColor"/></svg>${o.shipment ? 'Retry' : 'Assign Courier'}</button>`;
    if (o.shipment && o.shipment.status === 'sent') {
      const c = courierInfo(o.shipment.courier || 'pathao');
      return `<span class="courier-chip">${mono(c)}${esc(c.name)}</span><button class="link-btn" data-track="${esc(o.id)}">Update status</button>`;
    }
    if (o.shipment && o.shipment.status === 'processing') return '<span class="sub">Sending…</span>';
    return '<span class="sub">—</span>';
  }
  function filtered() {
    const q = state.search.trim().toLowerCase();
    return state.orders.filter((o) => (state.tab === 'all' || bucket(o) === state.tab)
      && (!q || `${o.name} ${o.customer} ${o.phone} ${o.city} ${o.shipment ? o.shipment.consignmentId : ''}`.toLowerCase().includes(q)));
  }
  function renderOrders() {
    renderTabs();
    const rows = filtered();
    show($('orders-loading'), false);
    const empty = $('orders-empty');
    if (!rows.length) {
      $('orders-body').innerHTML = '';
      show(empty, true);
      empty.innerHTML = state.orders.length ? '<b>No orders here</b>Try another tab or search.' : '<b>No orders yet</b>New orders from your store will appear here.';
    } else {
      show(empty, false);
      $('orders-body').innerHTML = rows.map((o) => {
        const sel = state.selected.has(o.id);
        return `<tr class="${sel ? 'selected' : ''}">
          <td class="c-check">${canAssign(o) ? `<input type="checkbox" data-select="${esc(o.id)}" ${sel ? 'checked' : ''} aria-label="Select ${esc(o.name)}" />` : ''}</td>
          <td><span class="o-name">${esc(o.name)}</span><span class="sub">${esc(when(o.createdAt))}</span></td>
          <td class="items"><span class="t" title="${esc(o.items)}">${esc(o.items || '—')}</span><span class="sub">${o.itemCount || 0} item${o.itemCount === 1 ? '' : 's'}</span></td>
          <td><b>${esc(o.customer) || '—'}</b><span class="sub">${esc(o.phone || o.city || '')}</span></td>
          <td><span class="amount">${esc(money(o.total))}</span><span class="sub">${payBadge(o)}${o.cod > 0 && String(o.financial).toUpperCase() !== 'PAID' ? ` COD ${esc(money(o.cod))}` : ''}</span></td>
          <td>${fulfillBadge(o)}</td>
          <td>${statusCell(o)}</td>
          <td>${courierCell(o)}</td>
        </tr>`;
      }).join('');
    }
    const assignable = rows.filter(canAssign);
    $('check-all').checked = assignable.length > 0 && assignable.every((o) => state.selected.has(o.id));
    $('check-all').disabled = assignable.length === 0;
    renderBulk();
  }
  function renderBulk() {
    show($('bulkbar'), state.selected.size > 0);
    $('bulk-count').textContent = `${state.selected.size} selected`;
  }
  async function loadOrders() {
    show($('orders-loading'), !state.orders.length);
    try {
      state.orders = (await api('/orders')).orders;
      state.loaded = true;
      const ok = new Set(state.orders.filter(canAssign).map((o) => o.id));
      for (const id of [...state.selected]) if (!ok.has(id)) state.selected.delete(id);
      renderOrders();
    } catch (e) { show($('orders-loading'), false); toast(e.message, true); }
  }
  async function assign(ids, courier) {
    const c = courierInfo(courier);
    const r = await api('/orders/send', { method: 'POST', body: { ids, courier } });
    const ok = r.results.filter((x) => x.ok).length;
    const failed = r.results.filter((x) => !x.ok && !x.duplicate);
    if (ok) toast(`${ok} order${ok > 1 ? 's' : ''} assigned to ${c.name}`);
    if (failed.length) toast(`${failed.length} failed: ${failed[0].error}`, true);
    ids.forEach((id) => state.selected.delete(id));
    await refreshBoot(); await loadOrders();
  }

  // courier dropdown (single + bulk)
  function openMenu(anchor, target) {
    const m = $('courier-menu');
    state.menuFor = target;
    m.innerHTML = '<div class="menu-title">Assign to</div>' + (state.boot.couriers || []).map((c) => {
      const usable = c.available && c.status === 'connected';
      const why = !c.available ? '<span class="soon">Soon</span>' : c.status !== 'connected' ? '<span class="soon">Set up</span>' : (c.isDefault ? '<span class="sub">Default</span>' : '');
      return `<button data-pick="${esc(c.key)}" ${usable ? '' : 'disabled'}>${mono(c)}${esc(c.name)}${why}</button>`;
    }).join('');
    const r = anchor.getBoundingClientRect();
    m.style.top = `${r.bottom + window.scrollY + 6}px`;
    m.style.left = `${Math.min(r.left + window.scrollX, window.innerWidth - 240)}px`;
    show(m, true);
  }
  function closeMenu() { show($('courier-menu'), false); state.menuFor = null; }

  // ---------------- settings ----------------
  const STATUS_PILL = { connected: ['Configured', 'ok'], needs_store: ['Choose a store', 'warn'], not_connected: ['Not configured', ''], coming_soon: ['Coming soon', ''] };
  function renderSettings() {
    $$('.settings-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.settingsTab));
    const onCouriers = state.settingsTab === 'couriers';
    show($('courier-list'), onCouriers && !state.detail);
    show($('courier-detail'), onCouriers && state.detail);
    show($('sms-tab'), state.settingsTab === 'sms');

    $('courier-grid').innerHTML = (state.boot.couriers || []).map((c) => {
      const [label, tone] = STATUS_PILL[c.status] || STATUS_PILL.not_connected;
      return `<div class="card c-card ${c.available ? '' : 'soon-card-c'}">
        <div class="c-banner ${c.key === 'steadfast' || c.key === 'pathao' ? 'light' : ''}" style="--c:${esc(c.color)}"><span class="word">${esc(c.name)}</span></div>
        <div class="c-body">
          <div class="c-title"><b>${esc(c.name)}</b><span class="status-pill ${tone}">${label}</span>${c.isDefault && c.available ? '<span class="default-pill">Default</span>' : ''}</div>
          <div class="c-desc">${esc(c.tagline)}</div>
          ${c.detail ? `<div class="sub">${esc(c.detail)}</div>` : ''}
          <div class="c-foot">${c.available ? `<button class="btn primary sm" data-open-courier="${esc(c.key)}">Configure</button>` : '<button class="btn sm" disabled>Coming soon</button>'}</div>
        </div>
      </div>`;
    }).join('');

    const s = state.boot.settings;
    const ready = s.connected && s.pathao_store_id;
    const pill = $('pathao-status');
    pill.textContent = ready ? 'Configured' : s.connected ? 'Choose a store' : 'Not configured';
    pill.className = `status-pill ${ready ? 'ok' : s.connected ? 'warn' : ''}`;
    $$('.detail-nav button').forEach((b) => b.classList.toggle('active', b.dataset.section === state.section));
    $$('[data-section-panel]').forEach((p) => show(p, p.dataset.sectionPanel === state.section));
  }
  function fillForms() {
    const s = state.boot.settings;
    setVal('pathao_env', s.pathao_env);
    setVal('pathao_client_id', s.pathao_client_id);
    setVal('pathao_username', s.pathao_username);
    setVal('pathao_client_secret', ''); setVal('pathao_password', '');
    $('pathao_client_secret').setAttribute('placeholder', s.has_client_secret ? '•••••••• saved' : 'Enter your Pathao Client Secret');
    $('pathao_password').setAttribute('placeholder', s.has_password ? '•••••••• saved' : 'Enter your Pathao password');
    if (s.pathao_store_id && !$('pathao_store_id').querySelector(`s-option[value="${s.pathao_store_id}"]`)) {
      $('pathao_store_id').insertAdjacentHTML('beforeend', `<s-option value="${esc(s.pathao_store_id)}">${esc(s.pathao_store_name || 'Store #' + s.pathao_store_id)}</s-option>`);
    }
    setVal('pathao_store_id', s.pathao_store_id || '');
    setVal('wh_url', state.boot.pathaoWebhook.url);
    setVal('wh_secret', state.boot.pathaoWebhook.secret);
    $('is_default').checked = (s.default_courier || 'pathao') === 'pathao';
    $('auto_send').checked = Boolean(s.auto_send);
    $('auto_send').disabled = !(s.connected && s.pathao_store_id);
    setVal('default_weight', s.default_weight);
    setVal('default_note', s.default_note);
    $$('input[name=delivery_type]').forEach((r) => { r.checked = String(r.value) === String(s.delivery_type); });
  }
  async function saveConnection() {
    const body = { pathao_env: $('pathao_env').value, pathao_client_id: $('pathao_client_id').value, pathao_username: $('pathao_username').value };
    if ($('pathao_client_secret').value) body.pathao_client_secret = $('pathao_client_secret').value;
    if ($('pathao_password').value) body.pathao_password = $('pathao_password').value;
    if (!body.pathao_client_id || !body.pathao_username) return toast('Enter your Pathao Client ID and email', true);
    const storeSel = $('pathao_store_id').value;
    apply(await api('/settings', { method: 'POST', body }));
    const test = await api('/pathao/test', { method: 'POST' });
    if (!test.ok) { toast(`Pathao rejected the login: ${test.error}`, true); fillForms(); renderAll(); return; }
    const sel = $('pathao_store_id');
    const prev = storeSel || state.boot.settings.pathao_store_id;
    sel.innerHTML = '<s-option value="">Choose a store</s-option>' + test.stores.map((st) => `<s-option value="${esc(st.id)}">${esc(st.name)}${st.active ? '' : ' (inactive)'}</s-option>`).join('');
    const store = test.stores.find((st) => String(st.id) === String(prev)) || (test.stores.length === 1 ? test.stores[0] : null);
    if (store) {
      apply(await api('/settings', { method: 'POST', body: { pathao_store_id: store.id, pathao_store_name: store.name } }));
      toast('Pathao connected');
    } else toast(`Connected — now choose your pickup store (${test.stores.length} found)`);
    fillForms(); if (store) setVal('pathao_store_id', store.id); renderAll();
  }
  async function saveStore() {
    const sel = $('pathao_store_id');
    if (!sel.value || !/^\d+$/.test(sel.value)) return;
    const opt = sel.querySelector(`s-option[value="${sel.value}"]`);
    apply(await api('/settings', { method: 'POST', body: { pathao_store_id: sel.value, pathao_store_name: opt ? opt.textContent.replace(' (inactive)', '') : null } }));
    toast('Pickup store saved'); renderAll();
  }
  async function saveWebhook() {
    const secret = String($('wh_secret').value || '').trim();
    apply(await api('/settings', { method: 'POST', body: { webhook_secret: secret } }));
    state.boot.pathaoWebhook.secret = secret;
    toast('Webhook secret saved');
  }
  async function saveDefaults() {
    const dt = ($$('input[name=delivery_type]').find((r) => r.checked) || {}).value || 48;
    const body = { default_weight: $('default_weight').value || 0.5, default_note: $('default_note').value, delivery_type: dt, auto_send: $('auto_send').checked };
    if ($('is_default').checked) body.default_courier = 'pathao';
    apply(await api('/settings', { method: 'POST', body }));
    fillForms(); renderAll(); toast('Default settings saved');
  }

  // ---------------- plans ----------------
  function renderPlans() {
    const b = state.boot, u = b.usage;
    $('plan-usage-num').textContent = u.limit ? `${u.used} / ${u.limit}` : `${u.used}`;
    $('plan-usage-text').textContent = u.limit ? 'orders assigned to couriers on the Free plan' : 'orders assigned — unlimited on Pro';
    const pct = u.limit ? Math.min(100, Math.round((u.used / u.limit) * 100)) : 100;
    $('plan-usage-bar').style.width = `${pct}%`;
    $('plan-usage-bar').classList.toggle('warn', Boolean(u.limit && pct >= 80));
    $('plans').innerHTML = b.plans.map((p) => {
      const current = p.key === b.plan;
      let cta;
      if (current) cta = '<button class="btn" disabled>Current plan</button>';
      else if (p.price > 0) cta = `<s-button variant="primary" data-plan="${esc(p.key)}">${p.trialDays ? `Start ${p.trialDays}-day free trial` : 'Upgrade'}</s-button>`;
      else cta = '<s-button data-downgrade="1">Switch to Free</s-button>';
      return `<div class="card plan ${current ? 'current' : ''}">
        ${current ? '<span class="plan-tag">Your plan</span>' : ''}
        <div class="plan-name">${esc(p.name)}</div>
        <div class="price">$${esc(p.price)}<small> / month</small></div>
        <ul>${p.features.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
        <div class="cta">${cta}</div></div>`;
    }).join('');
  }

  // ---------------- wiring ----------------
  function renderAll() { renderBanners(); renderHeader(); renderSetup(); if (state.loaded) renderOrders(); renderSettings(); renderPlans(); }
  async function refreshBoot() { state.boot = await api('/bootstrap'); renderAll(); }

  document.addEventListener('click', async (ev) => {
    const t = ev.target;
    if (!t.closest('#courier-menu') && !t.closest('[data-assign]') && !t.closest('#bulk-menu-btn')) closeMenu();
    const link = t.closest('a[data-link]');
    if (link) { ev.preventDefault(); navigate(link.getAttribute('href')); return; }
    if (t.closest('#setup-toggle')) { $('setup').classList.toggle('collapsed'); return; }
    const tab = t.closest('#status-tabs button');
    if (tab) { state.tab = tab.dataset.tab; renderOrders(); return; }
    const stab = t.closest('.settings-tabs button');
    if (stab) { state.settingsTab = stab.dataset.tab; state.detail = false; renderSettings(); return; }
    const sec = t.closest('.detail-nav button');
    if (sec) { state.section = sec.dataset.section; renderSettings(); return; }
    if (t.closest('#back-couriers')) { ev.preventDefault(); state.detail = false; renderSettings(); return; }
    const open = t.closest('[data-open-courier]');
    if (open && !open.disabled) {
      state.settingsTab = 'couriers'; state.detail = true; state.section = open.dataset.sec || 'api';
      fillForms(); navigate('/settings'); renderSettings(); return;
    }
    const reset = t.closest('[data-reset]');
    if (reset) { fillForms(); toast('Changes discarded'); return; }
    if (t.closest('#copy-url')) {
      try { await navigator.clipboard.writeText(state.boot.pathaoWebhook.url); toast('Callback URL copied'); }
      catch { toast('Copy failed — select the URL and copy it manually', true); }
      return;
    }
    const assignBtn = t.closest('[data-assign]');
    if (assignBtn) { openMenu(assignBtn, [assignBtn.dataset.assign]); return; }
    if (t.closest('#bulk-menu-btn')) { openMenu($('bulk-menu-btn'), [...state.selected]); return; }
    const pick = t.closest('[data-pick]');
    if (pick && !pick.disabled) { const ids = state.menuFor || []; closeMenu(); try { await assign(ids, pick.dataset.pick); } catch (e) { toast(e.message, true); } return; }
    if (t.closest('#bulk-clear')) { state.selected.clear(); renderOrders(); return; }

    const b = t.closest('#bulk-default,#reload-orders,#save-connection,#save-webhook,#save-defaults,[data-track],[data-plan],[data-downgrade]');
    if (!b) return;
    try {
      if (b.id === 'bulk-default') return await busy(b, () => assign([...state.selected], state.boot.settings.default_courier || 'pathao'));
      if (b.id === 'reload-orders') return await busy(b, async () => { await refreshBoot(); await loadOrders(); });
      if (b.id === 'save-connection') return await busy(b, saveConnection);
      if (b.id === 'save-webhook') return await busy(b, saveWebhook);
      if (b.id === 'save-defaults') return await busy(b, saveDefaults);
      if (b.dataset.track) return await busy(b, async () => { await api(`/orders/${b.dataset.track}/refresh`, { method: 'POST' }); await loadOrders(); });
      if (b.dataset.plan) return await busy(b, async () => { const r = await api('/billing/subscribe', { method: 'POST', body: { plan: b.dataset.plan } }); window.open(r.confirmationUrl, '_top'); });
      if (b.dataset.downgrade) {
        if (!confirm('Cancel your paid plan and switch to Free?')) return;
        return await busy(b, async () => { await api('/billing/cancel', { method: 'POST' }); await refreshBoot(); toast('Switched to Free'); });
      }
    } catch (e) { toast(e.message, true); }
  });
  document.addEventListener('change', (ev) => {
    const box = ev.target.closest('[data-select]');
    if (box) { if (box.checked) state.selected.add(box.dataset.select); else state.selected.delete(box.dataset.select); renderOrders(); return; }
    if (ev.target.id === 'check-all') {
      filtered().filter(canAssign).forEach((o) => { if (ev.target.checked) state.selected.add(o.id); else state.selected.delete(o.id); });
      renderOrders();
    }
  });
  $('pathao_store_id').addEventListener('change', () => { if (state.boot && state.boot.settings.connected) saveStore().catch((e) => toast(e.message, true)); });
  $('search').addEventListener('input', (e) => { state.search = e.target.value; renderOrders(); });
  window.addEventListener('resize', closeMenu);

  async function start() {
    let embedded = true;
    try { embedded = window.top !== window.self; } catch { embedded = true; }
    if (!embedded || !(window.shopify && shopify.idToken)) {
      $('banners').innerHTML = '<s-banner tone="info" heading="Open this app from your Shopify admin">ShipBridge runs inside Shopify. Go to your store admin → <b>Apps</b> → <b>ShipBridge</b>. If it isn\'t listed, install it first.</s-banner>';
      $$('.page').forEach((p) => { p.hidden = true; });
      return;
    }
    showPage(pageFromPath());
    try { await refreshBoot(); fillForms(); }
    catch (e) { $('banners').innerHTML = `<s-banner tone="critical" heading="Could not load the app">${esc(e.message)}</s-banner>`; return; }
    if (state.page === 'dashboard') loadOrders();
    renderSettings();
  }
  start();
})();
