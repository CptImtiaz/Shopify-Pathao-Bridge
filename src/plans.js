// Subscription plans. Edit prices/limits here. Prices are in USD because
// Shopify bills app charges in USD.

const PLANS = {
  free: {
    key: 'free',
    name: 'Free',
    price: 0,
    yearlyPrice: 0,
    monthlyOrderLimit: 50,
    tagline: 'For trying ShipBridge',
    features: ['50 orders a month', 'Auto-send, bulk send & retry', 'Fraud check on every order', 'Live delivery status in Shopify'],
  },
  starter: {
    key: 'starter',
    name: 'Starter',
    price: 4.99,
    yearlyPrice: 49.9,
    trialDays: 7,
    monthlyOrderLimit: 300,
    tagline: 'For growing stores',
    features: ['300 orders a month', 'Every feature in Free', 'Email support'],
  },
  pro: {
    key: 'pro',
    name: 'Pro',
    price: 9.99,
    yearlyPrice: 99.9,
    trialDays: 7,
    monthlyOrderLimit: null, // unlimited
    featured: true,
    tagline: 'For busy stores',
    features: ['Unlimited orders', 'Every feature in Free', 'New couriers as they launch', 'Priority support'],
  },
};

const INTERVALS = { monthly: 'EVERY_30_DAYS', yearly: 'ANNUAL' };

// Name used for the Shopify subscription. Must stay stable: we match on it.
function subscriptionName(planKey, interval = 'monthly') {
  return `ShipBridge ${PLANS[planKey].name}${interval === 'yearly' ? ' (yearly)' : ''}`;
}

function planFromSubscriptionName(name) {
  for (const plan of Object.values(PLANS)) {
    if (plan.price > 0 && (subscriptionName(plan.key) === name || subscriptionName(plan.key, 'yearly') === name)) return plan.key;
  }
  return 'free';
}

function intervalFromSubscriptionName(name) {
  return /\(yearly\)$/.test(String(name || '')) ? 'yearly' : 'monthly';
}

module.exports = { PLANS, INTERVALS, subscriptionName, planFromSubscriptionName, intervalFromSubscriptionName };
