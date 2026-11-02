/* Embedded admin UI. Plain JS + Polaris web components + App Bridge. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const state = { boot: null, orders: [], selected: new Set() };

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
      return fetch(`/api${path}`, {
        method: opts.method || 'GET',
        headers,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
    };
    let res = await doFetch();
    if (res.status === 401) res = await doFetch(); // session token may have just expired
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  async function busy(button, fn) {
    button.loading = true;
    button.setAttribute('loading', '');
    try { return await fn(); } finally { button.loading = false; button.removeAttribute('loading'); }
  }

  function setVal(id, v) {
    const el = $(id);
    el.value = v == null ? '' : String(v);
    el.setAttribute('value', el.value);
  }
  function setChecked(id, v) {
    const el = $(id);
    el.checked = Boolean(v);
    if (v) el.setAttribute('checked', ''); else el.removeAttribute('checked');
  }

  function money(n, currency) {
    const v = Number(n || 0);
    return `${currency ? currency + ' ' : ''}${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  }

  // ---------- banners ----------
  function renderBanners() {
    const b = state.boot;
    const out = [];
    if (!b.settings.connected) {
      out.push(`<s-banner tone="info" heading="Finish setup">Connect your Pathao account below, pick a pickup store, then switch on auto-send.</s-banner>`);
    } else if (!b.settings.pathao_store_id) {
      out.push(`<s-banner tone="warning" heading="Choose a pickup store">Click “Save &amp; test connection” and choose the Pathao store parcels are picked up from.</s-banner>`);
    }
    if (b.settings.pathao_env === 'sandbox') {
      out.push(`<s-banner tone="warning">Sandbox mode: orders go to Pathao's test system, not real couriers.</s-banner>`);
    }
    if (b.usage.limit && b.usage.used >= b.usage.limit) {
      out.push(`<s-banner tone="critical" heading="Monthly limit reached">You've sent ${b.usage.used} of ${b.usage.limit} orders this month on the Free plan. Upgrade to Pro to keep sending.</s-banner>`);
    }
    $('banners').innerHTML = out.join('');
  }

  // ---------- settings ----------
  function renderSettings() {
    const s = state.boot.settings;
    setVal('pathao_env', s.pathao_env);
    setVal('pathao_client_id', s.pathao_client_id);
    setVal('pathao_username', s.pathao_username);
    $('pathao_client_secret').setAttribute('placeholder', s.has_client_secret ? '•••••••• (saved)' : '');
    $('pathao_password').setAttribute('placeholder', s.has_password ? '•••••••• (saved)' : '');
    if (s.pathao_store_id && !$('pathao_store_id').querySelector(`s-option[value="${s.pathao_store_id}"]`)) {
      $('pathao_store_id').insertAdjacentHTML('beforeend', `<s-option value="${esc(s.pathao_store_id)}">Store #${esc(s.pathao_store_id)}</s-option>`);
    }
    setVal('pathao_store_id', s.pathao_store_id || '');
    setChecked('auto_send', s.auto_send);
    setVal('delivery_type', s.delivery_type);
    setVal('item_type', s.item_type);
    setVal('default_weight', s.default_weight);
    setVal('skip_tag', s.skip_tag);
    setChecked('only_cod', s.only_cod);
    setChecked('tag_orders', s.tag_orders);
    setVal('wh_url', state.boot.pathaoWebhook.url);
    setVal('wh_secret', state.boot.pathaoWebhook.secret);
    $('connection-status').textContent = s.connected ? 'Credentials saved' : '';
  }

  async function saveConnection() {
    const body = {
      pathao_env: $('pathao_env').value,
      pathao_client_id: $('pathao_client_id').value,
      pathao_username: $('pathao_username').value,
    };
    const secret = $('pathao_client_secret').value;
    const pass = $('pathao_password').value;
    if (secret) body.pathao_client_secret = secret;
    if (pass) body.pathao_password = pass;
    const storeVal = $('pathao_store_id').value;
    if (storeVal) body.pathao_store_id = storeVal;

    const saved = await api('/settings', { method: 'POST', body });
    state.boot.settings = saved.settings;
    setVal('pathao_client_secret', '');
    setVal('pathao_password', '');

    const test = await api('/pathao/test', { method: 'POST' });
    if (!test.ok) {
      $('connection-status').textContent = '';
      toast(`Pathao rejected the login: ${test.error}`, true);
      renderSettings();
      renderBanners();
      return;
    }
    const sel = $('pathao_store_id');
    sel.innerHTML = '<s-option value="">— choose a store —</s-option>' + test.stores
      .map((st) => `<s-option value="${esc(st.id)}">${esc(st.name)}${st.active ? '' : ' (inactive)'}</s-option>`).join('');
    // Auto-pick if the merchant has exactly one store.
    let storeId = state.boot.settings.pathao_store_id;
    if (!storeId && test.stores.length === 1) storeId = test.stores[0].id;
    if (storeId) {
      setVal('pathao_store_id', storeId);
      const r = await api('/settings', { method: 'POST', body: { pathao_store_id: storeId } });
      state.boot.settings = r.settings;
    }
    $('connection-status').textContent = `Connected ✓ ${test.stores.length} store(s) found`;
    toast('Pathao connected');
    renderBanners();
  }

  async function saveRules() {
    const body = {
      auto_send: $('auto_send').checked,
      delivery_type: $('delivery_type').value,
      item_type: $('item_type').value,
      default_weight: $('default_weight').value,
      skip_tag: $('skip_tag').value,
      only_cod: $('only_cod').checked,
      tag_orders: $('tag_orders').checked,
    };
    const storeVal = $('pathao_store_id').value;
    if (storeVal) body.pathao_store_id = storeVal;
    const r = await api('/settings', { method: 'POST', body });
    state.boot.settings = r.settings;
    renderBanners();
    toast('Rules saved');
  }

  // ---------- orders ----------
  function statusBadge(o) {
    const s = o.shipment;
    if (o.cancelled) return '<s-badge>Cancelled</s-badge>';
    if (!s) return '<s-badge>Not sent</s-badge>';
    if (s.status === 'sent') {
      const ps = s.pathaoStatus ? ` · ${esc(s.pathaoStatus)}` : '';
      return `<s-badge tone="success">Sent</s-badge> <span class="muted">#${esc(s.consignmentId || '')}${ps}</span>`;
    }
    if (s.status === 'processing') return '<s-badge tone="info">Sending…</s-badge>';
    if (s.status === 'skipped') return `<s-badge tone="warning">Skipped</s-badge><span class="err">${esc(s.error)}</span>`;
    return `<s-badge tone="critical">Failed</s-badge><span class="err">${esc(s.error)}</span>`;
  }

  function canSend(o) {
    return !o.cancelled && (!o.shipment || ['failed', 'skipped'].includes(o.shipment.status));
  }

  function renderOrders() {
    const body = $('orders-body');
    if (!state.orders.length) {
      body.innerHTML = '<s-table-row><s-table-cell></s-table-cell><s-table-cell>No orders yet</s-table-cell><s-table-cell></s-table-cell><s-table-cell></s-table-cell><s-table-cell></s-table-cell><s-table-cell></s-table-cell></s-table-row>';
      return;
    }
    body.innerHTML = state.orders.map((o) => {
      const sendable = canSend(o);
      const label = o.shipment && o.shipment.status !== 'sent' ? 'Retry' : 'Send';
      const action = sendable
        ? `<s-button data-send="${esc(o.id)}">${label}</s-button>`
        : o.shipment && o.shipment.status === 'sent' ? `<s-button variant="tertiary" data-refresh="${esc(o.id)}">Update status</s-button>` : '';
      return `<s-table-row>
        <s-table-cell>${sendable ? `<s-checkbox accessibilitylabel="Select ${esc(o.name)}" data-select="${esc(o.id)}" ${state.selected.has(o.id) ? 'checked' : ''}></s-checkbox>` : ''}</s-table-cell>
        <s-table-cell><b>${esc(o.name)}</b><br><span class="muted">${esc(new Date(o.createdAt).toLocaleString())}</span></s-table-cell>
        <s-table-cell>${esc(o.customer)}${o.city ? `<br><span class="muted">${esc(o.city)}</span>` : ''}</s-table-cell>
        <s-table-cell>${esc(money(o.cod, o.currency))}</s-table-cell>
        <s-table-cell>${statusBadge(o)}</s-table-cell>
        <s-table-cell>${action}</s-table-cell>
      </s-table-row>`;
    }).join('');
    updateSendButton();
  }

  function updateSendButton() {
    const btn = $('send-selected');
    btn.disabled = state.selected.size === 0;
    if (btn.disabled) btn.setAttribute('disabled', ''); else btn.removeAttribute('disabled');
    btn.textContent = state.selected.size ? `Send ${state.selected.size} selected to Pathao` : 'Send selected to Pathao';
  }

  function renderUsage() {
    const u = state.boot.usage;
    $('usage-text').textContent = u.limit ? `${u.used} / ${u.limit} orders used this month` : `${u.used} orders sent this month`;
  }

  async function loadOrders() {
    $('orders-table').setAttribute('loading', '');
    try {
      const data = await api('/orders');
      state.orders = data.orders;
      const ids = new Set(state.orders.filter(canSend).map((o) => o.id));
      for (const id of [...state.selected]) if (!ids.has(id)) state.selected.delete(id);
      renderOrders();
    } catch (e) {
      toast(e.message, true);
    } finally {
      $('orders-table').removeAttribute('loading');
    }
  }

  async function sendOrders(ids) {
    const r = await api('/orders/send', { method: 'POST', body: { ids } });
    const ok = r.results.filter((x) => x.ok).length;
    const failed = r.results.filter((x) => !x.ok && !x.duplicate);
    if (ok) toast(`${ok} order(s) sent to Pathao`);
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
      let btn;
      if (current) btn = '<s-badge tone="success">Current plan</s-badge>';
      else if (p.price > 0) btn = `<s-button variant="primary" data-plan="${esc(p.key)}">Upgrade${p.trialDays ? ` – ${p.trialDays}-day free trial` : ''}</s-button>`;
      else btn = '<s-button data-downgrade="1">Switch to Free</s-button>';
      return `<div class="plan-card ${current ? 'current' : ''}">
        <s-heading>${esc(p.name)}</s-heading>
        <div class="price">$${esc(p.price)}<span class="muted"> / month</span></div>
        <ul>${p.features.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
        ${btn}
      </div>`;
    }).join('');
  }

  // ---------- boot ----------
  async function refreshBoot() {
    state.boot = await api('/bootstrap');
    renderBanners();
    renderUsage();
    renderPlans();
  }

  document.addEventListener('click', async (ev) => {
    const t = ev.target.closest('[data-send],[data-refresh],[data-plan],[data-downgrade],#send-selected,#reload-orders,#save-connection,#save-rules');
    if (!t) return;
    try {
      if (t.id === 'save-connection') return await busy(t, saveConnection);
      if (t.id === 'save-rules') return await busy(t, saveRules);
      if (t.id === 'reload-orders') return await busy(t, loadOrders);
      if (t.id === 'send-selected') return await busy(t, () => sendOrders([...state.selected]));
      if (t.dataset.send) return await busy(t, () => sendOrders([t.dataset.send]));
      if (t.dataset.refresh) {
        return await busy(t, async () => { await api(`/orders/${t.dataset.refresh}/refresh`, { method: 'POST' }); await loadOrders(); });
      }
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
    } catch (e) {
      toast(e.message, true);
    }
  });

  document.addEventListener('change', (ev) => {
    const box = ev.target.closest('[data-select]');
    if (!box) return;
    if (box.checked) state.selected.add(box.dataset.select); else state.selected.delete(box.dataset.select);
    updateSendButton();
  });

  async function start() {
    try {
      await refreshBoot();
      renderSettings();
    } catch (e) {
      $('banners').innerHTML = `<s-banner tone="critical" heading="Could not load the app">${esc(e.message)}</s-banner>`;
      return;
    }
    loadOrders();
  }

  start();
})();
