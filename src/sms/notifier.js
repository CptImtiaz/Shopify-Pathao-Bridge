// Decides whether a new order gets a confirmation SMS, and sends it once.

const { sourceAllowed, buildOrderSms, csmsIdFor, SOURCES } = require('./sms');

// SSL Wireless rejects calls from servers it doesn't recognise; make that obvious.
function friendlyError(msg) {
  if (/ip|whitelist|white list|unauthori[sz]ed|forbidden|not allowed/i.test(msg)) {
    return `${msg} — SSL Wireless may be blocking this server's IP address. Ask them to allow your API token without IP restriction.`;
  }
  return msg;
}

function makeNotifier({ db, cipher, smsClient, log = console }) {
  function configured(s) {
    return Boolean(s.sms_token_enc && s.sms_sid);
  }

  // Returns a reason string if the order should NOT get an SMS.
  function skipReason(order, s) {
    if (!s.sms_enabled) return 'SMS is off';
    if (!configured(s)) return 'SMS account not set up';
    if (order.cancelled_at) return 'Order is cancelled';
    if (s.sms_since && order.created_at && new Date(order.created_at) < new Date(s.sms_since)) {
      return 'Order was created before SMS was turned on';
    }
    if (!sourceAllowed(s.sms_source, order.source_name)) {
      const label = (SOURCES[s.sms_source] || SOURCES.web).label;
      const kind = { web: 'Online store order', shopify_draft_order: 'Manual order', pos: 'POS order' }[order.source_name] || `"${order.source_name || 'unknown'}" order`;
      return `${kind}; SMS is set to ${label.toLowerCase()}`;
    }
    return null;
  }

  // `order` is the raw orders/create webhook payload.
  async function onOrderCreated(shop, order) {
    const s = await db.getSettings(shop);
    const reason = skipReason(order, s);
    if (reason) {
      // Don't clutter the log for the common "off" / "old order" cases.
      if (s.sms_enabled && configured(s) && !/before SMS was turned on/.test(reason)) {
        await db.recordSmsSkip(shop, order.id, reason, order.name);
      }
      return { sent: false, reason };
    }

    const claimed = await db.claimSms(shop, order.id, order.name);
    if (!claimed) return { sent: false, reason: 'Already sent' };

    const { phone, text, rawPhone } = buildOrderSms(order, s.sms_template);
    if (!phone) {
      const msg = rawPhone ? `Phone "${rawPhone}" isn't a Bangladesh mobile number` : 'Order has no phone number';
      await db.finishSms(shop, order.id, 'failed', msg);
      return { sent: false, reason: msg };
    }
    try {
      await smsClient.send({ token: cipher.decrypt(s.sms_token_enc), sid: s.sms_sid }, phone, text, csmsIdFor(order.id));
      await db.finishSms(shop, order.id, 'sent', null, phone);
      log.info(`[${shop}] SMS sent for ${order.name}`);
      return { sent: true };
    } catch (e) {
      await db.finishSms(shop, order.id, 'failed', friendlyError(e.message), phone);
      log.error(`[${shop}] SMS for ${order.name} failed: ${e.message}`);
      return { sent: false, reason: e.message };
    }
  }

  async function sendTest(shop, phone) {
    const s = await db.getSettings(shop);
    if (!configured(s)) throw Object.assign(new Error('Add your SSL Wireless API token and SID first'), { status: 400 });
    const { smsPhone } = require('./sms');
    const to = smsPhone(phone);
    if (!to) throw Object.assign(new Error('Enter a valid Bangladesh mobile number, e.g. 01712345678'), { status: 400 });
    const text = 'Test SMS from AutoCourier BD for Pathao. Your SMS notifications are working.';
    try {
      await smsClient.send({ token: cipher.decrypt(s.sms_token_enc), sid: s.sms_sid }, to, text, csmsIdFor(`t${Date.now()}`));
    } catch (e) {
      throw Object.assign(new Error(friendlyError(e.message)), { status: 502 });
    }
    return { to };
  }

  return { onOrderCreated, sendTest, skipReason, configured };
}

module.exports = { makeNotifier };
