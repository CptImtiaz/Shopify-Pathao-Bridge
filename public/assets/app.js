/* ShipBridge embedded admin UI: Orders / Couriers / Billing / Support. Plain JS + App Bridge. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const state = {
    boot: null, orders: [], loaded: false, selected: new Set(), focus: null,
    page: 'orders', group: null, stage: null, risk: 'any', search: '',
    openStep: null, courierView: 'pathao', billing: null, period: 'monthly', support: null, checks: null, menuFor: null,
  };

  // ---------------- helpers ----------------
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const show = (el, on) => { if (el) el.hidden = !on; };
  const taka = (n) => `৳ ${Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  const usd = (n) => `$${Number(n || 0).toFixed(2)}`;
  const time = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const when = (iso) => {
    const d = new Date(iso), today = new Date();
    return d.toDateString() === today.toDateString() ? time(iso) : `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}, ${time(iso)}`;
  };
  const dateOnly = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
  let toastTimer;
  function toast(msg, bad) {
    if (window.shopify && shopify.toast && window.top !== window.self) { try { shopify.toast.show(msg, { isError: Boolean(bad), duration: 3500 }); return; } catch (e) { /* fall back */ } }
    const t = $('toast'); t.textContent = msg; t.className = `toast${bad ? ' bad' : ''}`; show(t, true);
    clearTimeout(toastTimer); toastTimer = setTimeout(() => show(t, false), 3500);
  }
  async function api(path, opts = {}) {
    const go = async () => {
      const headers = { 'Content-Type': 'application/json' };
      if (window.shopify && shopify.idToken) headers.Authorization = `Bearer ${await shopify.idToken()}`;
      return fetch(`/api${path}`, { method: opts.method || 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
    };
    let res = await go();
    if (res.status === 401) res = await go();
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }
  async function busy(btn, fn) {
    btn.classList.add('loading'); btn.disabled = true;
    try { return await fn(); } finally { btn.classList.remove('loading'); btn.disabled = false; }
  }
  const setVal = (id, v) => { const el = $(id); if (el) el.value = v == null ? '' : String(v); };
  const courier = (key) => (state.boot.couriers || []).find((c) => c.key === key) || { key, name: key, color: '#6B7875' };
  const cmono = (c) => `<span class="cmono" style="background:${esc(c.color)}">${esc(c.name.charAt(0))}</span>`;
  const webhookLive = () => Boolean(state.boot && state.boot.pathaoWebhook && state.boot.pathaoWebhook.live);
  const permMissing = () => Boolean(state.boot && state.boot.permissions && state.boot.permissions.missing && state.boot.permissions.missing.length);
  const S = () => state.boot.settings;
  function apply(r) { if (r.settings) state.boot.settings = r.settings; if (r.couriers) state.boot.couriers = r.couriers; }

  // ---------------- routing ----------------
  const ROUTES = { '/': 'orders', '/app': 'orders', '/settings': 'couriers', '/couriers': 'couriers', '/sms': 'couriers', '/plans': 'billing', '/billing': 'billing', '/support': 'support' };
  const pageFromPath = () => ROUTES[location.pathname.replace(/\/$/, '') || '/'] || 'orders';
  function showPage(page) {
    state.page = page;
    if (location.pathname === '/sms') state.courierView = 'sms';
    $$('.page').forEach((p) => show(p, p.dataset.page === page));
    show($('bulkbar'), page === 'orders' && state.selected.size > 0);
    closeMenu();
    window.scrollTo(0, 0);
    if (!state.boot) return;
    if (page === 'orders' && !state.loaded) loadOrders();
    if (page === 'couriers') renderCouriers();
    if (page === 'billing') loadBilling();
    if (page === 'support') loadSupport();
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

  // ---------------- order model ----------------
  const ps = (o) => String((o.shipment && o.shipment.pathaoStatus) || '').toLowerCase();
  const held = (o) => Boolean(o.shipment && o.shipment.status === 'skipped' && /^Held/.test(o.shipment.error || ''));
  // pipeline stage + progress steps (0-5)
  function stageOf(o) {
    const s = o.shipment;
    if (!s) return o.cancelled ? { key: 'cancelled', step: 0 } : { key: 'new', step: 0 };
    if (s.status === 'failed' || s.status === 'skipped') return { key: held(o) ? 'new' : 'problems', step: 0, bad: !held(o) };
    if (s.status === 'processing') return { key: 'booked', step: 1 };
    const p = ps(o);
    if (/partial/.test(p) || (/deliver/.test(p) && !/fail/.test(p) && !/assigned/.test(p))) return { key: 'delivered', step: 5 };
    if (/return|cancel/.test(p)) return { key: 'problems', step: 2, bad: true };
    if (/fail/.test(p)) return { key: 'problems', step: 4, bad: true };
    if (/assigned.?for.?delivery|out.?for/.test(p)) return { key: 'onway', step: 4 };
    if (/transit|hub|sorting|hold/.test(p)) return { key: 'onway', step: 3 };
    if (/picked/.test(p) && !/pickup/.test(p)) return { key: 'picked', step: 2 };
    return { key: 'booked', step: 1 };
  }
  function stageLabel(o) {
    const s = o.shipment;
    if (!s) return o.cancelled ? 'Cancelled in Shopify' : 'Not sent';
    if (held(o)) return 'Held for review';
    if (s.status === 'failed') return 'Pathao refused';
    if (s.status === 'skipped') return 'Not sent';
    if (s.status === 'processing') return 'Sending…';
    const p = ps(o).replace(/^order\./, '');
    const map = [[/partial/, 'Partially delivered'], [/paid.?return/, 'Paid return'], [/deliver.*fail|fail/, 'Delivery failed'], [/assigned.?for.?delivery|out.?for/, 'Out for delivery'],
      [/deliver/, 'Delivered'], [/return/, 'Returned'], [/pickup.?cancel|cancel/, 'Cancelled'], [/assigned.?for.?pickup/, 'Rider assigned'], [/picked/, 'Picked up'],
      [/sorting/, 'At sorting hub'], [/hub/, 'At delivery hub'], [/transit/, 'In transit'], [/hold/, 'On hold']];
    const hit = map.find(([re]) => re.test(p));
    return hit ? hit[1] : 'Booked · waiting for rider';
  }
  const canSend = (o) => !o.cancelled && (!o.shipment || ['failed', 'skipped'].includes(o.shipment.status));
  function groupOf(o) {
    const st = stageOf(o).key;
    if (canSend(o)) return 'action';
    if (['booked', 'picked', 'onway'].includes(st)) return 'way';
    return 'done';
  }
  const riskKey = (o) => (o.fraud ? ({ high: 'high', medium: 'check', low: 'new', pending: 'new', safe: 'safe' }[o.fraud.level] || 'new') : 'new');
  const riskText = (o) => (o.fraud ? ({ high: 'High', medium: 'Check', low: 'New', pending: 'Checking', safe: 'Safe' }[o.fraud.level] || '—') : '—');
  function riskWhy(o) {
    const f = o.fraud; if (!f) return '';
    const h = f.history || {};
    if (f.level === 'safe' && h.delivered) return `${h.delivered} delivered`;
    const bad = f.reasons.find((r) => r.level === f.level) || f.reasons[0];
    if (!bad) return '';
    const t = bad.text;
    if (/not a valid|No phone/.test(t)) return 'Invalid phone';
    if (/Shopify flags|Shopify suggests/.test(t)) return 'Shopify flagged';
    if (/returned or cancelled (\d+) of/.test(t)) return `${h.successRate}% success`;
    if (/returned or cancelled/.test(t)) return `${h.returned + h.cancelled} past return`;
    if (/same phone/.test(t)) return 'Repeat order today';
    if (/High cash/.test(t)) return 'Large COD';
    if (/address/.test(t)) return 'Short address';
    if (/New customer/.test(t)) return 'First order';
    return '';
  }
  function actionFor(o) {
    if (o.cancelled && !o.shipment) return null;
    if (o.shipment && o.shipment.status === 'sent') return { label: 'Track', cls: 'btn sm', act: 'open' };
    if (o.shipment && o.shipment.status === 'processing') return null;
    const badPhone = o.fraud && o.fraud.reasons.some((r) => /not a valid|No phone/.test(r.text));
    if (badPhone) return { label: 'Fix phone', cls: 'btn sm warn', act: 'shopify' };
    if (held(o) || (o.fraud && o.fraud.level === 'high')) return { label: 'Review', cls: 'btn sm warn', act: 'open' };
    if (o.shipment && o.shipment.status === 'failed') return { label: 'Retry', cls: 'btn sm', act: 'send' };
    return { label: 'Send to Pathao', cls: 'btn sm primary', act: 'send' };
  }
  const shopifyOrderUrl = (o) => `https://admin.shopify.com/store/${state.boot.shop.replace('.myshopify.com', '')}/orders/${o.id}`;
  const trackUrl = (o) => `https://merchant.pathao.com/tracking?consignment_id=${encodeURIComponent(o.shipment.consignmentId)}${o.phoneNormalized ? `&phone=${encodeURIComponent(o.phoneNormalized)}` : ''}`;

  // ---------------- banners ----------------
  function renderBanners() {
    const b = state.boot, out = [];
    if (b.webhooks && b.webhooks.ok === false) out.push(`<div class="banner bad"><b>New orders can't reach ShipBridge.</b> Shopify refused to set up order notifications: ${esc(b.webhooks.error)}</div>`);
    if (S().pathao_env === 'sandbox') out.push('<div class="banner warn">Pathao is in <b>test mode</b>: bookings go to the sandbox, not real riders.</div>');
    if (b.usage.limit && b.usage.used >= b.usage.limit) out.push(`<div class="banner bad">You've used all ${b.usage.limit} orders on your plan this month. <a href="/billing" data-link><b>Upgrade to keep sending</b></a></div>`);
    $('banners').innerHTML = out.join('');
  }

  // ---------------- orders page ----------------
  function setupSteps() {
    const s = S();
    return [
      { key: 'account', done: Boolean(s.connected) },
      { key: 'store', done: Boolean(s.pathao_store_id) },
      { key: 'webhook', done: webhookLive() },
      { key: 'shopify', done: s.sync_fulfillment === false || !permMissing() },
    ];
  }
  function renderHeader() {
    const u = state.boot.usage;
    $('usage-line').textContent = `${new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })} · ${u.limit ? `${u.used} of ${u.limit} orders used this month` : `${u.used} orders this month · unlimited`}`;
    show($('live-pill'), webhookLive());
    const steps = setupSteps(), done = steps.filter((x) => x.done).length;
    show($('setup-strip'), done < steps.length);
    $('setup-sub').textContent = `${done} of ${steps.length} steps done · ${['Connect your Pathao account', 'Choose your pickup store', 'Turn on live delivery updates', 'Allow Shopify order updates'][steps.findIndex((x) => !x.done)] || ''}`;
    const pct = Math.round((done / steps.length) * 100);
    $('setup-ring').style.background = `conic-gradient(#D18A00 0 ${pct}%, #F5E6C2 ${pct}% 100%)`;
    $('setup-ring').innerHTML = `<span style="width:30px;height:30px;border-radius:50%;background:#FFF9EA;display:grid;place-items:center">${done}/${steps.length}</span>`;
    const ready = newReady();
    show($('send-new'), ready.length > 0 && S().connected && S().pathao_store_id);
    $('send-new-label').textContent = `Send ${ready.length} new order${ready.length === 1 ? '' : 's'} to Pathao`;
  }
  const newReady = () => state.orders.filter((o) => !o.shipment && !o.cancelled && !(o.fraud && o.fraud.level === 'high'));

  const STAGES = [
    ['new', 'New', 't-new', 'Not sent yet'], ['booked', 'Booked', 't-go', 'Waiting for rider'], ['picked', 'Picked up', 't-go', 'With Pathao'],
    ['onway', 'On the way', 't-go', 'Transit & out for delivery'], ['delivered', 'Delivered', 't-done', 'Recent orders'], ['problems', 'Problems', 't-bad', 'Returned, failed, refused'],
  ];
  function renderPipeline() {
    const c = {}; state.orders.forEach((o) => { const k = stageOf(o).key; c[k] = (c[k] || 0) + 1; });
    $('pipeline').innerHTML = STAGES.map(([k, label, tone, hint], i) => `<button class="stage ${tone}${state.stage === k ? ' active' : ''}" data-stage="${k}" aria-pressed="${state.stage === k}">
      <span class="s-label"><span>${label}</span><span aria-hidden="true">${i < 4 ? '→' : ''}</span></span><span class="s-num">${c[k] || 0}</span><span class="s-hint">${hint}</span></button>`).join('');
  }
  const GROUPS = [['action', 'Needs action'], ['way', 'On the way'], ['done', 'Done'], ['all', 'All']];
  function renderGroups() {
    const c = { all: state.orders.length }; state.orders.forEach((o) => { const g = groupOf(o); c[g] = (c[g] || 0) + 1; });
    if (!state.group) state.group = c.action ? 'action' : 'all';
    $('groups').innerHTML = GROUPS.map(([k, l]) => `<button role="tab" aria-selected="${!state.stage && state.group === k}" data-group="${k}">${l}<span class="n">${c[k] || 0}</span></button>`).join('');
    const rc = { high: 0, check: 0 }; state.orders.forEach((o) => { const r = riskKey(o); if (rc[r] != null) rc[r] += 1; });
    $('risk-chips').innerHTML = `<span class="lbl">Risk</span><button class="chip${state.risk === 'any' ? ' active' : ''}" data-risk="any">Any</button>`
      + (rc.high ? `<button class="chip c-high${state.risk === 'high' ? ' active' : ''}" data-risk="high">High · ${rc.high}</button>` : '')
      + (rc.check ? `<button class="chip c-check${state.risk === 'check' ? ' active' : ''}" data-risk="check">Check · ${rc.check}</button>` : '');
  }
  function visible() {
    const q = state.search.trim().toLowerCase();
    return state.orders.filter((o) => (state.stage ? stageOf(o).key === state.stage : (state.group === 'all' || groupOf(o) === state.group))
      && (state.risk === 'any' || riskKey(o) === state.risk)
      && (!q || `${o.name} ${o.customer} ${o.phone} ${o.city} ${o.shipment ? o.shipment.consignmentId : ''}`.toLowerCase().includes(q)));
  }
  function thumbs(o) {
    const ps2 = (o.products || []).slice(0, 2);
    if (!ps2.length) return '<span class="thumb">–</span>';
    return ps2.map((p) => (p.image ? `<img class="thumb" src="${esc(p.image)}" alt="" loading="lazy" />` : `<span class="thumb">${esc((p.title || '?').charAt(0).toUpperCase())}</span>`)).join('');
  }
  function rowHtml(o) {
    const st = stageOf(o), a = actionFor(o), sel = state.selected.has(o.id);
    const first = (o.products && o.products[0]) || null;
    const more = (o.products || []).length > 1 ? `+${o.products.length - 1} more · ` : '';
    const paid = String(o.financial || '').toUpperCase() === 'PAID';
    const live = o.shipment && o.shipment.status === 'sent' && webhookLive();
    return `<div class="row${sel ? ' sel' : ''}${state.focus === o.id ? ' focus' : ''}" data-open="${esc(o.id)}">
      <span>${canSend(o) ? `<input type="checkbox" data-select="${esc(o.id)}" ${sel ? 'checked' : ''} aria-label="Select ${esc(o.name)}" />` : ''}</span>
      <div style="min-width:0"><div class="o-top"><b>${esc(o.name)}</b><span class="sub">${esc(when(o.createdAt))}</span></div>
        <div class="ellip">${esc(o.customer || '—')}${o.city ? ` · ${esc(o.city)}` : ''}</div><div class="sub">${esc(o.phone || '')}</div></div>
      <div class="prod"><span class="thumbs">${thumbs(o)}</span><div style="min-width:0"><div class="ellip">${esc(first ? `${first.title}${first.quantity > 1 ? ` × ${first.quantity}` : ''}` : (o.items || '—'))}</div><div class="sub">${more}${o.itemCount} item${o.itemCount === 1 ? '' : 's'}</div></div></div>
      <div><div class="amount">${esc(taka(paid ? o.total : o.cod))}</div><span class="pill ${paid ? 'p-paid' : 'p-cod'}">${paid ? 'Paid' : 'COD'}</span></div>
      <div><span class="track${st.bad ? ' bad' : ''}">${[1, 2, 3, 4, 5].map((i) => `<i class="${i <= st.step || (st.bad && i <= Math.max(st.step, 1)) ? 'on' : ''}"></i>`).join('')}</span>
        <div class="stage-txt ${st.bad ? 'bad' : st.step ? 'ok' : 'idle'}">${esc(stageLabel(o))}${live ? ' <span class="live" title="Updates instantly from Pathao"><i></i></span>' : ''}</div></div>
      <div><span class="pill p-${riskKey(o)}">${esc(riskText(o))}</span><div class="why">${esc(riskWhy(o))}</div></div>
      <div class="r">${a ? `<button class="${a.cls}" data-act="${a.act}" data-id="${esc(o.id)}">${esc(a.label)}</button>` : ''}</div>
    </div>`;
  }
  function renderRows() {
    const rows = visible();
    show($('orders-loading'), false);
    show($('orders-empty'), !rows.length);
    if (!rows.length) {
      $('rows').innerHTML = '';
      $('orders-empty').innerHTML = state.orders.length ? '<b>Nothing here</b>Try another filter or search.' : '<b>No orders yet</b>New orders from your store appear here.';
    } else if (state.group === 'all' && !state.stage) {
      const order = [['action', 'Needs action', '#D18A00', '· send, check or fix'], ['way', 'On the way', '#0B6B58', webhookLive() ? '· updates arrive live' : ''], ['done', 'Done', '#9AA5A2', '']];
      $('rows').innerHTML = order.map(([g, t, c, sub]) => {
        const list = rows.filter((o) => groupOf(o) === g);
        return list.length ? `<div class="group-title"><i style="background:${c}"></i>${t}<span>${sub}</span></div>${list.map(rowHtml).join('')}` : '';
      }).join('');
    } else {
      $('rows').innerHTML = rows.map(rowHtml).join('');
    }
    const sendable = rows.filter(canSend);
    $('check-all').checked = sendable.length > 0 && sendable.every((o) => state.selected.has(o.id));
    $('check-all').disabled = !sendable.length;
    renderBulk();
  }
  function renderBulk() {
    show($('bulkbar'), state.page === 'orders' && state.selected.size > 0);
    $('bulk-count').textContent = `${state.selected.size} selected`;
    $('bulk-default').textContent = `Send to ${courier(S().default_courier || 'pathao').name}`;
  }

  function renderDetail() {
    const o = state.orders.find((x) => x.id === state.focus) || null;
    const el = $('detail');
    show(el, Boolean(o));
    if (!o) return;
    const f = o.fraud || { level: 'pending', score: 0, reasons: [], history: {} }, h = f.history || {};
    const st = stageOf(o), a = actionFor(o);
    const colors = { high: ['#C2410C', '#F8D5C4', '#FFF4EE', '#9A3412'], medium: ['#D18A00', '#F5E6C2', '#FFF9EA', '#7A5200'], low: ['#2F6DB5', '#D5E2F4', '#EEF3FB', '#1E4E8C'], pending: ['#7E8B88', '#E4E9E7', '#EEF3FB', '#3E4B48'], safe: ['#0B6B58', '#CDEBDF', '#E3F4EE', '#0B5E4D'] }[f.level];
    const title = { high: 'High risk — review first', medium: 'Check before sending', low: 'Looks fine', pending: 'Shopify is still checking', safe: 'Trusted customer' }[f.level];
    const steps = ['Booked with Pathao', 'Picked up by rider', 'In transit', 'Out for delivery', 'Delivered'];
    const sent = o.shipment && o.shipment.status === 'sent';
    const tl = steps.map((label, i) => {
      const n = i + 1;
      let cls = '';
      if (sent && n < st.step) cls = 'done';
      if (sent && n === st.step) cls = st.bad ? 'bad' : (n === 5 ? 'done' : 'now');
      const lbl = sent && n === st.step && st.bad ? stageLabel(o) : label;
      const t = sent && n === st.step && o.shipment.updatedAt ? time(o.shipment.updatedAt) : '';
      return `<li class="${cls}"><span class="dot"></span><span class="lbl">${esc(lbl)}</span><span class="sub">${esc(t)}</span></li>`;
    }).join('');
    const paid = String(o.financial || '').toUpperCase() === 'PAID';
    el.innerHTML = `
      <div class="d-head"><div><div class="sub">${esc(o.name)} · ${esc(when(o.createdAt))}</div><div class="name">${esc(o.customer || 'Customer')}</div><div class="meta">${esc(o.address || o.city || '')}</div></div>
        <button class="btn icon" data-close aria-label="Close order detail"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
      <div class="d-actions">
        ${o.phone ? `<a class="btn d-call" href="tel:${esc(o.phoneNormalized || o.phone)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/></svg>Call customer</a>` : ''}
        ${sent && o.shipment.consignmentId ? `<a class="btn" href="${esc(trackUrl(o))}" target="_blank" rel="noopener">Track parcel</a>` : `<a class="btn" href="${esc(shopifyOrderUrl(o))}" target="_top">Open in Shopify</a>`}
      </div>
      ${o.shipment && o.shipment.status !== 'sent' && o.shipment.error ? `<div class="d-note">${esc(o.shipment.error)}</div>` : ''}
      <div class="d-risk l-${esc(f.level)}">
        <div class="ring" style="background:conic-gradient(${colors[0]} 0 ${Number(f.score) || 0}%, ${colors[1]} ${Number(f.score) || 0}% 100%)"><b style="background:${colors[2]};color:${colors[3]}">${Number(f.score) || 0}</b></div>
        <div><div class="t">${esc(title)}</div><ul>${f.reasons.slice(0, 3).map((r) => `<li>${esc(r.text)}</li>`).join('')}</ul>
          <div class="sub" style="margin-top:4px">${h.total ? `${h.delivered} delivered · ${h.returned} returned · ${h.cancelled} cancelled` : 'No parcels with your store yet'}</div></div>
      </div>
      <div class="d-sec"><div class="d-label">Delivery${sent && o.shipment.consignmentId ? ` · <span class="mono">${esc(o.shipment.consignmentId)}</span>` : ''}</div>
        <ul class="tl">${tl}</ul>
        ${sent && o.shipment.shopifySynced ? '<div class="synced"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>Shopify order updated automatically</div>' : ''}
        ${sent && !webhookLive() ? `<button class="btn sm" data-track="${esc(o.id)}">Refresh status</button>` : ''}
      </div>
      <div class="d-money">
        <div class="d-items">${(o.products || []).map((p) => `<div class="it">${p.image ? `<img class="thumb" src="${esc(p.image)}" alt="" />` : `<span class="thumb">${esc((p.title || '?').charAt(0))}</span>`}<span class="ellip" style="flex:1">${esc(p.title)}</span><span class="sub">× ${p.quantity}</span></div>`).join('')}</div>
        <div><span class="meta">Order total</span><b>${esc(taka(o.total))}</b></div>
        ${o.shipment && o.shipment.deliveryFee != null ? `<div><span class="meta">Pathao delivery fee</span><span>${esc(taka(o.shipment.deliveryFee))}</span></div>` : ''}
        <div class="tot"><span>${paid ? 'Paid online' : 'Rider collects (COD)'}</span><span>${esc(taka(paid ? 0 : o.cod))}</span></div>
        ${a && a.act === 'send' ? `<button class="btn primary" data-act="send" data-id="${esc(o.id)}" style="height:46px">${esc(a.label)}</button>` : ''}
        ${a && a.label === 'Review' ? `<button class="btn primary" data-act="send" data-id="${esc(o.id)}" style="height:46px">Send anyway</button>` : ''}
        ${a && a.act === 'shopify' ? `<a class="btn warn" href="${esc(shopifyOrderUrl(o))}" target="_top" style="height:46px">Fix phone in Shopify</a>` : ''}
      </div>`;
  }
  function renderOrders() { renderHeader(); renderPipeline(); renderGroups(); renderRows(); renderDetail(); }

  async function loadOrders() {
    show($('orders-loading'), !state.orders.length);
    try {
      state.orders = (await api('/orders')).orders;
      state.loaded = true;
      const ok = new Set(state.orders.filter(canSend).map((o) => o.id));
      [...state.selected].forEach((id) => { if (!ok.has(id)) state.selected.delete(id); });
      if (!state.focus && window.innerWidth > 1100) {
        const first = state.orders.find((o) => groupOf(o) === 'action') || state.orders[0];
        state.focus = first ? first.id : null;
      }
      renderOrders();
    } catch (e) { show($('orders-loading'), false); toast(e.message, true); }
  }
  async function sendOrders(ids, key) {
    if (!ids.length) return;
    const c = courier(key);
    const r = await api('/orders/send', { method: 'POST', body: { ids, courier: key } });
    const ok = r.results.filter((x) => x.ok).length;
    const failed = r.results.filter((x) => !x.ok && !x.duplicate);
    if (ok) toast(`${ok} order${ok > 1 ? 's' : ''} sent to ${c.name}`);
    if (failed.length) toast(`${failed.length} not sent: ${failed[0].error}`, true);
    ids.forEach((id) => state.selected.delete(id));
    await refreshBoot(); await loadOrders();
  }
  function openMenu(anchor, ids) {
    const m = $('courier-menu');
    state.menuFor = ids;
    m.innerHTML = '<div class="menu-title">Send with</div>' + (state.boot.couriers || []).map((c) => {
      const ok = c.available && c.status === 'connected';
      const tag = !c.available ? 'Soon' : c.status !== 'connected' ? 'Set up' : (c.isDefault ? 'Default' : '');
      return `<button data-pick="${esc(c.key)}" ${ok ? '' : 'disabled'}>${cmono(c)}${esc(c.name)}${tag ? `<span class="tag">${tag}</span>` : ''}</button>`;
    }).join('');
    show(m, true);
    const r = anchor.getBoundingClientRect();
    const top = r.top + window.scrollY - m.offsetHeight - 8;
    m.style.top = `${top > window.scrollY ? top : r.bottom + window.scrollY + 8}px`;
    m.style.left = `${Math.max(8, Math.min(r.left + window.scrollX, window.innerWidth - m.offsetWidth - 8))}px`;
  }
  function closeMenu() { show($('courier-menu'), false); state.menuFor = null; }

  // ---------------- couriers page ----------------
  function renderCouriers() {
    const s = S();
    const others = (state.boot.couriers || []).filter((c) => c.key !== 'pathao');
    const p = courier('pathao');
    const ready = s.connected && s.pathao_store_id;
    $('courier-nav').innerHTML = `<button class="cn-item${state.courierView === 'pathao' ? ' active' : ''}" data-cview="pathao">${cmono(p)}<span style="flex:1"><b>Pathao</b><small class="${ready ? 'ok' : ''}">${ready ? 'Connected · Default' : s.connected ? 'Choose a pickup store' : 'Not connected'}</small></span></button>
      <button class="cn-item${state.courierView === 'sms' ? ' active' : ''}" data-cview="sms"><span class="cmono" style="background:#3E4B48">✉</span><span style="flex:1"><b>SMS to customers</b><small>Coming soon</small></span></button>
      <div class="cn-label">More couriers · coming soon</div>
      ${others.map((c) => `<button class="cn-item" disabled>${cmono(c)}<span style="flex:1"><b>${esc(c.name)}</b></span></button>`).join('')}`;
    show($('pathao-setup'), state.courierView === 'pathao');
    show($('sms-tab'), state.courierView === 'sms');

    const steps = setupSteps();
    const done = steps.filter((x) => x.done).length;
    $('steps-count').textContent = `${done} of ${steps.length} done`;
    $('steps-track').innerHTML = steps.map((x) => `<i class="${x.done ? 'on' : ''}"></i>`).join('');
    const firstOpen = (steps.find((x) => !x.done) || {}).key || null;
    const open = state.openStep === undefined ? firstOpen : (state.openStep || firstOpen);
    steps.forEach((x, i) => {
      const el = document.querySelector(`.step[data-step="${x.key}"]`);
      el.classList.toggle('done', x.done);
      el.classList.toggle('open', open === x.key);
      el.classList.toggle('attention', !x.done && open !== x.key && x.key === firstOpen);
      el.querySelector('.step-dot').textContent = x.done ? '' : String(i + 1);
      const tb = el.querySelector('[data-toggle-step]');
      if (tb) tb.textContent = open === x.key ? 'Close' : (x.done ? (x.key === 'webhook' ? 'Show' : x.key === 'store' ? 'Change' : 'Edit') : 'Set up');
    });
    document.querySelector('[data-step="account"] [data-summary]').textContent = s.connected ? `${s.pathao_username} · ${s.pathao_env === 'sandbox' ? 'Test (sandbox)' : 'Live'}` : 'Client ID, secret, merchant email and password';
    document.querySelector('[data-step="store"] [data-summary]').textContent = s.pathao_store_id ? `${s.pathao_store_name || 'Store #' + s.pathao_store_id} · riders collect parcels here` : 'Where riders pick up your parcels';
    $$('#env-seg button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.env === (state.envDraft || s.pathao_env))));
    show($('wh-live'), webhookLive());
    const wh = state.boot.pathaoWebhook || {};
    $('wh-state').innerHTML = wh.live ? '<span class="ok-line"><span class="live"><i></i></span>Connected — statuses update the moment Pathao reports them.</span>'
      : wh.secret ? 'Waiting for the first update from Pathao. Paste the URL and secret key in your Pathao panel.' : '';

    // step 4
    const miss = (state.boot.permissions && state.boot.permissions.missing) || [];
    const sync = s.sync_fulfillment !== false;
    show($('perm-btn'), sync && permMissing());
    $('perm-body').innerHTML = !sync ? '<p class="hint">Turned off in “Update orders in Shopify”.</p>'
      : permMissing() ? `<div class="perm-box"><b>Shopify needs your OK once.</b> Bookings keep working meanwhile.
          <ol><li>Dev Dashboard → ShipBridge → <b>Versions</b> → <b>Create version</b>, add <code>${miss.map(esc).join('</code> <code>')}</code> (and the matching <code>read_</code> scopes), then <b>Release</b>.</li>
          <li>Reopen ShipBridge and click <b>Update</b> when Shopify asks, then press <b>Check access</b>.</li></ol></div>`
      : '<span class="ok-line"><span class="live"><i></i></span>Allowed — orders are fulfilled and updated in Shopify automatically.</span>';

    // prefs
    $('auto_send').checked = Boolean(s.auto_send); $('auto_send').disabled = !ready;
    $('hold_risky').checked = s.hold_risky !== false;
    $('sync_fulfillment').checked = sync;
    $('notify_customer').checked = Boolean(s.notify_customer); $('notify_customer').disabled = !sync;
    $$('#speed-seg button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.speed === String(s.delivery_type))));
    $$('#when-seg button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.when === (s.fulfill_when || 'booked'))));
    if (document.activeElement !== $('default_weight')) setVal('default_weight', s.default_weight);
    if (document.activeElement !== $('default_note')) setVal('default_note', s.default_note);
  }
  function fillAccount() {
    const s = S();
    setVal('pathao_client_id', s.pathao_client_id); setVal('pathao_username', s.pathao_username);
    setVal('pathao_client_secret', ''); setVal('pathao_password', '');
    $('pathao_client_secret').placeholder = s.has_client_secret ? '•••••••• saved' : '';
    $('pathao_password').placeholder = s.has_password ? '•••••••• saved' : '';
    setVal('wh_url', state.boot.pathaoWebhook.url); setVal('wh_secret', state.boot.pathaoWebhook.secret);
    const sel = $('pathao_store_id');
    if (s.pathao_store_id && !sel.querySelector(`option[value="${s.pathao_store_id}"]`)) {
      sel.innerHTML = `<option value="${esc(s.pathao_store_id)}">${esc(s.pathao_store_name || 'Store #' + s.pathao_store_id)}</option>`;
    }
    sel.value = s.pathao_store_id ? String(s.pathao_store_id) : '';
  }
  async function loadStores(keep) {
    const test = await api('/pathao/test', { method: 'POST' });
    if (!test.ok) throw new Error(`Pathao rejected the login: ${test.error}`);
    const sel = $('pathao_store_id');
    sel.innerHTML = '<option value="">Choose a store</option>' + test.stores.map((st) => `<option value="${esc(st.id)}">${esc(st.name)}${st.active ? '' : ' (inactive)'}</option>`).join('');
    const pick = test.stores.find((st) => String(st.id) === String(keep)) || (test.stores.length === 1 ? test.stores[0] : null);
    if (pick) { sel.value = String(pick.id); if (String(pick.id) !== String(S().pathao_store_id)) apply(await api('/settings', { method: 'POST', body: { pathao_store_id: pick.id, pathao_store_name: pick.name } })); }
    return test;
  }
  async function saveConnection() {
    const body = { pathao_env: state.envDraft || S().pathao_env, pathao_client_id: $('pathao_client_id').value.trim(), pathao_username: $('pathao_username').value.trim() };
    if ($('pathao_client_secret').value) body.pathao_client_secret = $('pathao_client_secret').value;
    if ($('pathao_password').value) body.pathao_password = $('pathao_password').value;
    if (!body.pathao_client_id || !body.pathao_username) throw new Error('Enter your Pathao Client ID and merchant email');
    apply(await api('/settings', { method: 'POST', body }));
    const test = await loadStores(S().pathao_store_id);
    toast(S().pathao_store_id ? 'Pathao connected' : `Connected — now choose your pickup store (${test.stores.length} found)`);
    state.openStep = S().pathao_store_id ? undefined : 'store';
    state.envDraft = null;
    fillAccount(); renderAll();
  }
  let saveTimer;
  async function savePrefs(body, quiet) {
    $('prefs-state').textContent = 'Saving…';
    try {
      apply(await api('/settings', { method: 'POST', body }));
      $('prefs-state').textContent = 'Saved';
      if (!quiet) toast('Saved');
      renderAll();
    } catch (e) { $('prefs-state').textContent = 'Not saved'; toast(e.message, true); renderCouriers(); }
  }
  async function requestPermissions() {
    const missing = state.boot.permissions.missing;
    if (window.shopify && shopify.scopes && shopify.scopes.request) { try { await shopify.scopes.request(missing); } catch (e) { /* not offered yet */ } }
    await refreshBoot();
    toast(permMissing() ? 'Not allowed yet — release the new app version first' : 'Shopify access allowed');
  }

  // ---------------- billing page ----------------
  async function loadBilling() {
    try { state.billing = await api('/billing'); if (state.billing.interval) state.period = state.billing.interval; renderBilling(); }
    catch (e) { toast(e.message, true); }
  }
  function renderBilling() {
    const b = state.billing; if (!b) return;
    const cur = b.plans.find((p) => p.key === b.plan) || b.plans[0];
    $('shopify-billing').href = b.shopifyBillingUrl;
    const sub = b.subscription;
    $('bill-current').innerHTML = `<span class="sub">Your plan</span>
      <div class="bc-name"><b>${esc(cur.name)}</b>${b.interval ? `<span class="pill p-wait">${b.interval === 'yearly' ? 'Yearly' : 'Monthly'}</span>` : ''}${sub && sub.test ? '<span class="pill p-check">Test charge</span>' : ''}</div>
      <div class="meta">${cur.price ? `${usd(b.interval === 'yearly' ? cur.yearlyPrice : cur.price)} / ${b.interval === 'yearly' ? 'year' : 'month'} · ${sub && sub.currentPeriodEnd ? `renews ${esc(dateOnly(sub.currentPeriodEnd))}` : 'active'}` : 'Free forever · no card needed'}</div>
      <div class="meta">${esc(cur.tagline || '')}</div>
      ${cur.price ? '<div><button class="btn sm" data-downgrade style="margin-top:6px">Switch to Free</button></div>' : ''}`;
    const u = b.usage, pct = u.limit ? Math.min(100, Math.round((u.used / u.limit) * 100)) : 100;
    $('bill-usage').innerHTML = `<span class="sub">This month</span>
      <div class="big">${u.used}<small>${u.limit ? ` / ${u.limit} orders` : ' orders · unlimited'}</small></div>
      <div class="bar"><i class="${pct >= 80 && u.limit ? 'hot' : ''}" style="width:${pct}%"></i></div>
      <div class="meta">${u.limit ? (u.used >= u.limit ? 'Limit reached — new orders wait until you upgrade or the month resets.' : `${u.limit - u.used} orders left. Resets on the 1st.`) : 'No monthly limit on your plan.'}</div>`;
    $$('#period-seg button').forEach((x) => x.setAttribute('aria-checked', String(x.dataset.period === state.period)));
    const yearly = state.period === 'yearly';
    $('plans').innerHTML = b.plans.map((p) => {
      const isCur = p.key === b.plan && (!p.price || (b.interval || 'monthly') === state.period);
      const price = p.price ? (yearly ? p.yearlyPrice : p.price) : 0;
      let cta;
      if (isCur) cta = '<button class="btn" disabled>Current plan</button>';
      else if (!p.price) cta = b.plan === 'free' ? '<button class="btn" disabled>Current plan</button>' : '<button class="btn" data-downgrade>Switch to Free</button>';
      else cta = `<button class="btn ${p.featured ? 'primary' : ''}" data-plan="${esc(p.key)}">${b.plan === 'free' && p.trialDays ? `Start ${p.trialDays}-day free trial` : `Switch to ${esc(p.name)}`}</button>`;
      return `<div class="card plan${p.featured ? ' featured' : ''}${isCur ? ' current' : ''}">
        ${isCur ? '<span class="p-tag cur">Your plan</span>' : p.featured ? '<span class="p-tag">Most popular</span>' : ''}
        <div class="p-name">${esc(p.name)}</div><div class="meta">${esc(p.tagline || '')}</div>
        <div class="p-price">${price ? usd(price) : '$0'}<small> / ${yearly && p.price ? 'year' : 'month'}</small></div>
        ${yearly && p.price ? `<div class="sub">${usd(price / 12)} a month, billed yearly</div>` : ''}
        <ul>${p.features.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
        <div class="cta">${cta}</div></div>`;
    }).join('');
    const h = b.history || [];
    $('history').innerHTML = h.length ? `<div class="wrap"><table><thead><tr><th>Plan</th><th>Price</th><th>Status</th><th>Started</th><th>Renews / ended</th></tr></thead><tbody>
      ${h.map((x) => `<tr><td><b>${esc(x.name.replace(/^ShipBridge /, ''))}</b>${x.test ? ' <span class="pill p-check">Test</span>' : ''}</td><td>${x.price != null ? `${usd(x.price)} / ${x.interval === 'yearly' ? 'year' : 'month'}` : '—'}</td>
        <td><span class="pill ${x.status === 'ACTIVE' ? 'p-safe' : 'p-wait'}">${esc(x.status.charAt(0) + x.status.slice(1).toLowerCase())}</span></td><td>${esc(dateOnly(x.createdAt))}</td><td>${esc(dateOnly(x.currentPeriodEnd))}</td></tr>`).join('')}
      </tbody></table></div><p class="hint" style="margin-top:10px">Invoices and receipts are on your Shopify bill.</p>`
      : `<p class="meta">No paid plans yet. Charges appear on your <a href="${esc(b.shopifyBillingUrl)}" target="_top">Shopify bill</a>.</p>`;
  }

  // ---------------- support page ----------------
  async function loadSupport() {
    renderChecks();
    try {
      state.support = await api('/support');
      const c = state.support.contact || {};
      $('contact-line').innerHTML = `We reply by email, usually within one working day${c.email ? ` Or write to <a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : ''}${c.whatsapp ? ` · WhatsApp <a href="https://wa.me/${esc(String(c.whatsapp).replace(/\D/g, ''))}" target="_blank" rel="noopener">${esc(c.whatsapp)}</a>` : ''}.`;
      renderTickets();
    } catch (e) { toast(e.message, true); }
    if (!state.checks) runChecks();
  }
  function renderTickets() {
    const t = (state.support && state.support.tickets) || [];
    $('tickets').innerHTML = t.length ? `<div class="d-label" style="margin-top:8px">Your messages</div>${t.map((x) => `<div class="tk"><b>${esc({ setup: 'Setup & connection', orders: 'Sending orders', delivery: 'Delivery status', billing: 'Billing', other: 'Something else' }[x.topic] || x.topic)}</b>${x.orderName ? ` · ${esc(x.orderName)}` : ''}
      <span class="sub">${esc(dateOnly(x.createdAt))} · ${x.status === 'open' ? 'Waiting for reply' : esc(x.status)}</span><div class="ellip">${esc(x.message)}</div></div>`).join('')}` : '';
  }
  const ICON = { ok: '<path d="M5 12.5l4.5 4.5L19 7.5"/>', warn: '<path d="M12 7v6M12 17h.01"/>', bad: '<path d="M7 7l10 10M17 7L7 17"/>', wait: '<path d="M12 7v5l3 2"/>' };
  function renderChecks() {
    const s = S(), c = state.checks || {};
    const items = [
      ['ok', 'Connected to Shopify', `${esc(state.boot.shop)}`],
      s.connected ? (c.pathao ? [c.pathao.ok ? 'ok' : 'bad', 'Pathao login', c.pathao.ok ? `${c.pathao.stores} store${c.pathao.stores === 1 ? '' : 's'} found` : `${esc(c.pathao.error)} · <a href="/couriers" data-link>Fix in Couriers</a>`] : ['wait', 'Pathao login', 'Checking…'])
        : ['bad', 'Pathao account', 'Not connected · <a href="/couriers" data-link>Connect now</a>'],
      s.pathao_store_id ? ['ok', 'Pickup store', esc(s.pathao_store_name || 'Store #' + s.pathao_store_id)] : ['warn', 'Pickup store', 'Not chosen · <a href="/couriers" data-link>Choose store</a>'],
      webhookLive() ? ['ok', 'Live delivery updates', 'Pathao is sending updates'] : ['warn', 'Live delivery updates', 'Not receiving updates yet · <a href="/couriers" data-link>Set up</a>'],
      state.boot.webhooks && state.boot.webhooks.ok === false ? ['bad', 'New order notifications', esc(state.boot.webhooks.error)] : ['ok', 'New order notifications', 'Shopify sends new orders to ShipBridge'],
      s.sync_fulfillment === false ? ['wait', 'Shopify order updates', 'Turned off'] : permMissing() ? ['warn', 'Shopify order updates', 'Needs your permission · <a href="/couriers" data-link>See how</a>'] : ['ok', 'Shopify order updates', 'Allowed'],
      s.auto_send ? ['ok', 'Auto-send', `On${s.hold_risky !== false ? ' · high-risk orders are held' : ''}`] : ['wait', 'Auto-send', 'Off — orders are sent by hand'],
      (() => { const u = state.boot.usage; return u.limit && u.used >= u.limit ? ['bad', 'Plan', `Limit reached (${u.used}/${u.limit}) · <a href="/billing" data-link>Upgrade</a>`] : ['ok', 'Plan', u.limit ? `${u.used} of ${u.limit} orders used` : 'Unlimited orders']; })(),
    ];
    $('checks').innerHTML = items.map(([k, t, sub]) => `<li><span class="ck ${k}"><svg viewBox="0 0 24 24" aria-hidden="true">${ICON[k]}</svg></span><div><b>${t}</b><div class="sub">${sub}</div></div></li>`).join('');
  }
  async function runChecks() {
    state.checks = {};
    renderChecks();
    if (S().connected) {
      try { const t = await api('/pathao/test', { method: 'POST' }); state.checks.pathao = t.ok ? { ok: true, stores: t.stores.length } : { ok: false, error: t.error }; }
      catch (e) { state.checks.pathao = { ok: false, error: e.message }; }
    }
    await refreshBoot();
    renderChecks();
  }

  // ---------------- render all ----------------
  function renderAll() {
    renderBanners();
    if (state.loaded) renderOrders(); else renderHeader();
    renderCouriers();
    if (state.page === 'support') renderChecks();
  }
  async function refreshBoot() { state.boot = await api('/bootstrap'); renderAll(); }

  // ---------------- events ----------------
  document.addEventListener('click', async (ev) => {
    const t = ev.target;
    if (!t.closest('#courier-menu') && !t.closest('#bulk-menu-btn')) closeMenu();
    const link = t.closest('a[data-link]');
    if (link) { ev.preventDefault(); navigate(link.getAttribute('href')); return; }
    if (t.closest('[data-perm]')) { ev.preventDefault(); const b = t.closest('button'); try { await (b ? busy(b, requestPermissions) : requestPermissions()); } catch (e) { toast(e.message, true); } return; }

    // orders
    const stage = t.closest('[data-stage]');
    if (stage) { state.stage = state.stage === stage.dataset.stage ? null : stage.dataset.stage; renderOrders(); return; }
    const grp = t.closest('[data-group]');
    if (grp) { state.group = grp.dataset.group; state.stage = null; renderOrders(); return; }
    const rk = t.closest('[data-risk]');
    if (rk) { state.risk = rk.dataset.risk; renderOrders(); return; }
    if (t.closest('[data-close]')) { state.focus = null; renderOrders(); return; }
    const act = t.closest('[data-act]');
    if (act) {
      const o = state.orders.find((x) => x.id === act.dataset.id);
      if (act.dataset.act === 'open') { state.focus = o.id; renderOrders(); if (window.innerWidth <= 1100) $('detail').scrollIntoView({ behavior: 'smooth' }); return; }
      if (act.dataset.act === 'shopify') { window.open(shopifyOrderUrl(o), '_top'); return; }
      if (act.dataset.act === 'send') { try { await busy(act, () => sendOrders([o.id], S().default_courier || 'pathao')); } catch (e) { toast(e.message, true); } return; }
    }
    const tr = t.closest('[data-track]');
    if (tr) { try { await busy(tr, async () => { await api(`/orders/${tr.dataset.track}/refresh`, { method: 'POST' }); await loadOrders(); }); } catch (e) { toast(e.message, true); } return; }
    if (t.closest('[data-select]') || t.closest('#check-all')) return; // handled in change
    const row = t.closest('[data-open]');
    if (row && !t.closest('a,button,input')) { state.focus = row.dataset.open; renderOrders(); if (window.innerWidth <= 1100) $('detail').scrollIntoView({ behavior: 'smooth' }); return; }
    if (t.closest('#bulk-menu-btn')) { openMenu($('bulk-menu-btn'), [...state.selected]); return; }
    const pick = t.closest('[data-pick]');
    if (pick && !pick.disabled) { const ids = state.menuFor || []; closeMenu(); try { await sendOrders(ids, pick.dataset.pick); } catch (e) { toast(e.message, true); } return; }
    if (t.closest('#bulk-clear')) { state.selected.clear(); renderOrders(); return; }

    // couriers
    const cv = t.closest('[data-cview]');
    if (cv) { state.courierView = cv.dataset.cview; renderCouriers(); return; }
    const ts = t.closest('[data-toggle-step]');
    if (ts) { const k = ts.dataset.toggleStep; const isOpen = document.querySelector(`.step[data-step="${k}"]`).classList.contains('open'); state.openStep = isOpen ? null : k; if (!isOpen) fillAccount(); renderCouriers(); return; }
    const env = t.closest('[data-env]');
    if (env) { state.envDraft = env.dataset.env; renderCouriers(); return; }
    const sp = t.closest('[data-speed]');
    if (sp) { savePrefs({ delivery_type: Number(sp.dataset.speed) }); return; }
    const wn = t.closest('[data-when]');
    if (wn) { savePrefs({ fulfill_when: wn.dataset.when }); return; }
    if (t.closest('#copy-url')) {
      try { await navigator.clipboard.writeText(state.boot.pathaoWebhook.url); toast('Callback URL copied'); }
      catch (e) { $('wh_url').select(); toast('Press Ctrl+C to copy the selected URL'); }
      return;
    }

    // billing
    const per = t.closest('[data-period]');
    if (per) { state.period = per.dataset.period; renderBilling(); return; }

    const b = t.closest('#send-new,#bulk-default,#reload-orders,#save-connection,#save-webhook,#run-checks,[data-plan],[data-downgrade]');
    if (!b) return;
    try {
      if (b.id === 'send-new') {
        const ids = newReady().map((o) => o.id);
        if (!confirm(`Send ${ids.length} new order${ids.length === 1 ? '' : 's'} to Pathao? High-risk orders are left for you to review.`)) return;
        return await busy(b, () => sendOrders(ids, S().default_courier || 'pathao'));
      }
      if (b.id === 'bulk-default') return await busy(b, () => sendOrders([...state.selected], S().default_courier || 'pathao'));
      if (b.id === 'reload-orders') return await busy(b, async () => { await refreshBoot(); await loadOrders(); });
      if (b.id === 'save-connection') return await busy(b, saveConnection);
      if (b.id === 'save-webhook') return await busy(b, async () => {
        const secret = $('wh_secret').value.trim();
        apply(await api('/settings', { method: 'POST', body: { webhook_secret: secret } }));
        state.boot.pathaoWebhook.secret = secret; toast('Secret key saved'); renderCouriers();
      });
      if (b.id === 'run-checks') return await busy(b, runChecks);
      if (b.dataset.plan) return await busy(b, async () => { const r = await api('/billing/subscribe', { method: 'POST', body: { plan: b.dataset.plan, interval: state.period } }); window.open(r.confirmationUrl, '_top'); });
      if (b.dataset.downgrade !== undefined) {
        if (!confirm('Cancel your paid plan and switch to Free (50 orders a month)?')) return;
        return await busy(b, async () => { await api('/billing/cancel', { method: 'POST' }); await refreshBoot(); await loadBilling(); toast('Switched to Free'); });
      }
    } catch (e) { toast(e.message, true); }
  });

  document.addEventListener('change', (ev) => {
    const el = ev.target;
    const box = el.closest('[data-select]');
    if (box) { if (box.checked) state.selected.add(box.dataset.select); else state.selected.delete(box.dataset.select); renderRows(); return; }
    if (el.id === 'check-all') { visible().filter(canSend).forEach((o) => { if (el.checked) state.selected.add(o.id); else state.selected.delete(o.id); }); renderRows(); return; }
    if (['auto_send', 'hold_risky', 'sync_fulfillment', 'notify_customer'].includes(el.id)) { savePrefs({ [el.id]: el.checked }); return; }
    if (el.id === 'pathao_store_id' && /^\d+$/.test(el.value)) {
      const name = el.options[el.selectedIndex].textContent.replace(' (inactive)', '');
      api('/settings', { method: 'POST', body: { pathao_store_id: el.value, pathao_store_name: name } }).then((r) => { apply(r); state.openStep = undefined; toast('Pickup store saved'); renderAll(); }).catch((e) => toast(e.message, true));
    }
  });
  ['default_weight', 'default_note'].forEach((id) => $(id).addEventListener('input', () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const w = Number($('default_weight').value);
      if (id === 'default_weight' && !(w >= 0.5 && w <= 10)) { $('prefs-state').textContent = 'Weight must be 0.5–10 kg'; return; }
      savePrefs(id === 'default_weight' ? { default_weight: w } : { default_note: $('default_note').value }, true);
    }, 700);
  }));
  $('search').addEventListener('input', (e) => { state.search = e.target.value; renderRows(); });
  $('ticket-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const btn = $('send-ticket');
    try {
      await busy(btn, async () => {
        await api('/support', { method: 'POST', body: { topic: $('t_topic').value, email: $('t_email').value.trim(), order_name: $('t_order').value.trim(), message: $('t_message').value.trim() } });
        $('t_message').value = ''; $('t_order').value = '';
        toast('Message sent — we will reply by email');
        state.support = await api('/support'); renderTickets();
      });
    } catch (e) { toast(e.message, true); }
  });
  window.addEventListener('resize', closeMenu);
  // Webhook updates land in the database instantly; pull them into the screen every 30s.
  setInterval(() => {
    if (document.visibilityState === 'visible' && state.page === 'orders' && state.loaded && !state.selected.size && $('courier-menu').hidden) loadOrders();
  }, 30000);

  async function start() {
    let embedded = true;
    try { embedded = window.top !== window.self; } catch (e) { embedded = true; }
    if (!embedded || !(window.shopify && shopify.idToken)) {
      $('banners').innerHTML = '<div class="banner info"><b>Open ShipBridge from your Shopify admin.</b>&nbsp;Go to your store admin → Apps → ShipBridge. If it isn\'t listed, install it first.</div>';
      $$('.page').forEach((p) => { p.hidden = true; });
      return;
    }
    showPage(pageFromPath());
    try { await refreshBoot(); fillAccount(); }
    catch (e) { $('banners').innerHTML = `<div class="banner bad"><b>Could not load ShipBridge.</b>&nbsp;${esc(e.message)}</div>`; return; }
    if (state.page === 'orders') loadOrders();
    if (state.page === 'billing') loadBilling();
    if (state.page === 'support') loadSupport();
  }
  start();
})();
