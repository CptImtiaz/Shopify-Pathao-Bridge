/* Embedded admin UI. Plain JS + Polaris web components + App Bridge. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const state = { boot: null, orders: [], selected: new Set(), filter: 'all', editing: false };

  // ---------- helpers ----------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
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
  function setVal(id, v) { const el = $(id); el.value = v == null ? '' : String(v); el.setAttribute('value', el.value); }
  function setChecked(id, v) { const el = $(id); el.checked = Boolean(v); if (v) el.setAttribute('checked', ''); else el.removeAttribute('checked'); }
  function setDisabled(el, d) { el.disabled = d; if (d) el.setAttribute('disabled', ''); else el.removeAttribute('disabled'); }
  const show = (el, on) => { el.hidden = !on; };
  function money(n, currency) {
    return `${currency ? currency + ' ' : ''}${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  }
  function when(iso) {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ', ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  // ---------- summary ----------
  function renderSummary() {
    const b = state.boot, s = b.settings;
    show($('stats'), true);
    const ready = s.connected && s.pathao_store_id;
    $('stat-pathao').innerHTML = ready ? '<span class="ok">● Connected</span>' : s.connected ? 'Choose a store' : 'Not connected';
    $('stat-pathao-sub').textContent = ready
      ? `${s.pathao_store_name || 'Store #' + s.pathao_store_id}${s.pathao_env === 'sandbox' ? ' · Sandbox' : ''}`
      : 'Connect below to start shipping';

    setChecked('auto_send', s.auto_send);
    setDisabled($('auto_send'), !ready);
    $('stat-auto').textContent = s.auto_send ? 'On' : 'Off';

    const u = b.usage;
    $('stat-usage').textContent = u.limit ? `${u.used} / ${u.limit}` : String(u.used);
    const pct = u.limit ? Math.min(100, Math.round((u.used / u.limit) * 100)) : 100;
    $('usage-bar').style.width = `${u.limit ? pct : 100}%`;
    $('usage-bar').classList.toggle('warn', Boolean(u.limit && pct >= 80));
    $('stat-usage-sub').textContent = u.limit ? `${Math.max(0, u.limit - u.used)} left on the Free plan` : 'Unlimited on Pro';

    const plan = b.plans.find((p) => p.key === b.plan) || b.plans[0];
    $('stat-plan').textContent = plan.name;
    $('stat-plan-sub').innerHTML = plan.price
      ? `$${esc(plan.price)}/month${b.trialEndsOrRenews ? ` · renews ${esc(new Date(b.trialEndsOrRenews).toLocaleDateString())}` : ''}`
      : '<a href="#plans-section" class="link" id="see-plans">Upgrade for unlimited orders</a>';

    const banners = [];
    if (s.pathao_env === 'sandbox') banners.push('<s-banner tone="warning">Sandbox mode: orders go to Pathao\'s test system, not real couriers.</s-banner>');
    if (u.limit && u.used >= u.limit) banners.push(`<s-banner tone="critical" heading="Monthly limit reached">You've sent ${u.used} of ${u.limit} orders on the Free plan. Upgrade to Pro to keep sending this month.</s-banner>`);
    else if (ready && !s.auto_send) banners.push('<s-banner tone="info">You\'re connected. Turn on <b>Auto-send new orders</b> above, or send orders manually from the list below.</s-banner>');
    $('banners').innerHTML = banners.join('');

    // Connection form vs. connected details
    show($('connect-section'), !ready || state.editing);
    show($('account-section'), Boolean(ready) && !state.editing);
    show($('cancel-edit'), Boolean(ready) && state.editing);
    $('acc-user').textContent = s.pathao_username || '—';
    $('acc-store').textContent = s.pathao_store_name || (s.pathao_store_id ? `Store #${s.pathao_store_id}` : '—');
    $('acc-env').textContent = s.pathao_env === 'sandbox' ? 'Sandbox (testing)' : 'Live';
    $('save-connection').textContent = s.connected ? 'Save & reconnect' : 'Connect Pathao';
  }

  function fillConnectionForm() {
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

    state.boot.settings = (await api('/settings', { method: 'POST', body })).settings;
    const test = await api('/pathao/test', { method: 'POST' });
    if (!test.ok) { toast(`Pathao rejected the login: ${test.error}`, true); fillConnectionForm(); renderSummary(); return; }

    const sel = $('pathao_store_id');
    const prev = sel.value || state.boot.settings.pathao_store_id;
    sel.innerHTML = '<s-option value="">Choose a store</s-option>' + test.stores
      .map((st) => `<s-option value="${esc(st.id)}">${esc(st.name)}${st.active ? '' : ' (inactive)'}</s-option>`).join('');
    let store = test.stores.find((st) => String(st.id) === String(prev)) || (test.stores.length === 1 ? test.stores[0] : null);
    if (store) {
      setVal('pathao_store_id', store.id);
      state.boot.settings = (await api('/settings', { method: 'POST', body: { pathao_store_id: store.id, pathao_store_name: store.name } })).settings;
      state.editing = false;
      toast('Pathao connected');
    } else {
      toast(`Connected — now choose your pickup store (${test.stores.length} found)`);
    }
    fillConnectionForm(); renderSummary();
  }

  async function saveStore() {
    const sel = $('pathao_store_id');
    if (!sel.value) return;
    const opt = sel.querySelector(`s-option[value="${sel.value}"]`);
    state.boot.settings = (await api('/settings', { method: 'POST', body: { pathao_store_id: sel.value, pathao_store_name: opt ? opt.textContent.replace(' (inactive)', '') : null } })).settings;
    state.editing = false;
    toast('Pickup store saved');
    renderSummary();
  }

  async function toggleAutoSend(on) {
    let msg, isErr = false;
    try {
      state.boot.settings = (await api('/settings', { method: 'POST', body: { auto_send: on } })).settings;
      msg = on ? 'Auto-send is on — new orders go to Pathao automatically' : 'Auto-send is off';
    } catch (e) { msg = e.message; isErr = true; }
    renderSummary();
    toast(msg, isErr);
  }

  // ---------- orders ----------
  const canSend = (o) => !o.cancelled && (!o.shipment || ['failed', 'skipped'].includes(o.shipment.status));
  function bucket(o) {
    if (o.cancelled) return 'other';
    if (!o.shipment) return 'todo';
    if (o.shipment.status === 'sent') return 'sent';
    if (o.shipment.status === 'processing') return 'other';
    return 'problem';
  }
  function statusCell(o) {
    const s = o.shipment;
    if (o.cancelled) return '<s-badge>Cancelled</s-badge>';
    if (!s) return '<s-badge>Not sent</s-badge>';
    if (s.status === 'sent') {
      return `<s-badge tone="success">${esc(s.pathaoStatus && s.pathaoStatus !== 'Pending' ? s.pathaoStatus : 'Sent')}</s-badge>` +
        `<span class="sub">Consignment ${esc(s.consignmentId || '')}${s.deliveryFee != null ? ` · fee ${esc(s.deliveryFee)}` : ''}</span>`;
    }
    if (s.status === 'processing') return '<s-badge tone="info">Sending…</s-badge>';
    if (s.status === 'skipped') return `<s-badge tone="warning">Skipped</s-badge><span class="err">${esc(s.error)}</span>`;
    return `<s-badge tone="critical">Failed</s-badge><span class="err">${esc(s.error)}</span>`;
  }

  function renderOrders() {
    const counts = { all: state.orders.length, todo: 0, sent: 0, problem: 0 };
    state.orders.forEach((o) => { const k = bucket(o); if (counts[k] != null) counts[k] += 1; });
    Object.keys(counts).forEach((k) => { $(`c-${k}`).textContent = counts[k] ? counts[k] : ''; });
    document.querySelectorAll('.pill').forEach((p) => p.classList.toggle('active', p.dataset.filter === state.filter));

    const rows = state.orders.filter((o) => state.filter === 'all' || bucket(o) === state.filter);
    const empty = $('orders-empty');
    if (!rows.length) {
      $('orders-body').innerHTML = '';
      show($('orders-table'), false); show(empty, true);
      empty.innerHTML = state.orders.length
        ? '<b>Nothing here</b>No orders match this filter.'
        : '<b>No orders yet</b>New orders from your store will appear here.';
      updateSendButton();
      return;
    }
    show($('orders-table'), true); show(empty, false);
    $('orders-body').innerHTML = rows.map((o) => {
      const sendable = canSend(o);
      let action = '';
      if (sendable) action = `<s-button data-send="${esc(o.id)}">${o.shipment ? 'Retry' : 'Send'}</s-button>`;
      else if (o.shipment && o.shipment.status === 'sent') action = `<s-button variant="tertiary" data-refresh="${esc(o.id)}">Update status</s-button>`;
      return `<s-table-row>
        <s-table-cell>${sendable ? `<s-checkbox accessibilitylabel="Select ${esc(o.name)}" data-select="${esc(o.id)}" ${state.selected.has(o.id) ? 'checked' : ''}></s-checkbox>` : ''}</s-table-cell>
        <s-table-cell><span class="order-name">${esc(o.name)}</span><span class="sub">${esc(when(o.createdAt))}</span></s-table-cell>
        <s-table-cell>${esc(o.customer) || '—'}${o.city ? `<span class="sub">${esc(o.city)}</span>` : ''}</s-table-cell>
        <s-table-cell>${o.cod > 0 ? esc(money(o.cod, o.currency)) : '<span class="sub">Prepaid</span>'}</s-table-cell>
        <s-table-cell>${statusCell(o)}</s-table-cell>
        <s-table-cell>${action}</s-table-cell>
      </s-table-row>`;
    }).join('');
    updateSendButton();
  }

  function updateSendButton() {
    const btn = $('send-selected');
    setDisabled(btn, state.selected.size === 0);
    btn.textContent = state.selected.size ? `Send ${state.selected.size} to Pathao` : 'Send to Pathao';
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
    if (ok) toast(`${ok} order${ok > 1 ? 's' : ''} sent to Pathao`);
    if (failed.length) toast(`${failed.length} failed: ${failed[0].error}`, true);
    ids.forEach((id) => state.selected.delete(id));
    await refreshBoot();
    await loadOrders();
  }

  // ---------- plans ----------
  function renderPlans() {
    const b = state.boot;
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
        <div class="cta">${cta}</div>
      </div>`;
    }).join('');
  }

  // ---------- boot ----------
  async function refreshBoot() {
    state.boot = await api('/bootstrap');
    renderSummary();
    renderPlans();
  }

  document.addEventListener('click', async (ev) => {
    const pill = ev.target.closest('.pill');
    if (pill) { state.filter = pill.dataset.filter; renderOrders(); return; }
    if (ev.target.closest('#see-plans')) { ev.preventDefault(); $('plans-section').scrollIntoView({ behavior: 'smooth' }); return; }
    const t = ev.target.closest('[data-send],[data-refresh],[data-plan],[data-downgrade],#send-selected,#reload-orders,#save-connection,#edit-connection,#cancel-edit');
    if (!t) return;
    try {
      if (t.id === 'save-connection') return await busy(t, saveConnection);
      if (t.id === 'edit-connection') { state.editing = true; fillConnectionForm(); renderSummary(); return; }
      if (t.id === 'cancel-edit') { state.editing = false; renderSummary(); return; }
      if (t.id === 'reload-orders') return await busy(t, loadOrders);
      if (t.id === 'send-selected') return await busy(t, () => sendOrders([...state.selected]));
      if (t.dataset.send) return await busy(t, () => sendOrders([t.dataset.send]));
      if (t.dataset.refresh) return await busy(t, async () => { await api(`/orders/${t.dataset.refresh}/refresh`, { method: 'POST' }); await loadOrders(); });
      if (t.dataset.plan) {
        return await busy(t, async () => {
          const r = await api('/billing/subscribe', { method: 'POST', body: { plan: t.dataset.plan } });
          window.open(r.confirmationUrl, '_top'); // Shopify's charge approval page
        });
      }
      if (t.dataset.downgrade) {
        if (!confirm('Cancel your paid plan and switch to Free?')) return;
        return await busy(t, async () => { await api('/billing/cancel', { method: 'POST' }); await refreshBoot(); toast('Switched to Free'); });
      }
    } catch (e) { toast(e.message, true); }
  });

  document.addEventListener('change', (ev) => {
    const box = ev.target.closest('[data-select]');
    if (box) {
      if (box.checked) state.selected.add(box.dataset.select); else state.selected.delete(box.dataset.select);
      updateSendButton();
      return;
    }
  });
  // Some Polaris controls don't bubble `change`, so listen on them directly.
  $('auto_send').addEventListener('change', () => toggleAutoSend($('auto_send').checked));
  $('pathao_store_id').addEventListener('change', () => {
    if (state.boot && state.boot.settings.connected) saveStore().catch((e) => toast(e.message, true));
  });

  async function start() {
    let embedded = true;
    try { embedded = window.top !== window.self; } catch { embedded = true; }
    if (!embedded || !(window.shopify && shopify.idToken)) {
      $('banners').innerHTML = '<s-banner tone="info" heading="Open this app from your Shopify admin">' +
        'ShipBridge runs inside Shopify. Go to your store admin → <b>Apps</b> → <b>ShipBridge for Pathao</b>. ' +
        'If it is not listed yet, install it first.</s-banner>';
      document.querySelectorAll('s-section').forEach((s) => { s.hidden = true; });
      return;
    }
    try {
      await refreshBoot();
      fillConnectionForm();
      renderSummary();
    } catch (e) {
      $('banners').innerHTML = `<s-banner tone="critical" heading="Could not load the app">${esc(e.message)}</s-banner>`;
      return;
    }
    loadOrders();
  }

  start();
})();
