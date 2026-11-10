/* AutoCourier BD embedded admin UI: Orders / Couriers / Billing / Support. Plain JS + App Bridge. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const state = {
    boot: null, orders: [], older: [], found: [], nextCursor: null, loaded: false, selected: new Set(), focus: null,
    page: 'orders', group: null, stage: null, risk: 'any', search: '',
    section: undefined, settingsTab: 'couriers', billing: null, period: 'monthly', range: { key: 'month' }, dp: null, stats: null, support: null, checks: null, menuFor: null,
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
  const LOGO_V = (document.querySelector('meta[name="logo-version"]') || {}).content || '1';
  const LOGOS = Object.fromEntries(['pathao', 'steadfast', 'redx', 'paperfly', 'carrybee', 'bahok'].map((k) => [k, `/assets/couriers/${k}-mark.png?v=${LOGO_V}`]));
  const cmono = (c, cls = '') => (LOGOS[c.key] ? `<img class="cmono logo-img ${cls}" src="${LOGOS[c.key]}" alt="${esc(c.name)}" />` : `<span class="cmono ${cls}" style="background:${esc(c.color)}">${esc(c.name.charAt(0))}</span>`);
  const webhookSaved = (key = 'pathao') => Boolean(state.boot && (key === 'steadfast' ? state.boot.steadfastWebhook : state.boot.pathaoWebhook)?.saved) || webhookLive(key);
  const webhookLive = (key = 'pathao') => Boolean(state.boot && (key === 'steadfast' ? state.boot.steadfastWebhook : state.boot.pathaoWebhook)?.live);
  const defKey = () => (state.boot && state.boot.settings && state.boot.settings.default_courier) || 'pathao';
  const cname = (key) => courier(key || 'pathao').name;
  const sfConnected = () => Boolean(S().steadfast && S().steadfast.connected && !S().steadfast.auth_error);
  const sfRejected = () => Boolean(S().steadfast && S().steadfast.auth_error);
  // Why an unsent order is waiting for the merchant (null = not on hold).
  const badPhoneOf = (o) => Boolean(o.fraud && o.fraud.reasons.some((r) => /not a valid|isn't a Bangladesh mobile|No phone/.test(r.text)));
  // Something must be fixed before this order can be booked (null = nothing).
  function errorReason(o) {
    if (o.cancelled || !canSend(o)) return null;
    const s = o.shipment;
    if (s && s.status === 'failed') {
      const c = cname(s.courier);
      return s.error ? (s.error.startsWith(c) ? s.error : `${c}: ${s.error}`) : `${c} refused the booking`;
    }
    if (s && s.status === 'skipped' && /limit reached/i.test(s.error || '')) return s.error;
    if (badPhoneOf(o)) return 'Phone number needs fixing';
    if (!o.customer || String(o.address || '').length < 10) return 'Customer name or address missing';
    return null;
  }
  // Why an unsent order was not sent automatically (information only, null = nothing to say).
  function waitReason(o) {
    if (o.cancelled || !canSend(o) || errorReason(o)) return null;
    if (held(o)) return (o.shipment.error || '').replace(/^Held( for review)?:\s*/i, '') || 'Held for review';
    if (o.shipment && o.shipment.status === 'skipped' && o.shipment.error) return o.shipment.error;
    if (o.fraud && o.fraud.level === 'high') return 'High fraud risk · check before sending';
    return null;
  }
  function bucketOf(o) {
    if (o.cancelled && !(o.shipment && o.shipment.status === 'sent')) return 'cancelled';
    if (errorReason(o)) return 'errors';
    const k = stageOf(o).key;
    if (k === 'booked' || k === 'picked' || k === 'onway') return 'transit'; // one "In transit" tab
    return k === 'problems' ? 'returned' : k;
  }
  const courierReady = (key) => (key === 'steadfast' ? sfConnected() : Boolean(S().connected && S().pathao_store_id));
  const S = () => state.boot.settings;
  function apply(r) { if (r.settings) state.boot.settings = r.settings; if (r.couriers) state.boot.couriers = r.couriers; }

  // ---------------- routing ----------------
  const ROUTES = { '/': 'orders', '/app': 'orders', '/settings': 'couriers', '/couriers': 'couriers', '/sms': 'couriers', '/plans': 'billing', '/billing': 'billing', '/support': 'orders' };
  const pageFromPath = () => ROUTES[location.pathname.replace(/\/$/, '') || '/'] || 'orders';
  function showPage(page) {
    state.page = page;
    if (location.pathname === '/sms') state.settingsTab = 'sms';
    if (page !== 'orders') closeDetail();
    $$('.page').forEach((p) => show(p, p.dataset.page === page));
    show($('bulkbar'), page === 'orders' && state.selected.size > 0);
    closeMenu();
    window.scrollTo(0, 0);
    if (!state.boot) return;
    if (page === 'orders' && !state.loaded) loadOrders();
    if (page === 'couriers') renderCouriers();
    if (page === 'billing') loadBilling();
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
    if (/approval.?pending/.test(p)) return { key: 'onway', step: 4 }; // Steadfast: rider's word, not confirmed yet
    if (/exceptional/.test(p)) return { key: 'problems', step: 3, bad: true };
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
    if (errorReason(o)) return 'Needs fixing';
    if (!s) return o.cancelled ? 'Cancelled' : 'Not sent';
    if (held(o)) return 'Held for review';
    if (s.status === 'failed') return `Refused by ${cname(s.courier)}`;
    if (s.status === 'skipped') return 'Not sent';
    if (s.status === 'processing') return 'Sending…';
    const p = ps(o).replace(/^order\./, '');
    const map = [[/approval.?pending/, 'Waiting to confirm'], [/exceptional/, 'Lost or damaged'], [/partial/, 'Partially delivered'], [/paid.?return/, 'Returned · fee paid'], [/deliver.*fail|fail/, 'Delivery failed'], [/assigned.?for.?delivery|out.?for/, 'Out for delivery'],
      [/deliver/, 'Delivered'], [/return/, 'Returned'], [/pickup.?cancel|cancel/, 'Cancelled'], [/assigned.?for.?pickup/, 'Rider assigned'], [/picked/, 'Picked up'],
      [/sorting/, 'At sorting hub'], [/hub/, 'At delivery hub'], [/transit/, 'In transit'], [/hold/, 'On hold']];
    const hit = map.find(([re]) => re.test(p));
    return hit ? hit[1] : `Sent to ${cname(s.courier)}`;
  }
  const canSend = (o) => !o.cancelled && (!o.shipment || ['failed', 'skipped'].includes(o.shipment.status));
  const riskKey = (o) => (o.fraud ? ({ high: 'high', medium: 'check', low: 'new', pending: 'new', safe: 'safe' }[o.fraud.level] || 'new') : 'new');
  const riskText = (o) => (o.fraud ? ({ high: 'High', medium: 'Check', low: 'New', pending: 'Checking', safe: 'Safe' }[o.fraud.level] || '—') : '—');
  function riskWhy(o) {
    const f = o.fraud; if (!f) return '';
    const h = f.history || {};
    if (f.level === 'safe' && h.delivered) return `${h.delivered} delivered`;
    const bad = f.reasons.find((r) => r.level === f.level) || f.reasons[0];
    if (!bad) return '';
    const t = bad.text;
    if (/not a valid|isn't a Bangladesh mobile|No phone/.test(t)) return 'Invalid phone';
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
    const badPhone = o.fraud && o.fraud.reasons.some((r) => /not a valid|isn't a Bangladesh mobile|No phone/.test(r.text));
    if (badPhone) return { label: 'Fix phone', cls: 'btn sm warn', act: 'shopify' };
    if (held(o) || (o.fraud && o.fraud.level === 'high')) return { label: 'Review', cls: 'btn sm warn', act: 'open' };
    if (o.shipment && o.shipment.status === 'failed') return { label: 'Retry', cls: 'btn sm', act: 'send' };
    return { label: `Send to ${cname(defKey())}`, cls: 'btn sm primary', act: 'send' };
  }
  const shopifyOrderUrl = (o) => `https://admin.shopify.com/store/${state.boot.shop.replace('.myshopify.com', '')}/orders/${o.id}`;
  const trackUrl = (o) => (o.shipment.courier === 'steadfast'
    ? `https://steadfast.com.bd/t/${encodeURIComponent(o.shipment.trackingCode || '')}`
    : `https://merchant.pathao.com/tracking?consignment_id=${encodeURIComponent(o.shipment.consignmentId)}${o.phoneNormalized ? `&phone=${encodeURIComponent(o.phoneNormalized)}` : ''}`);

  // ---------------- banners ----------------
  function renderBanners() {
    const b = state.boot, out = [];
    if (b.webhooks && b.webhooks.ok === false) out.push(`<div class="banner bad"><b>New orders can't reach AutoCourier BD.</b> Shopify refused to set up order notifications: ${esc(b.webhooks.error)}</div>`);
    if (S().pathao_env === 'sandbox') out.push('<div class="banner warn">Pathao is in <b>test mode</b>: bookings go to the sandbox, not real riders.</div>');
    if (b.usage.limit && b.usage.used >= b.usage.limit) out.push(`<div class="banner bad">You've used all ${b.usage.limit} orders on your plan this month. <a href="/billing" data-link><b>Upgrade to keep sending</b></a></div>`);
    $('banners').innerHTML = out.join('');
  }

  // ---------------- orders page ----------------
  // Dashboard checklist: covers every available courier, not only the default one.
  function setupSteps() {
    const s = S();
    const all = (state.boot.couriers || []).filter((c) => c.available);
    const ready = all.filter((c) => courierReady(c.key));
    const notLive = ready.filter((c) => !webhookSaved(c.key));
    const prefix = (k) => (k === 'steadfast' ? 'sf-' : '');
    const firstUnready = all.find((c) => !courierReady(c.key));
    return [
      { key: 'courier', done: ready.length > 0,
        html: ready.length ? `Couriers connected: ${ready.map((c) => c.name).join(', ')}` : `Connect a courier (${all.map((c) => c.name).join(' or ')})`,
        btn: [firstUnready ? (firstUnready.key === 'pathao' && s.connected ? 'delivery' : `${prefix(firstUnready.key)}account`) : 'account', 'Connect a courier'] },
      { key: 'live', done: ready.length > 0 && notLive.length === 0,
        html: notLive.length ? `Set up the webhook for ${notLive.map((c) => c.name).join(' and ')}` : 'Webhooks set up',
        btn: [notLive.length ? `${prefix(notLive[0].key)}webhook` : 'webhook', 'Set up webhook'] },
      // (No "allow Shopify access" step: the app asks for it when it is installed.)
      { key: 'auto', done: Boolean(s.auto_send) && courierReady(defKey()),
        html: !courierReady(defKey()) && ready.length ? `Make ${ready[0].name} your default courier, then turn on auto-send` : `Send new orders to ${cname(defKey())} automatically`,
        btn: ['defaults', !courierReady(defKey()) && ready.length ? 'Choose default' : 'Turn on auto-send'] },
    ];
  }
  function pathaoSteps() {
    const s = S();
    return [
      { key: 'account', done: Boolean(s.connected), html: 'Connect your Pathao account', btn: ['account', 'Add Pathao'] },
      { key: 'delivery', done: Boolean(s.pathao_store_id), html: 'Choose the Pathao store parcels are picked up from', btn: ['delivery', 'Choose store'] },
      { key: 'webhook', done: webhookSaved('pathao'), html: 'Connect the Pathao webhook so delivery status updates live', btn: ['webhook', 'Set up webhook'] },
      { key: 'auto', done: Boolean(s.auto_send), html: 'Send new orders to Pathao automatically', btn: ['defaults', 'Turn on auto-send'] },
    ];
  }
  const newReady = () => state.orders.filter((o) => !o.shipment && !o.cancelled && bucketOf(o) === 'new');
  // Dashboard auto-send: on = new orders go to the chosen courier; off = assign yourself.
  function renderAutoBox() {
    const s = S(), def = defKey(), on = Boolean(s.auto_send);
    const avail = (state.boot.couriers || []).filter((c) => c.available);
    $('auto-box').innerHTML = `<label class="mini-switch" title="${courierReady(def) ? '' : `Connect ${esc(cname(def))} first`}"><input type="checkbox" id="dash-auto" ${on ? 'checked' : ''} ${courierReady(def) || on ? '' : 'disabled'} /><i aria-hidden="true"></i><span>Auto-send</span></label>
      ${on ? `<span class="auto-to">to</span><div class="seg sm" role="radiogroup" aria-label="Auto-send courier">${avail.map((c) => {
        const ok = courierReady(c.key);
        return `<button role="radio" data-defc="${esc(c.key)}" aria-checked="${c.key === def}" ${ok ? '' : 'disabled title="Connect it first"'}>${esc(c.name)}</button>`;
      }).join('')}</div>` : '<span class="auto-off">Off · assign couriers yourself</span>'}`;
  }
  function renderHeader() {
    renderAutoBox();
    const u = state.boot.usage;
    $('usage-line').textContent = u.limit ? `${u.used} of ${u.limit} orders used this month` : `${u.used} orders this month · Unlimited`;
    const live = (state.boot.couriers || []).filter((c) => c.available && webhookLive(c.key));
    const pill = $('live-pill');
    show(pill, live.length > 0);
    if (live.length) {
      const logos = `<span class="pill-logos">${live.map((c) => cmono(c, 'pill-logo')).join('')}</span>`;
      pill.innerHTML = `${logos}<i></i>${live.length === 1 ? `${esc(live[0].name)} live` : `${live.length} couriers live`}`;
      pill.title = live.map((c) => `${c.name} live`).join(' · ') + ' — delivery status updates instantly';
    }
    const steps = setupSteps(), done = steps.filter((x) => x.done).length;
    show($('setup'), done < steps.length);
    const next = steps.find((x) => !x.done);
    $('setup-title').textContent = next ? `Next: ${next.html}` : 'All set';
    $('setup-count').textContent = `${done} of ${steps.length} setup tasks complete`;
    const pct = Math.round((done / steps.length) * 100);
    $('setup-ring').style.background = `conic-gradient(#303030 0 ${pct}%, #e3e3e3 ${pct}% 100%)`;
    $('setup-ring').innerHTML = `<b>${done}/${steps.length}</b>`;
    $('steps').innerHTML = steps.map((x) => `<li class="${x.done ? 'done' : ''}"><span class="tick"></span><span class="step-text">${esc(x.html)}</span>${x.done ? '' : `<button class="btn sm" data-goto="${x.btn[0]}">${esc(x.btn[1])}</button>`}</li>`).join('');
    const ready = newReady();
    show($('send-new'), ready.length > 0 && courierReady(defKey()));
    $('send-new-label').textContent = `Send ${ready.length} new order${ready.length === 1 ? '' : 's'} to ${cname(defKey())}`;
    renderStats();
  }
  function renderStats() { renderOverview(); }
  async function loadStats() {
    const [from, to] = rangeDates(state.range);
    const q = from ? `from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(addDays(to, 1).toISOString())}` : 'range=all';
    try { state.stats = await api(`/stats?${q}`); renderOverview(); } catch (e) { /* overview is optional */ }
  }
  // ---------------- date range (Shopify-style picker) ----------------
  const DAY = 86400000;
  const sod = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const fromYmd = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ''); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; };
  const PRESETS = [
    ['today', 'Today', 'today'], ['yesterday', 'Yesterday', 'yesterday'], ['7d', 'Last 7 days', 'in the last 7 days'],
    ['30d', 'Last 30 days', 'in the last 30 days'], ['month', 'This month', 'this month'], ['lastmonth', 'Last month', 'last month'],
    ['all', 'All time', 'since you started'],
  ];
  // [first day, last day] (inclusive, local midnight) or [null, null] for all time.
  function rangeDates(r) {
    const t = sod(new Date());
    switch (r.key) {
      case 'today': return [t, t];
      case 'yesterday': return [addDays(t, -1), addDays(t, -1)];
      case '7d': return [addDays(t, -6), t];
      case '30d': return [addDays(t, -29), t];
      case 'month': return [new Date(t.getFullYear(), t.getMonth(), 1), t];
      case 'lastmonth': return [new Date(t.getFullYear(), t.getMonth() - 1, 1), new Date(t.getFullYear(), t.getMonth(), 0)];
      case 'custom': return [sod(r.from), sod(r.to)];
      default: return [null, null];
    }
  }
  const fmtDay = (d, year) => d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(year ? { year: 'numeric' } : {}) });
  function rangeLabel(r) {
    if (r.key !== 'custom') return PRESETS.find((p) => p[0] === r.key)[1];
    const [a, b] = rangeDates(r);
    return +a === +b ? fmtDay(a, true) : `${fmtDay(a, a.getFullYear() !== b.getFullYear())} – ${fmtDay(b, true)}`;
  }
  function rangeText(r) {
    if (r.key !== 'custom') return PRESETS.find((p) => p[0] === r.key)[2];
    const [a, b] = rangeDates(r);
    return +a === +b ? `on ${fmtDay(a, true)}` : `from ${fmtDay(a, a.getFullYear() !== b.getFullYear())} to ${fmtDay(b, true)}`;
  }
  function openPicker() {
    const [a, b] = rangeDates(state.range);
    const end = b || sod(new Date());
    state.dp = { key: state.range.key, from: a, to: b, view: new Date(end.getFullYear(), end.getMonth() - 1, 1), picking: 'start' };
    show($('dp-pop'), true); $('dp-btn').setAttribute('aria-expanded', 'true');
    renderPicker();
  }
  function closePicker() { state.dp = null; show($('dp-pop'), false); $('dp-btn').setAttribute('aria-expanded', 'false'); }
  function setDraft(key) {
    const [a, b] = rangeDates({ key });
    Object.assign(state.dp, { key, from: a, to: b, picking: 'start' });
    if (b) state.dp.view = new Date(b.getFullYear(), b.getMonth() - 1, 1);
    renderPicker();
  }
  function monthHtml(first) {
    const today = sod(new Date()), dp = state.dp;
    const days = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    let cells = '';
    for (let i = 0; i < first.getDay(); i++) cells += '<span></span>';
    for (let d = 1; d <= days; d++) {
      const day = new Date(first.getFullYear(), first.getMonth(), d);
      const a = dp.from && +day === +dp.from, z = dp.to && +day === +dp.to;
      const mid = dp.from && dp.to && day > dp.from && day < dp.to;
      const cls = [a && 'is-start', z && 'is-end', mid && 'in-range', +day === +today && 'is-today'].filter(Boolean).join(' ');
      cells += `<button class="${cls}" data-day="${ymd(day)}" ${day > today ? 'disabled' : ''} aria-pressed="${Boolean(a || z)}">${d}</button>`;
    }
    const title = first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    return `<div class="dp-month"><div class="dp-title">${esc(title)}</div><div class="dp-grid">${['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((x) => `<span class="dp-dow">${x}</span>`).join('')}${cells}</div></div>`;
  }
  function renderPicker() {
    const dp = state.dp; if (!dp) return;
    $('dp-presets').innerHTML = PRESETS.map(([k, l]) => `<button data-preset="${k}" aria-pressed="${dp.key === k}">${l}</button>`).join('')
      + `<button data-preset="custom" aria-pressed="${dp.key === 'custom'}">Custom range</button>`;
    const next = new Date(dp.view.getFullYear(), dp.view.getMonth() + 1, 1);
    const atEnd = next.getFullYear() === new Date().getFullYear() && next.getMonth() === new Date().getMonth();
    $('dp-cal').innerHTML = `<button class="dp-nav prev" data-dpnav="-1" aria-label="Previous month"><svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg></button>
      <button class="dp-nav next" data-dpnav="1" aria-label="Next month" ${atEnd ? 'disabled' : ''}><svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></button>
      ${monthHtml(dp.view)}${monthHtml(next)}`;
    if (document.activeElement !== $('dp-from')) $('dp-from').value = dp.from ? ymd(dp.from) : '';
    if (document.activeElement !== $('dp-to')) $('dp-to').value = dp.to ? ymd(dp.to) : '';
    $('dp-from').max = $('dp-to').max = ymd(new Date());
    $('dp-hint').textContent = dp.key === 'all' ? 'All parcels since you started' : dp.from && !dp.to ? 'Now pick the end date' : '';
    $('dp-apply').disabled = Boolean(dp.key !== 'all' && !(dp.from && dp.to));
  }
  function pickDay(day) {
    const dp = state.dp;
    if (dp.picking === 'start' || !dp.from) { Object.assign(dp, { key: 'custom', from: day, to: null, picking: 'end' }); }
    else {
      if (day < dp.from) [dp.from, day] = [day, dp.from];
      Object.assign(dp, { key: 'custom', to: day, picking: 'start' });
    }
    renderPicker();
  }
  function applyPicker() {
    const dp = state.dp;
    state.range = dp.key === 'custom' ? { key: 'custom', from: dp.from, to: dp.to || dp.from } : { key: dp.key };
    // A custom range that equals a preset is shown with the preset's name.
    if (dp.key === 'custom') {
      const same = PRESETS.find(([k]) => { const [a, b] = rangeDates({ key: k }); return a && +a === +state.range.from && +b === +state.range.to; });
      if (same) state.range = { key: same[0] };
    }
    closePicker();
    $('dp-label').textContent = rangeLabel(state.range);
    state.stats = null; renderOverview(); loadStats();
  }
  // Fraud check over the orders on the dashboard that fall in the chosen dates.
  function fraudSummary() {
    const [a, b] = rangeDates(state.range);
    const end = b ? addDays(b, 1) : null;
    const list = state.orders.filter((o) => !o.cancelled && o.fraud && (!a || (new Date(o.createdAt) >= a && new Date(o.createdAt) < end)));
    const c = { high: 0, medium: 0, low: 0, safe: 0, pending: 0 };
    list.forEach((o) => { c[o.fraud.level] = (c[o.fraud.level] || 0) + 1; });
    return { total: list.length, ...c };
  }
  // Overview: on narrower screens only the first row of cards shows until "Show all" (choice remembered).
  function setOverviewOpen(open) {
    state.ovOpen = open;
    try { localStorage.setItem('sb-ov-open', open ? '1' : '0'); } catch (e) { /* storage blocked */ }
    $('ov-kpis').classList.toggle('collapsed', !open);
    $('ov-more').textContent = open ? 'Show less' : 'Show all';
    $('ov-more').setAttribute('aria-expanded', String(open));
  }
  function renderOverview() {
    const st = state.stats;
    if (!st) { $('ov-kpis').innerHTML = '<div class="card kpi skeleton"></div>'.repeat(6); return; }
    const sr = st.successRate;
    const srCol = sr == null ? '#9ca3af' : sr >= 85 ? '#22c55e' : sr >= 65 ? '#f59e0b' : '#ef4444';
    $('ov-sub').textContent = `Parcels sent through AutoCourier BD ${rangeText(state.range)}`;
    $('dp-label').textContent = rangeLabel(state.range);
    const fr = fraudSummary();
    const kpi = (cls, icon, label, value, foot) => `<div class="card kpi k-${cls}"><div class="kpi-top"><span class="k-icon"><svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg></span><span class="k-label">${label}</span></div><b class="k-value">${value}</b>${foot}</div>`;
    const way = st.onTheWay || 0;
    $('ov-kpis').innerHTML = [
      kpi('total', '<path d="M3 7l9-4 9 4-9 4z"/><path d="M3 7v10l9 4 9-4V7M12 11v10"/>', 'Total orders', st.sent + (st.notSent || 0),
        `<span class="k-foot">${st.sent} sent${st.notSent ? ` · ${st.notSent} not sent` : ''}${st.avgFee != null ? ` · avg fee ${taka(st.avgFee)}` : ''}</span>`),
      kpi('way', '<path d="M3 7h11v9H3zM14 10h4l3 3v3h-7"/><circle cx="7" cy="17.5" r="1.6"/><circle cx="17" cy="17.5" r="1.6"/>', 'In transit', way,
        `<span class="k-split"><i style="flex:${st.booked || 0}" class="s1"></i><i style="flex:${st.picked || 0}" class="s2"></i><i style="flex:${st.transit || 0}" class="s3"></i>${way ? '' : '<i style="flex:1" class="s0"></i>'}</span>
         <span class="k-foot">${st.booked} sent · ${st.picked} picked up · ${st.transit} on the road</span>`),
      kpi('done', '<path d="M5 12.5l4.5 4.5L19 7.5"/>', 'Delivered', st.delivered,
        `<span class="k-foot"><b>${taka(st.codCollected)}</b> cash collected</span>`),
      kpi('bad', '<path d="M9 14l-5-5 5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>', 'Not delivered', st.problems,
        `<span class="k-foot">${st.returned} returned · ${st.cancelled} cancelled · ${st.failed} failed</span>`),
      `<div class="card kpi k-rate"><div class="kpi-top"><span class="k-label">Success rate</span></div>
        <div class="rate"><span class="rate-ring" style="background:conic-gradient(${srCol} 0 ${sr || 0}%, #eceef2 ${sr || 0}% 100%)"><b>${sr == null ? '—' : sr + '%'}</b></span>
        <span class="k-foot">${sr == null ? 'Shows once parcels finish' : `${st.delivered} of ${st.delivered + st.problems} finished parcel${st.delivered + st.problems === 1 ? '' : 's'} delivered`}</span></div></div>`,
      `<button class="card kpi k-fraud" data-fraudcard title="Show high risk orders">
        <div class="kpi-top"><span class="k-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/><path d="M12 8v4M12 15h.01"/></svg></span><span class="k-label">Fraud check</span></div>
        <b class="k-value">${fr.high}<small> high risk</small></b>
        <span class="k-split">${fr.total ? `<i style="flex:${fr.high}" class="f-high"></i><i style="flex:${fr.medium}" class="f-med"></i><i style="flex:${fr.low + fr.pending}" class="f-low"></i><i style="flex:${fr.safe}" class="f-safe"></i>` : '<i style="flex:1" class="s0"></i>'}</span>
        <span class="k-foot">${fr.total ? `${fr.medium} medium · ${fr.low + fr.pending} low · ${fr.safe} safe · ${fr.total} order${fr.total === 1 ? '' : 's'}` : 'No orders in these dates'}</span></button>`,
    ].join('');
  }

  const STAGES = [
    ['new', 'New', 't-new'], ['errors', 'Errors', 't-bad'], ['transit', 'In transit', 't-go'],
    ['delivered', 'Delivered', 't-done'], ['returned', 'Returned', 't-bad'], ['cancelled', 'Cancelled', ''],
  ];
  function renderPipeline() {
    const c = {}; state.orders.forEach((o) => { const k = bucketOf(o); c[k] = (c[k] || 0) + 1; });
    const tabs = [['', 'All', state.orders.length, '']].concat(STAGES.map(([k, l, tone]) => [k, l, c[k] || 0, tone]));
    $('pipeline').innerHTML = tabs.map(([k, l, n, tone]) => `<button role="tab" class="${tone}" aria-selected="${(state.stage || '') === k}" data-stage="${k}"><span>${l}</span><b>${n}</b></button>`).join('');
  }
  const RISKS = [['any', 'All risk'], ['high', 'High'], ['medium', 'Medium'], ['low', 'Low'], ['safe', 'Safe'], ['pending', 'Checking']];
  const levelOf = (o) => (o.fraud ? o.fraud.level : 'pending');
  function renderGroups() {
    const rc = { any: state.orders.length }; state.orders.forEach((o) => { const l = levelOf(o); rc[l] = (rc[l] || 0) + 1; });
    $('risk-chips').innerHTML = '<span class="lbl">Fraud check</span>' + RISKS.filter(([k]) => k === 'any' || rc[k]).map(([k, l]) =>
      `<button data-risk="${k}" class="${state.risk === k ? 'active' : ''} ${k !== 'any' ? 'rk-' + k : ''}">${k !== 'any' ? '<i></i>' : ''}${l} <span>${rc[k] || 0}</span></button>`).join('');
  }
  function visible() {
    const q = state.search.trim().toLowerCase();
    // "All" = every order, newest first (sorted on load); the other tabs narrow it down.
    return state.orders.filter((o) => (!state.stage || bucketOf(o) === state.stage)
      && (state.risk === 'any' || levelOf(o) === state.risk)
      && (!q || `${o.name} ${o.customer} ${o.phone} ${o.city} ${o.shipment ? o.shipment.consignmentId : ''}`.toLowerCase().includes(q)));
  }
  function thumbs(o) {
    const list = (o.products || []).slice(0, 2);
    if (!list.length) return '<span class="thumb">–</span>';
    return list.map((p, i) => (p.image ? `<img class="thumb" style="z-index:${5 - i}" src="${esc(p.image)}" alt="" loading="lazy" />` : `<span class="thumb" style="z-index:${5 - i}">${esc((p.title || '?').charAt(0).toUpperCase())}</span>`)).join('');
  }
  const RISK_ICON = {
    high: '<path d="M12 3l9 16H3z"/><path d="M12 10v4M12 17h.01"/>', medium: '<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/>',
    low: '<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/>', safe: '<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/><path d="M9 12l2 2 4-4"/>',
    pending: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  };
  const TRUCK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7h11v9H3zM14 10h4l3 3v3h-7"/><circle cx="7" cy="17.5" r="1.6" fill="currentColor"/><circle cx="17" cy="17.5" r="1.6" fill="currentColor"/></svg>';
  function fulfillBadge(o) {
    const f = String(o.fulfillment || '').toUpperCase();
    if (o.cancelled) return '<span class="badge">Cancelled</span>';
    if (f === 'FULFILLED') return '<span class="badge green">Fulfilled</span>';
    if (f === 'PARTIALLY_FULFILLED') return '<span class="badge yellow">Partial</span>';
    return '<span class="badge yellow">Unfulfilled</span>';
  }
  function payCell(o) {
    const f = String(o.financial || '').toUpperCase();
    const badge = f === 'PAID' ? '<span class="badge green">Paid</span>' : f === 'PARTIALLY_PAID' ? '<span class="badge yellow">Partially paid</span>' : /REFUND/.test(f) ? '<span class="badge">Refunded</span>' : '<span class="badge yellow">Pending</span>';
    return `<span class="amount">${esc(taka(o.total))}</span><span class="sub">${badge}</span>${o.cod > 0 && f !== 'PAID' ? `<span class="sub nowrap">COD ${esc(taka(o.cod))}</span>` : ''}`;
  }
  function courierCell(o) {
    const s = o.shipment;
    if (s && s.status === 'sent') {
      const c = courier(s.courier || 'pathao');
      return `<span class="courier-chip">${cmono(c)}${esc(c.name)}</span>${webhookLive(c.key) ? '<span class="live" title="Webhook connected — status updates instantly"><i></i>Live</span>' : ''}`;
    }
    if (s && s.status === 'processing') return '<span class="sub">Sending…</span>';
    if (o.cancelled && !s) return '<span class="sub">—</span>';
    if (badPhoneOf(o)) return `<a class="assign warn" href="${esc(shopifyOrderUrl(o))}" target="_top"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/></svg>Fix phone</a>`;
    return `<button class="assign" data-assign="${esc(o.id)}">${TRUCK}${s ? 'Retry' : 'Assign courier'}</button>`;
  }
  // Delivery status: a coloured pill with icon, and a 5-dot stepper underneath.
  const ST_ICON = { ok: '<path d="M5 12.5l4.5 4.5L19 7.5"/>', bad: '<path d="M7 7l10 10M17 7L7 17"/>', go: '<path d="M5 12h12M13 7l5 5-5 5"/>', wait: '<circle cx="12" cy="12" r="3.2" fill="currentColor" stroke="none"/>', hold: '<path d="M9 7v10M15 7v10"/>' };
  function statusTone(o, st) {
    if (errorReason(o)) return 'bad';
    if (held(o)) return 'hold';
    if (st.bad) return 'bad';
    if (st.key === 'delivered') return 'ok';
    if (st.step > 0) return 'go';
    return 'wait';
  }
  function statusCell(o, st) {
    const tone = statusTone(o, st);
    const dots = [1, 2, 3, 4, 5].map((i) => {
      const on = st.bad ? i <= Math.max(st.step, 1) : i <= st.step;
      const cur = !st.bad && i === st.step && st.key !== 'delivered';
      return `<i class="${on ? 'on' : ''}${cur ? ' cur' : ''}${st.bad && i === Math.max(st.step, 1) ? ' x' : ''}"></i>`;
    }).join('');
    const label = stageLabel(o);
    const cn = o.shipment ? cname(o.shipment.courier) : '';
    const longer = { 'Waiting to confirm': `The rider marked it; waiting for ${cn} to confirm`, 'Lost or damaged': `Lost or damaged · contact ${cn}`, 'Returned · fee paid': 'Returned; the customer paid the delivery fee' }[label];
    const why = errorReason(o) || waitReason(o) || (o.shipment && o.shipment.status !== 'sent' && o.shipment.error) || longer || label;
    return `<span class="st st-${tone}" title="${esc(why)}"><svg viewBox="0 0 24 24" aria-hidden="true">${ST_ICON[tone]}</svg><span class="st-t">${esc(label)}</span></span><span class="dots dots-${tone}">${dots}</span>`;
  }
  // Fraud check: mini ring gauge with the score, label and delivery history.
  function fraudCell(o) {
    const f = o.fraud;
    if (!f) return '<span class="sub">—</span>';
    const h = f.history || {}, sc = Number(f.score) || 0;
    const col = { high: '#ef4444', medium: '#f59e0b', low: '#22c55e', pending: '#9ca3af', safe: '#16a34a' }[f.level];
    const sub = h.total ? `${h.successRate != null ? h.successRate + '% success' : 'In progress'} · ${h.total} parcel${h.total > 1 ? 's' : ''}` : 'No history yet';
    return `<button class="fc fc-${esc(f.level)}" data-fraud="${esc(o.id)}" aria-label="Fraud check: ${esc(f.label)}, risk score ${sc} out of 100" title="Risk score ${sc}/100 · higher means riskier">
      <span class="gauge" style="background:conic-gradient(${col} 0 ${sc}%, #eceef2 ${sc}% 100%)"><b>${sc}</b></span>
      <span class="fc-t"><b>${esc(f.label)}</b><small>${esc(sub)}</small></span></button>`;
  }
  // "+880 1712-345670" -> "01712-345670" (how Bangladeshi numbers are written; fits one line).
  function localPhone(p) {
    if (!p) return '';
    const d = String(p).replace(/[^\d]/g, '').replace(/^0*880/, '0');
    return /^01\d{9}$/.test(d) ? `${d.slice(0, 5)}-${d.slice(5)}` : String(p);
  }
  function rowHtml(o) {
    const st = stageOf(o), sel = state.selected.has(o.id), f = o.fraud, h = (f && f.history) || {};
    const first = (o.products && o.products[0]) || null;
    const more = (o.products || []).length > 1 ? `+${o.products.length - 1} more · ` : '';
    const synced = o.shipment && o.shipment.status === 'sent' && o.shipment.consignmentId ? `<span class="cn mono" title="Pathao consignment">${esc(o.shipment.consignmentId)}</span>` : '';
    return `<div class="row${sel ? ' sel' : ''}" data-row="${esc(o.id)}">
      <span class="c-chk">${canSend(o) ? `<input type="checkbox" data-select="${esc(o.id)}" ${sel ? 'checked' : ''} aria-label="Select ${esc(o.name)}" />` : ''}</span>
      <div class="c-order"><span class="o-name">${esc(o.name)}</span><span class="sub">${esc(when(o.createdAt))}</span></div>
      <div class="prod c-prod"><span class="thumbs">${thumbs(o)}</span><div class="prod-t"><span class="ellip" title="${esc(o.items)}">${esc(first ? `${first.title}${first.quantity > 1 ? ` ×${first.quantity}` : ''}` : (o.items || '—'))}</span><span class="sub">${more ? `+${o.products.length - 1} more` : `${o.itemCount} item${o.itemCount === 1 ? '' : 's'}`}</span></div></div>
      <div class="c-cust" style="min-width:0"><b class="ellip">${esc(o.customer || '—')}</b><span class="sub nowrap">${esc(localPhone(o.phone) || o.city || '')}</span></div>
      <div class="c-pay">${payCell(o)}</div>
      <div class="c-ful">${fulfillBadge(o)}</div>
      <div class="c-st">${statusCell(o, st)}${synced}</div>
      <div class="c-fr">${fraudCell(o)}</div>
      <div class="c-cr">${courierCell(o)}</div>
    </div>`;
  }
  function renderRows() {
    const rows = visible();
    show($('orders-loading'), false);
    show($('orders-empty'), !rows.length);
    if (!rows.length) {
      $('rows').innerHTML = '';
      $('orders-empty').innerHTML = state.orders.length ? '<b>No orders here</b>Try another tab, risk filter or search.' : '<b>No orders yet</b>New orders from your store appear here.';
    } else {
      $('rows').innerHTML = rows.map(rowHtml).join('');
    }
    const sendable = rows.filter(canSend);
    $('check-all').checked = sendable.length > 0 && sendable.every((o) => state.selected.has(o.id));
    $('check-all').disabled = !sendable.length;
    renderBulk();
    renderLoadMore();
  }
  function renderBulk() {
    const on = state.page === 'orders' && state.selected.size > 0;
    show($('bulkbar'), on);
    document.querySelector('.list').classList.toggle('selecting', on);
    $('bulk-count').textContent = `${state.selected.size} selected`;
    const sendable = visible().filter(canSend);
    const all = sendable.length > 0 && sendable.every((o) => state.selected.has(o.id));
    $('bulk-all').checked = all;
    $('bulk-all').indeterminate = on && !all;
    $('bulk-default').textContent = `Assign ${courier(S().default_courier || 'pathao').name}`;
  }

  function openFraud(anchor, id) {
    const o = state.orders.find((x) => x.id === id);
    if (!o || !o.fraud) return;
    const f = o.fraud, h = f.history || {}, pop = $('fraud-pop');
    const shop = { high: 'High risk', medium: 'Needs review', low: 'No issues found', pending: 'Still analysing', none: 'No result', unavailable: 'Not available' }[f.shopify] || '—';
    pop.innerHTML = `<div class="fp-head risk-${esc(f.level)}"><svg viewBox="0 0 24 24" aria-hidden="true">${RISK_ICON[f.level] || ''}</svg><div><b>${esc(f.label)}</b><span>${esc(o.name)} · ${esc(o.customer || '')}</span></div><em>${Number(f.score)}/100</em></div>
      ${h.total ? `<div class="fp-stats"><div><b>${h.delivered || 0}</b><span>Delivered</span></div><div><b>${h.returned || 0}</b><span>Returned</span></div><div><b>${h.cancelled || 0}</b><span>Cancelled</span></div><div><b>${h.successRate != null ? h.successRate + '%' : '—'}</b><span>Success</span></div></div>` : ''}
      <ul class="fp-reasons">${f.reasons.map((r) => `<li class="t-${esc(r.tone || '')}">${esc(r.text)}</li>`).join('') || '<li>No warning signs</li>'}</ul>
      <div class="fp-foot"><span>Shopify analysis: <b>${esc(shop)}</b></span><span>Courier network <span class="soon">Soon</span></span></div>`;
    show(pop, true);
    const r = anchor.getBoundingClientRect();
    pop.style.top = `${r.bottom + window.scrollY + 6}px`;
    pop.style.left = `${Math.max(8, Math.min(r.left + window.scrollX - 120, window.innerWidth - pop.offsetWidth - 12))}px`;
  }

  function openDetail(id) { state.focus = id; renderDetail(); }
  function closeDetail() { state.focus = null; show($('detail'), false); show($('drawer-bg'), false); }
  function renderDetail() {
    const o = state.orders.find((x) => x.id === state.focus) || null;
    const el = $('detail');
    show(el, Boolean(o)); show($('drawer-bg'), Boolean(o));
    if (!o) return;
    const f = o.fraud || { level: 'pending', score: 0, reasons: [], history: {} }, h = f.history || {};
    const st = stageOf(o);
    const colors = { high: ['#ef4444', '#fde2e2'], medium: ['#f59e0b', '#fdeccb'], low: ['#22c55e', '#d3f3df'], pending: ['#9ca3af', '#e5e7eb'], safe: ['#22c55e', '#d3f3df'] }[f.level];
    const title = { high: 'High risk — review first', medium: 'Check before sending', low: 'Low risk · looks fine', pending: 'Shopify is still checking', safe: 'Trusted customer' }[f.level];
    const steps = [`Sent to ${cname(o.shipment && o.shipment.status === 'sent' ? o.shipment.courier : defKey())}`, 'Picked up by rider', 'In transit', 'Out for delivery', 'Delivered'];
    const sent = o.shipment && o.shipment.status === 'sent';
    const tl = steps.map((label, i) => {
      const n = i + 1; let cls = '';
      if (sent && n < st.step) cls = 'done';
      if (sent && n === st.step) cls = st.bad ? 'bad' : (n === 5 ? 'done' : 'now');
      const lbl = sent && n === st.step && st.bad ? stageLabel(o) : label;
      const t = sent && n === st.step && o.shipment.updatedAt ? time(o.shipment.updatedAt) : '';
      return `<li class="${cls}"><span class="dot"></span><span class="lbl">${esc(lbl)}</span><span class="sub">${esc(t)}</span></li>`;
    }).join('');
    const paid = String(o.financial || '').toUpperCase() === 'PAID';
    const sendable = canSend(o);
    el.innerHTML = `
      <div class="d-head"><div><span class="sub">${esc(o.name)} · ${esc(when(o.createdAt))}</span><div class="name">${esc(o.customer || 'Customer')}</div><div class="meta">${esc(o.address || o.city || '')}</div></div>
        <button class="btn icon" data-close aria-label="Close"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
      <div class="d-actions">
        ${o.phone ? `<a class="btn ghost" href="tel:${esc(o.phoneNormalized || o.phone)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/></svg>Call customer</a>` : ''}
        ${sent && o.shipment.consignmentId ? `<a class="btn ghost" href="${esc(trackUrl(o))}" target="_blank" rel="noopener">Track parcel</a>` : `<a class="btn ghost" href="${esc(shopifyOrderUrl(o))}" target="_top">Open in Shopify</a>`}
      </div>
      ${o.shipment && o.shipment.status !== 'sent' && o.shipment.error ? `<div class="d-note">${esc(o.shipment.error)}</div>` : ''}
      ${sendable || o.note ? `<div class="d-sec d-notes"><div class="d-label">Your note</div>
        <textarea id="note-input" rows="2" maxlength="500" placeholder="e.g. Customer asked to deliver after Friday">${esc(o.note || '')}</textarea>
        <div class="note-foot"><span class="hint">Only you see this. It is not sent to the courier.</span><button class="btn sm" data-savenote="${esc(o.id)}">Save note</button></div></div>` : ''}
      <div class="d-risk l-${esc(f.level)}">
        <div class="ring" style="background:conic-gradient(${colors[0]} 0 ${Number(f.score) || 0}%, ${colors[1]} ${Number(f.score) || 0}% 100%)"><b>${Number(f.score) || 0}<small>/100</small></b></div>
        <div><div class="t">${esc(title)}</div><div class="r-scale">Risk score · higher means riskier</div><ul>${f.reasons.slice(0, 3).map((r) => `<li>${esc(r.text)}</li>`).join('')}</ul></div>
      </div>
      ${h.total ? `<div class="fp-stats"><div><b>${h.delivered || 0}</b><span>Delivered</span></div><div><b>${h.returned || 0}</b><span>Returned</span></div><div><b>${h.cancelled || 0}</b><span>Cancelled</span></div><div><b>${h.successRate != null ? h.successRate + '%' : '—'}</b><span>Success</span></div></div>` : ''}
      <div class="d-sec"><div class="d-label">Delivery${sent && o.shipment.consignmentId ? ` · <span class="mono">${esc(o.shipment.consignmentId)}</span>` : ''}</div>
        <ul class="tl">${tl}</ul>
        ${sent && o.shipment.courierMessage ? `<div class="courier-msg"><b>Latest from ${esc(cname(o.shipment.courier))}</b>${esc(o.shipment.courierMessage)}${o.shipment.courierMessageAt ? `<span class="sub">${esc(time(o.shipment.courierMessageAt))}</span>` : ''}</div>` : ''}
        ${sent ? `<div class="d-refresh">${webhookLive(o.shipment.courier || 'pathao') ? '<span class="live"><i></i>Live</span>' : '<span class="sub">Status is checked automatically</span>'}</div>` : ''}
      </div>
      <div class="d-money">
        <div class="d-items">${(o.products || []).map((p) => `<div class="it">${p.image ? `<img class="thumb" src="${esc(p.image)}" alt="" />` : `<span class="thumb">${esc((p.title || '?').charAt(0))}</span>`}<span class="ellip" style="flex:1">${esc(p.title)}</span><span class="sub">× ${p.quantity}</span></div>`).join('')}</div>
        <div><span class="meta">Order total</span><b>${esc(taka(o.total))}</b></div>
        ${o.shipment && o.shipment.deliveryFee != null ? `<div><span class="meta">Pathao delivery fee</span><span>${esc(taka(o.shipment.deliveryFee))}</span></div>` : ''}
        <div class="tot"><span>${paid ? 'Paid online' : 'Rider collects (COD)'}</span><span>${esc(taka(paid ? 0 : o.cod))}</span></div>
        ${sendable ? `<button class="btn primary" data-send="${esc(o.id)}" style="height:42px">${f.level === 'high' ? `Send to ${esc(cname(defKey()))} anyway` : o.shipment ? `Retry with ${esc(cname(defKey()))}` : `Send to ${esc(cname(defKey()))}`}</button>` : ''}
      </div>`;
  }
  function renderOrders() { renderHeader(); renderPipeline(); renderGroups(); renderRows(); if (state.focus) renderDetail(); }

  async function loadOrders(pending, { fresh = false } = {}) {
    show($('orders-loading'), !state.orders.length);
    const statsP = loadStats();
    try {
      const r = await (pending || api(fresh ? '/orders?fresh=1' : '/orders'));
      // Keep older pages and search results the merchant loaded; the first page replaces itself.
      if (!state.older.length) state.nextCursor = r.pageInfo && r.pageInfo.hasNextPage ? r.pageInfo.endCursor : null;
      state.firstPage = r.orders;
      mergeOrders();
      if (state.stats) renderOverview();
      state.loaded = true;
      await statsP;
      const ok = new Set(state.orders.filter(canSend).map((o) => o.id));
      [...state.selected].forEach((id) => { if (!ok.has(id)) state.selected.delete(id); });
      renderOrders();
    } catch (e) { show($('orders-loading'), false); toast(e.message, true); }
  }
  function mergeOrders() {
    const byId = new Map();
    for (const o of [...state.found, ...state.older, ...(state.firstPage || [])]) byId.set(o.id, o); // newest data wins
    state.orders = [...byId.values()].sort((x, y) => new Date(y.createdAt) - new Date(x.createdAt));
  }
  function renderLoadMore() {
    const el = $('load-more');
    if (!el) return;
    show(el, Boolean(state.loaded && state.nextCursor));
    $('load-more-note').textContent = `Showing ${state.orders.length} orders`;
  }
  async function loadOlder() {
    if (!state.nextCursor) return;
    const r = await api(`/orders?after=${encodeURIComponent(state.nextCursor)}`);
    state.older = state.older.concat(r.orders);
    state.nextCursor = r.pageInfo && r.pageInfo.hasNextPage ? r.pageInfo.endCursor : null;
    mergeOrders(); renderOrders();
  }
  // Search: filter what's loaded at once, then ask Shopify for matching older orders.
  let searchTimer, searchSeq = 0;
  function searchStore(q) {
    clearTimeout(searchTimer);
    if (q.trim().length < 2) return;
    const seq = ++searchSeq;
    searchTimer = setTimeout(async () => {
      try {
        const r = await api('/orders/search', { method: 'POST', body: { q: q.trim() } });
        if (seq !== searchSeq) return;
        const known = new Set(state.orders.map((o) => o.id));
        const extra = r.orders.filter((o) => !known.has(o.id));
        if (extra.length) { state.found = state.found.concat(extra); mergeOrders(); renderOrders(); }
      } catch (e) { /* local results still show */ }
    }, 450);
  }

  async function sendOrders(ids, key, { confirm: ok2 = false } = {}) {
    if (!ids.length) return;
    const c = courier(key);
    const r = await api('/orders/send', { method: 'POST', body: { ids, courier: key, confirm: ok2 } });
    const unsure = r.results.filter((x) => x.needsConfirm);
    if (unsure.length && !ok2) {
      if (confirm(`${unsure.length === 1 ? 'This order' : `${unsure.length} orders`} may already be booked: ${c.name} did not answer last time.\n\nCheck your ${c.name} panel first. Send again anyway?`)) {
        return sendOrders(unsure.map((x) => x.id), key, { confirm: true });
      }
    }
    const ok = r.results.filter((x) => x.ok).length;
    const failed = r.results.filter((x) => !x.ok && !x.duplicate && !x.needsConfirm);
    if (ok) toast(`${ok} order${ok > 1 ? 's' : ''} sent to ${c.name}`);
    if (failed.length) toast(`${failed.length} not sent: ${failed[0].error}`, true);
    ids.forEach((id) => state.selected.delete(id));
    await Promise.all([refreshBoot(), loadOrders()]);
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
    const below = r.bottom + window.scrollY + 6;
    m.style.top = `${below}px`;
    m.style.left = `${Math.max(8, Math.min(r.left + window.scrollX, window.innerWidth - m.offsetWidth - 8))}px`;
  }
  function closeMenu() { show($('courier-menu'), false); show($('fraud-pop'), false); state.menuFor = null; }

  // ---------------- couriers page ----------------
  function renderCouriers() {
    const s = S();
    const soon = (state.boot.couriers || []).filter((c) => !c.available);
    const p = courier('pathao'), sf = courier('steadfast');
    const ready = s.connected && s.pathao_store_id;
    const view = state.settingsTab === 'sms' ? 'sms' : (state.courierView || defKey());
    const def = defKey();
    $('courier-nav').innerHTML = `<div class="cx-label">Your couriers</div>
      <button class="cx-item${view === 'pathao' ? ' active' : ''}" data-cview="pathao">${cmono(p)}<span class="cx-name"><b>Pathao</b><small class="${ready ? 'ok' : 'warn'}">${ready ? (webhookLive('pathao') ? 'Connected · Live' : 'Connected') : s.connected ? 'Choose a pickup store' : 'Not connected'}</small></span>${def === 'pathao' ? '<span class="cx-def">Default</span>' : ''}</button>
      <button class="cx-item${view === 'steadfast' ? ' active' : ''}" data-cview="steadfast">${cmono(sf)}<span class="cx-name"><b>Steadfast</b><small class="${sfConnected() ? 'ok' : 'warn'}">${sfConnected() ? (webhookLive('steadfast') ? 'Connected · Live' : 'Connected') : sfRejected() ? 'Needs attention' : 'Not connected'}</small></span>${def === 'steadfast' ? '<span class="cx-def">Default</span>' : ''}</button>
      <div class="cx-label">Coming soon</div>
      <button class="cx-item off${view === 'sms' ? ' active' : ''}" data-cview="sms"><span class="cmono" style="background:#64748b">✉</span><span class="cx-name"><b>SMS to customers</b><small>Order confirmation by SMS</small></span></button>
      ${soon.map((c) => `<div class="cx-item off">${cmono(c)}<span class="cx-name"><b>${esc(c.name)}</b><small>${esc(c.tagline)}</small></span></div>`).join('')}`;
    show($('pathao-setup'), view === 'pathao');
    show($('steadfast-setup'), view === 'steadfast');
    show($('sms-tab'), view === 'sms');
    renderRules();
    if (view === 'steadfast') { renderSteadfast(); return; }

    // Same three steps for every courier: API configuration, Webhook configuration, Delivery settings.
    const steps = ['account', 'webhook', 'delivery'].map((k) => pathaoSteps().find((x) => x.key === k));
    const done = steps.filter((x) => x.done).length;
    const pct = Math.round((done / steps.length) * 100);
    $('cx-hero').innerHTML = `<div class="hero-l">${cmono(courier('pathao'), 'hero-mono')}
        <div><div class="hero-title"><h2>Pathao</h2>${ready ? '<span class="badge green">Connected</span>' : '<span class="badge yellow">Setup needed</span>'}${webhookLive() ? '<span class="live-pill"><i></i>Live</span>' : ''}${s.pathao_env === 'sandbox' ? '<span class="badge yellow">Test mode</span>' : ''}</div>
        <p class="meta">${esc(p.tagline || '')}</p></div></div>
      <div class="hero-r"><span class="hero-ring" style="background:conic-gradient(#303030 0 ${pct}%, #e3e3e3 ${pct}% 100%)"><b>${done}/${steps.length}</b></span><span class="meta">${done === steps.length ? 'All set' : 'steps done'}</span></div>
      <div class="hero-facts"><div><span>Pickup store</span><b>${esc(s.pathao_store_name || (s.pathao_store_id ? '#' + s.pathao_store_id : '—'))}</b></div>
        <div><span>Default</span><b>${defKey() === 'pathao' ? 'Yes' : 'No'}</b></div>
        <div><span>Auto-send</span><b>${s.auto_send ? 'On' : 'Off'}</b></div>
        <div><span>Delivery type</span><b>${String(s.delivery_type) === '12' ? 'Express' : 'Regular'}</b></div></div>`;

    const firstOpen = (steps.find((x) => !x.done) || {}).key || null;
    const open = state.section === undefined || state.section === 'auto' ? firstOpen : state.section;
    steps.forEach((x, i) => {
      const el = document.querySelector(`.step[data-step="${x.key}"]`);
      const isOpen = open === x.key;
      el.classList.toggle('done', x.done); el.classList.toggle('open', isOpen);
      el.classList.toggle('attention', !x.done && x.key === firstOpen);
      el.querySelector('.step-dot').textContent = x.done ? '' : String(i + 1);
      el.querySelector('.step-act').textContent = isOpen ? 'Close' : x.done ? (x.key === 'webhook' ? 'View' : 'Edit') : 'Set up';
      el.querySelector('.step-row').setAttribute('aria-expanded', String(isOpen));
    });
    document.querySelector('[data-step="account"] [data-summary]').textContent = s.connected ? `${s.pathao_username} · connected` : 'Client ID, secret, merchant email and password';
    show($('pathao-disconnect'), Boolean(s.connected || s.pathao_client_id));
    document.querySelector('[data-step="delivery"] [data-summary]').textContent = s.pathao_store_id
      ? `${s.pathao_store_name || 'Pickup store #' + s.pathao_store_id} · ${String(s.delivery_type) === '12' ? 'Express' : 'Regular'} · ${Number(s.default_weight) || 0.5} kg${defKey() === 'pathao' ? ' · default' : ''}`
      : 'Pickup store, parcel weight, note, delivery type';
    document.querySelector('[data-step="webhook"] [data-summary]').innerHTML = webhookLive() ? '<span class="live" style="margin:0"><i></i>Live</span>' : webhookSaved('pathao') ? 'Saved' : 'Pathao tells AutoCourier BD the moment a parcel moves';
    const wh = state.boot.pathaoWebhook || {};
    $('wh-state').innerHTML = webhookState(wh, 'Pathao', 'secret key', 'Pathao Merchant Panel');

    const sync = s.sync_fulfillment !== false;
    $('sync_fulfillment').checked = sync;
    $('notify_customer').checked = Boolean(s.notify_customer); $('notify_customer').disabled = !sync;
    $('mark_paid_on_delivery').checked = s.mark_paid_on_delivery !== false;
    $('undo_on_return').checked = s.undo_on_return !== false; $('undo_on_return').disabled = !sync;
    $$('#when-seg button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.when === (s.fulfill_when || 'booked'))));
  }
  // Sending rules (right column): same for every courier view.
  function renderRules() {
    const s = S();
    const def = defKey();
    $('def-seg').innerHTML = (state.boot.couriers || []).filter((c) => c.available).map((c) => {
      const ok = courierReady(c.key);
      return `<button role="radio" data-defc="${esc(c.key)}" aria-checked="${c.key === def}" ${ok ? '' : `disabled title="Connect ${esc(c.name)} first"`}>${esc(c.name)}</button>`;
    }).join('');
    const notReady = (state.boot.couriers || []).filter((c) => c.available && !courierReady(c.key)).map((c) => c.name);
    $('def-hint').textContent = notReady.length ? `Connect ${notReady.join(' and ')} to make it your default.` : '';
    $('auto-hint').textContent = `Sent to ${cname(def)} within seconds`;
    $('auto_send').checked = Boolean(s.auto_send); $('auto_send').disabled = !courierReady(def);
    $('hold_risky').checked = s.hold_risky !== false;
    $$('input[name="pathao-speed"]').forEach((r) => { r.checked = r.value === String(s.delivery_type); });
    renderDefBoxes();
    if (document.activeElement !== $('default_weight')) setVal('default_weight', s.default_weight);
    if (document.activeElement !== $('default_note')) setVal('default_note', s.default_note);
  }
  // "Set <Courier> as default courier": ticked on the default; a courier that isn't connected can't be ticked.
  // There is always one default, so it is changed by ticking another courier.
  function renderDefBoxes() {
    $$('[data-defbox]').forEach((b) => {
      const k = b.dataset.defbox, isDef = defKey() === k;
      b.checked = isDef; b.disabled = !isDef && !courierReady(k);
      b.closest('label').title = isDef ? 'This is your default courier. To change it, tick it on another courier.' : courierReady(k) ? '' : `Connect ${cname(k)} first`;
    });
  }
  // Steadfast setup page.
  function renderSteadfast() {
    const s = S(), sf = s.steadfast || {};
    const wh = state.boot.steadfastWebhook || {};
    const steps = [
      { key: 'sf-account', done: sfConnected() },
      { key: 'sf-webhook', done: webhookSaved('steadfast') },
      { key: 'sf-delivery', done: sfConnected() },
    ];
    const done = steps.filter((x) => x.done).length, pct = Math.round((done / steps.length) * 100);
    // Fetch the balance once per visit (Steadfast rate-limits failed logins, so not on every render).
    if (sfConnected() && state.sfBalance === undefined) {
      state.sfBalance = null;
      api('/steadfast/test', { method: 'POST' }).then((r) => { if (r.ok) { state.sfBalance = r.balance; if (state.courierView === 'steadfast') renderSteadfast(); } }).catch(() => {});
    }
    $('sf-hero').innerHTML = `<div class="hero-l">${cmono(courier('steadfast'), 'hero-mono')}
        <div><div class="hero-title"><h2>Steadfast</h2>${sfConnected() ? '<span class="badge green">Connected</span>' : sfRejected() ? '<span class="badge red">Needs attention</span>' : '<span class="badge yellow">Setup needed</span>'}${webhookLive('steadfast') ? '<span class="live-pill"><i></i>Live</span>' : ''}</div>
        <p class="meta">${esc(courier('steadfast').tagline || '')}</p></div></div>
      <div class="hero-r"><span class="hero-ring" style="background:conic-gradient(#303030 0 ${pct}%, #e3e3e3 ${pct}% 100%)"><b>${done}/${steps.length}</b></span><span class="meta">${done === steps.length ? 'All set' : 'steps done'}</span></div>
      <div class="hero-facts"><div><span>Balance</span><b>${state.sfBalance != null ? esc(taka(state.sfBalance)) : '—'}</b></div>
        <div><span>Default</span><b>${defKey() === 'steadfast' ? 'Yes' : 'No'}</b></div>
        <div><span>Auto-send</span><b>${s.auto_send && defKey() === 'steadfast' ? 'On' : 'Off'}</b></div>
        <div><span>Delivery type</span><b>${Number(s.sf_delivery_type) === 1 ? 'Point delivery' : 'Home delivery'}</b></div></div>`;

    const firstOpen = (steps.find((x) => !x.done) || {}).key || null;
    const open = state.section === undefined || state.section === 'auto' ? firstOpen : state.section;
    steps.forEach((x, i) => {
      const el = document.querySelector(`.step[data-step="${x.key}"]`);
      const isOpen = open === x.key;
      el.classList.toggle('done', x.done); el.classList.toggle('open', isOpen);
      el.classList.toggle('attention', !x.done && x.key === firstOpen);
      el.querySelector('.step-dot').textContent = x.done ? '' : String(i + 1);
      el.querySelector('.step-act').textContent = isOpen ? 'Close' : x.done ? (x.key === 'sf-webhook' ? 'View' : 'Edit') : 'Set up';
      el.querySelector('.step-row').setAttribute('aria-expanded', String(isOpen));
    });
    document.querySelector('[data-step="sf-account"] [data-summary]').textContent = sfConnected() ? `API key ${sf.api_key_hint || ''} · connected`
      : sfRejected() ? 'Steadfast refused the connection, see below' : 'API key and secret key';
    $('sf-auth-error').innerHTML = sfRejected() ? `<b>Steadfast bookings are paused.</b> ${esc(sf.auth_error)}. AutoCourier BD stopped calling Steadfast so your key doesn't get locked out. When it's fixed, click Save &amp; connect.` : '';
    show($('sf-auth-error'), sfRejected());
    document.querySelector('[data-step="sf-webhook"] [data-summary]').innerHTML = webhookLive('steadfast') ? '<span class="live" style="margin:0"><i></i>Live</span>' : webhookSaved('steadfast') ? 'Saved' : 'Steadfast tells AutoCourier BD the moment a parcel moves';
    document.querySelector('[data-step="sf-delivery"] [data-summary]').textContent = [
      sf.delivery_type === 1 ? 'Point delivery' : 'Home delivery',
      defKey() === 'steadfast' ? 'default' : null,
      S().default_note ? `note: ${S().default_note}` : null,
    ].filter(Boolean).join(' · ');
    $$('input[name="sf-type"]').forEach((r) => { r.checked = Number(r.value) === (sf.delivery_type || 0); });
    renderDefBoxes();
    if (document.activeElement !== $('sf_default_note')) setVal('sf_default_note', S().default_note);
    $('sf_api_key').placeholder = sf.has_api_key ? `${sf.api_key_hint} saved` : '';
    $('sf_secret_key').placeholder = sf.has_secret ? '•••••••• saved' : '';
    setVal('sf_wh_url', wh.url);
    show($('sf-disconnect'), sfConnected() || sfRejected());
    $('sf-wh-state').innerHTML = webhookState(wh, 'Steadfast');
  }
  // Only a real problem is shown under the webhook: the courier calling with a different secret/token.
  function webhookState(wh, name, secretWord, portal) {
    if (wh.refusedAt && (!wh.lastAt || new Date(wh.refusedAt) > new Date(wh.lastAt))) {
      if (!secretWord) return `<span class="bad-line"><b>${name} is calling an old AutoCourier BD address.</b> Copy the Callback URL above into the ${name} portal again and save it there.</span>`;
      return `<span class="bad-line"><b>${name} is calling AutoCourier BD with a different ${secretWord}.</b> Make the ${secretWord} here and in the ${portal} the same, then save both.</span>`;
    }
    return '';
  }
  async function saveSteadfast() {
    const key = $('sf_api_key').value.trim(), secret = $('sf_secret_key').value.trim();
    if (!key && !(S().steadfast && S().steadfast.has_api_key)) throw new Error('Enter your Steadfast API key');
    if (!secret && !(S().steadfast && S().steadfast.has_secret)) throw new Error('Enter your Steadfast secret key');
    // Steadfast checks the keys first; nothing is saved if it refuses them.
    const r = await api('/steadfast/connect', { method: 'POST', body: { api_key: key, secret_key: secret } });
    apply(r);
    state.sfBalance = r.balance;
    setVal('sf_secret_key', ''); setVal('sf_api_key', '');
    state.section = undefined;
    toast(`Steadfast connected${r.balance != null ? ` · balance ${taka(r.balance)}` : ''}`);
    renderAll();
  }
  function gotoSection(sec) {
    state.settingsTab = 'couriers';
    if (sec === 'store') sec = 'delivery';
    state.courierView = /^sf-/.test(sec) ? 'steadfast' : ['account', 'webhook', 'delivery'].includes(sec) ? 'pathao' : state.courierView;
    if (sec === 'shopify') sec = 'defaults'; // Shopify updates now live in the right-hand column
    state.section = sec === 'defaults' ? null : sec;
    fillAccount();
    if (state.page !== 'couriers') navigate('/couriers'); else renderCouriers();
    if (sec === 'defaults') setTimeout(() => { const el = document.querySelector('.cx-rules'); if (el) el.scrollIntoView({ behavior: 'smooth' }); }, 50);
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
      sel.innerHTML = `<option value="${esc(s.pathao_store_id)}">${esc(s.pathao_store_name || 'Pickup store #' + s.pathao_store_id)}</option>`;
    }
    if (!s.pathao_store_id && !s.connected) sel.innerHTML = '<option value="">Connect your account first</option>';
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
    // Always the live Pathao account (no test/sandbox switch).
    const body = { pathao_env: 'production', pathao_client_id: $('pathao_client_id').value.trim(), pathao_username: $('pathao_username').value.trim() };
    if ($('pathao_client_secret').value) body.pathao_client_secret = $('pathao_client_secret').value;
    if ($('pathao_password').value) body.pathao_password = $('pathao_password').value;
    if (!body.pathao_client_id || !body.pathao_username) throw new Error('Enter your Pathao Client ID and merchant email');
    apply(await api('/settings', { method: 'POST', body }));
    const test = await loadStores(S().pathao_store_id);
    toast(S().pathao_store_id ? 'Pathao connected' : `Connected — now choose your pickup store (${test.stores.length} found)`);
    state.section = undefined;
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
      <div class="meta">${cur.price ? `${usd(b.interval === 'yearly' ? cur.yearlyPrice : cur.price)} / ${b.interval === 'yearly' ? 'year' : 'month'} · ${sub && sub.currentPeriodEnd ? `renews ${esc(dateOnly(sub.currentPeriodEnd))}` : 'active'}` : 'Free forever'}</div>
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
      ${h.map((x) => `<tr><td><b>${esc(x.name.replace(/^(ShipBridge|AutoCourier BD) /, ''))}</b>${x.test ? ' <span class="pill p-check">Test</span>' : ''}</td><td>${x.price != null ? `${usd(x.price)} / ${x.interval === 'yearly' ? 'year' : 'month'}` : '—'}</td>
        <td><span class="pill ${x.status === 'ACTIVE' ? 'p-safe' : 'p-wait'}">${esc(x.status.charAt(0) + x.status.slice(1).toLowerCase())}</span></td><td>${esc(dateOnly(x.createdAt))}</td><td>${esc(dateOnly(x.currentPeriodEnd))}</td></tr>`).join('')}
      </tbody></table></div><p class="hint" style="margin-top:10px">Invoices and receipts are on your Shopify bill.</p>`
      : `<p class="meta">No paid plans yet. Charges appear on your <a href="${esc(b.shopifyBillingUrl)}" target="_top">Shopify bill</a>.</p>`;
  }

  // ---------------- render all ----------------
  function renderAll() {
    renderBanners();
    if (state.loaded) renderOrders(); else renderHeader();
    renderCouriers();
  }
  // Coming back from Shopify's plan approval page (?charge_id=...): re-check the plan now.
  const returningFromBilling = new URLSearchParams(location.search).has('charge_id');
  async function refreshBoot(fresh = returningFromBilling) { state.boot = await api(fresh ? '/bootstrap?fresh=1' : '/bootstrap'); renderAll(); }

  // ---------------- events ----------------
  document.addEventListener('click', async (ev) => {
    const t = ev.target;
    if (!t.closest('#courier-menu') && !t.closest('#fraud-pop') && !t.closest('#bulk-menu-btn') && !t.closest('[data-assign]') && !t.closest('[data-fraud]')) closeMenu();
    const link = t.closest('a[data-link]');
    if (link) { ev.preventDefault(); navigate(link.getAttribute('href')); return; }

    // dashboard
    const goto = t.closest('[data-goto]');
    if (goto && !goto.disabled) { gotoSection(goto.dataset.goto); return; }
    if (t.closest('#setup-toggle')) { const c = $('setup').classList.toggle('collapsed'); $('setup-toggle').setAttribute('aria-expanded', String(!c)); document.querySelector('.setup-cta').textContent = c ? 'Show steps' : 'Hide steps'; return; }
    const stage = t.closest('[data-stage]');
    if (stage) { state.stage = stage.dataset.stage || null; renderOrders(); return; }
    const rk = t.closest('[data-risk]');
    if (rk) { state.risk = rk.dataset.risk; renderOrders(); return; }
    if (t.closest('[data-close]') || t.closest('#drawer-bg')) { closeDetail(); return; }
    const fr = t.closest('[data-fraud]');
    if (fr) { closeMenu(); openFraud(fr, fr.dataset.fraud); return; }
    const asg = t.closest('[data-assign]');
    if (asg) { closeMenu(); openMenu(asg, [asg.dataset.assign]); return; }
    const sendBtn = t.closest('[data-send]');
    if (sendBtn) { try { await busy(sendBtn, () => sendOrders([sendBtn.dataset.send], S().default_courier || 'pathao')); } catch (e) { toast(e.message, true); } return; }
    const sn = t.closest('[data-savenote]');
    if (sn) {
      try {
        await busy(sn, async () => {
          const r = await api(`/orders/${sn.dataset.savenote}/note`, { method: 'POST', body: { note: $('note-input').value } });
          const o = state.orders.find((x) => x.id === sn.dataset.savenote); if (o) o.note = r.note;
          toast(r.note ? 'Note saved' : 'Note removed'); renderOrders();
        });
      } catch (e) { toast(e.message, true); }
      return;
    }
    const opener = t.closest('[data-open]');
    if (opener) { openDetail(opener.dataset.open); if (opener.classList.contains('note-add')) setTimeout(() => { const n = $('note-input'); if (n) n.focus(); }, 30); return; }
    const tr = t.closest('[data-track]');
    if (tr) { try { await busy(tr, async () => { await api(`/orders/${tr.dataset.track}/refresh`, { method: 'POST' }); await loadOrders(); }); } catch (e) { toast(e.message, true); } return; }
    if (t.closest('[data-select]') || t.closest('#check-all')) return;
    const row = t.closest('[data-row]');
    if (row && !t.closest('a,button,input')) { openDetail(row.dataset.row); return; }
    if (t.closest('#bulk-menu-btn')) { openMenu($('bulk-menu-btn'), [...state.selected]); return; }
    const pick = t.closest('[data-pick]');
    if (pick && !pick.disabled) { const ids = state.menuFor || []; closeMenu(); try { await sendOrders(ids, pick.dataset.pick); } catch (e) { toast(e.message, true); } return; }
    if (t.closest('#load-older')) { const b = t.closest('button'); try { await busy(b, loadOlder); } catch (e) { toast(e.message, true); } return; }
    if (t.closest('#bulk-clear')) { state.selected.clear(); renderOrders(); return; }

    // couriers
    const cv = t.closest('[data-cview]');
    if (cv) {
      state.settingsTab = cv.dataset.cview === 'sms' ? 'sms' : 'couriers';
      if (cv.dataset.cview !== 'sms') state.courierView = cv.dataset.cview;
      state.section = undefined;
      renderCouriers(); return;
    }
    const dc = t.closest('[data-defc]');
    if (dc && !dc.disabled) { savePrefs({ default_courier: dc.dataset.defc }); return; }
    const cp = t.closest('[data-copy]');
    if (cp) {
      const el = $(cp.dataset.copy);
      try { await navigator.clipboard.writeText(el.value); toast('Copied'); } catch (e) { el.select(); toast('Press Ctrl+C (⌘C on Mac) to copy'); }
      return;
    }
    const ts = t.closest('[data-toggle-step]');
    if (ts) { const k = ts.dataset.toggleStep; const isOpen = document.querySelector(`.step[data-step="${k}"]`).classList.contains('open'); state.section = isOpen ? null : k; if (!isOpen) fillAccount(); renderCouriers(); return; }
    const wn = t.closest('[data-when]');
    if (wn) { savePrefs({ fulfill_when: wn.dataset.when }); return; }
    if (t.closest('#copy-url')) {
      try { await navigator.clipboard.writeText(state.boot.pathaoWebhook.url); toast('Callback URL copied'); }
      catch (e) { $('wh_url').select(); toast('Press Ctrl+C (⌘C on Mac) to copy the selected URL'); }
      return;
    }
    if (t.closest('#reload-stores')) { const b = t.closest('button'); try { await busy(b, async () => { await loadStores(S().pathao_store_id); renderAll(); toast('Stores reloaded'); }); } catch (e) { toast(e.message, true); } return; }

    // billing
    if (t.closest('#dp-btn')) { if (state.dp) closePicker(); else openPicker(); return; }
    if (state.dp) {
      const pr = t.closest('[data-preset]');
      if (pr) { if (pr.dataset.preset === 'custom') { Object.assign(state.dp, { key: 'custom', picking: 'start' }); renderPicker(); } else setDraft(pr.dataset.preset); return; }
      const nav = t.closest('[data-dpnav]');
      if (nav && !nav.disabled) { const v = state.dp.view; state.dp.view = new Date(v.getFullYear(), v.getMonth() + Number(nav.dataset.dpnav), 1); renderPicker(); return; }
      const dayBtn = t.closest('[data-day]');
      if (dayBtn && !dayBtn.disabled) { pickDay(fromYmd(dayBtn.dataset.day)); return; }
      if (t.closest('#dp-apply')) { applyPicker(); return; }
      if (t.closest('#dp-cancel') || !t.closest('#dp-pop')) { closePicker(); if (t.closest('#dp-cancel')) return; }
      else return;
    }
    if (t.closest('#ov-more')) { setOverviewOpen(!state.ovOpen); return; }
    if (t.closest('[data-fraudcard]')) {
      state.risk = 'high'; state.stage = null; renderOrders();
      document.querySelector('.list').scrollIntoView({ behavior: 'smooth', block: 'start' }); return;
    }
    const per = t.closest('[data-period]');
    if (per) { state.period = per.dataset.period; renderBilling(); return; }

    const b = t.closest('#send-new,#bulk-default,#save-connection,#pathao-disconnect,#save-webhook,#sf-save-webhook,#sf-save,#sf-disconnect,[data-plan],[data-downgrade]');
    if (!b) return;
    try {
      if (b.id === 'send-new') {
        const ids = newReady().map((o) => o.id);
        if (!confirm(`Send ${ids.length} new order${ids.length === 1 ? '' : 's'} to ${cname(defKey())}? High-risk orders are left for you to review.`)) return;
        return await busy(b, () => sendOrders(ids, S().default_courier || 'pathao'));
      }
      if (b.id === 'bulk-default') return await busy(b, () => sendOrders([...state.selected], S().default_courier || 'pathao'));
      if (b.id === 'save-connection') return await busy(b, saveConnection);
      if (b.id === 'sf-save') return await busy(b, saveSteadfast);
      if (b.id === 'pathao-disconnect') {
        if (!confirm('Disconnect Pathao? Orders already sent keep their tracking. If Pathao is your default, Steadfast becomes the default when it is connected; otherwise auto-send turns off.')) return;
        return await busy(b, async () => { apply(await api('/settings', { method: 'POST', body: { pathao_disconnect: true } })); state.section = undefined; fillAccount(); toast('Pathao disconnected'); renderAll(); });
      }
      if (b.id === 'sf-disconnect') {
        if (!confirm('Disconnect Steadfast? Orders already sent keep their tracking. If Steadfast is your default, Pathao becomes the default and auto-send turns off.')) return;
        return await busy(b, async () => { apply(await api('/settings', { method: 'POST', body: { steadfast_disconnect: true } })); state.sfBalance = null; toast('Steadfast disconnected'); renderAll(); });
      }
      if (b.id === 'save-webhook' || b.id === 'sf-save-webhook') return await busy(b, async () => {
        const courier = b.id === 'save-webhook' ? 'pathao' : 'steadfast';
        // Steadfast needs only the Callback URL (no auth token).
        const body = courier === 'pathao' ? { webhook_secret: $('wh_secret').value.trim() } : { steadfast_webhook_saved: true };
        apply(await api('/settings', { method: 'POST', body }));
        state.courierView = courier; state.section = courier === 'pathao' ? 'delivery' : 'sf-delivery';
        await refreshBoot();
        toast('Saved');
      });
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
    if (el.id === 'bulk-all') {
      // Partly selected -> select every sendable order in this tab; all selected -> clear.
      const sendable = visible().filter(canSend);
      const all = sendable.every((o) => state.selected.has(o.id));
      if (all) state.selected.clear(); else sendable.forEach((o) => state.selected.add(o.id));
      renderRows(); return;
    }
    if (el.id === 'check-all') { visible().filter(canSend).forEach((o) => { if (el.checked) state.selected.add(o.id); else state.selected.delete(o.id); }); renderRows(); return; }
    if (['auto_send', 'hold_risky', 'sync_fulfillment', 'notify_customer', 'mark_paid_on_delivery', 'undo_on_return'].includes(el.id)) { savePrefs({ [el.id]: el.checked }); return; }
    if (el.name === 'pathao-speed') { savePrefs({ delivery_type: Number(el.value) }); return; }
    if (el.name === 'sf-type') { savePrefs({ sf_delivery_type: Number(el.value) }); return; }
    if (el.dataset && el.dataset.defbox) {
      if (el.checked) savePrefs({ default_courier: el.dataset.defbox });
      else { el.checked = true; toast('To change the default, tick it on another courier'); }
      return;
    }
    if (el.id === 'dash-auto') { savePrefs({ auto_send: el.checked }); return; }
    if (el.id === 'pathao_store_id' && /^\d+$/.test(el.value)) {
      const name = el.options[el.selectedIndex].textContent.replace(' (inactive)', '');
      api('/settings', { method: 'POST', body: { pathao_store_id: el.value, pathao_store_name: name } }).then((r) => { apply(r); toast('Pickup store saved'); renderAll(); }).catch((e) => toast(e.message, true));
    }
  });
  // Note for rider appears on both couriers' Delivery settings (one shared value).
  ['default_weight', 'default_note', 'sf_default_note'].forEach((id) => $(id).addEventListener('input', () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const w = Number($('default_weight').value);
      if (id === 'default_weight' && !(w >= 0.5 && w <= 10)) { $('prefs-state').textContent = 'Weight must be 0.5–10 kg'; return; }
      savePrefs(id === 'default_weight' ? { default_weight: w } : { default_note: $(id).value }, true);
    }, 700);
  }));
  $('search').addEventListener('input', (e) => { state.search = e.target.value; renderRows(); searchStore(e.target.value); });
  window.addEventListener('resize', closeMenu);
  // ---------------- live updates ----------------
  // The server pushes an event whenever this shop's orders change (new order, Shopify edit,
  // courier update, status check). Redraw straight away; reconnect if the stream drops.
  let liveTimer = null, liveBoot = false;
  function onLive(ev) {
    if (ev && ev.type === 'courier') liveBoot = true;
    clearTimeout(liveTimer);
    liveTimer = setTimeout(async () => {
      const boot = liveBoot; liveBoot = false;
      try {
        if (boot) await refreshBoot();
        if (state.loaded) await loadOrders(); else if (state.page === 'orders') await loadOrders();
      } catch (e) { /* next event or the fallback check will retry */ }
    }, 300);
  }
  async function startLive() {
    for (;;) {
      try {
        const res = await fetch('/api/events', { headers: { Authorization: `Bearer ${await shopify.idToken()}` } });
        if (!res.ok || !res.body) throw new Error(`live updates unavailable (${res.status})`);
        const reader = res.body.getReader(), dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const line = buf.slice(0, i).split('\n').find((l) => l.startsWith('data:'));
            buf = buf.slice(i + 2);
            if (line) { try { onLive(JSON.parse(line.slice(5))); } catch (e) { /* ignore a bad event */ } }
          }
        }
      } catch (e) { /* reconnect below */ }
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  // Safety net if the live connection is down: quiet check every 2 minutes.
  setInterval(() => {
    if (document.visibilityState === 'visible' && state.loaded) loadOrders();
  }, 120000);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (state.dp) { closePicker(); return; } closeMenu(); closeDetail(); } });
  // Typing a date in the Start / End boxes.
  ['dp-from', 'dp-to'].forEach((id) => $(id).addEventListener('change', () => {
    if (!state.dp) return;
    const d = fromYmd($(id).value); if (!d) return;
    const dp = state.dp; dp.key = 'custom';
    if (id === 'dp-from') { dp.from = d; if (dp.to && dp.to < d) dp.to = d; } else { dp.to = d; if (!dp.from || dp.from > d) dp.from = d; }
    dp.picking = 'start'; dp.view = new Date(d.getFullYear(), d.getMonth() - (id === 'dp-to' ? 1 : 0), 1);
    renderPicker();
  }));
  // Webhook updates land in the database instantly; pull them into the screen every 30s.
  setInterval(() => {
    if (document.visibilityState === 'visible' && state.page === 'orders' && state.loaded && !state.selected.size && $('courier-menu').hidden) loadOrders();
  }, 30000);

  async function start() {
    let embedded = true;
    let ovOpen = false; try { ovOpen = localStorage.getItem('sb-ov-open') === '1'; } catch (e) { /* storage blocked */ }
    setOverviewOpen(ovOpen);
    try { embedded = window.top !== window.self; } catch (e) { embedded = true; }
    if (!embedded || !(window.shopify && shopify.idToken)) {
      $('banners').innerHTML = '<div class="banner info"><b>Open AutoCourier BD from your Shopify admin.</b>&nbsp;Go to your store admin → Apps → AutoCourier BD. If it isn\'t listed, install it first.</div>';
      $$('.page').forEach((p) => { p.hidden = true; });
      return;
    }
    showPage(pageFromPath());
    // Start the order list request alongside bootstrap instead of after it.
    const ordersP = state.page === 'orders' ? api('/orders') : null;
    if (ordersP) ordersP.catch(() => {});
    try { await refreshBoot(); fillAccount(); }
    catch (e) { $('banners').innerHTML = `<div class="banner bad"><b>Could not load AutoCourier BD.</b>&nbsp;${esc(e.message)}</div>`; return; }
    if (state.page === 'orders') loadOrders(ordersP);
    startLive();
    if (state.page === 'billing') loadBilling();
  }
  start();
})();
