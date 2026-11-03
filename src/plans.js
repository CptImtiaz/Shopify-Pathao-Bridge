// Subscription plans. Edit prices/limits here. Prices are in USD because
// Shopify bills app charges in USD.

const PLANS = {
  free: {
    key: 'free',
    name: 'Free',
    price: 0,
    monthlyOrderLimit: 50,
    features: ['50 orders / month', 'Auto-send new orders', 'Fraud check on every order', 'Bulk send & retry', 'Delivery status sync'],
  },
  pro: {
    key: 'pro',
    name: 'Pro',
    price: 9.99,
    trialDays: 7,
    monthlyOrderLimit: null, // unlimited
    features: ['Unlimited orders', 'Everything in Free', 'Priority support'],
  },
};

// Name used for the Shopify subscription. Must stay stable: we match on it.
function subscriptionName(planKey) {
  return `ShipBridge ${PLANS[planKey].name}`;
}

function planFromSubscriptionName(name) {
  for (const plan of Object.values(PLANS)) {
    if (plan.price > 0 && subscriptionName(plan.key) === name) return plan.key;
  }
  return 'free';
}

module.exports = { PLANS, subscriptionName, planFromSubscriptionName };
