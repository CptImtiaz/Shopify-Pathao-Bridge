// Thin GraphQL Admin API client plus the queries/mutations the app uses.

const { PLANS, subscriptionName, planFromSubscriptionName } = require('../plans');

function makeAdmin({ config, tokens, fetchImpl = fetch }) {
  async function graphql(shop, query, variables = {}, opts = {}) {
    const token = await tokens.getAccessToken(shop, opts);
    const res = await fetchImpl(`https://${shop}/admin/api/${config.shopifyApiVersion}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({ query, variables }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.errors) {
      const msg = body.errors ? JSON.stringify(body.errors).slice(0, 300) : `HTTP ${res.status}`;
      const err = new Error(`Shopify GraphQL error: ${msg}`);
      err.status = res.status === 401 ? 401 : 502;
      throw err;
    }
    return body.data;
  }

  // ---------------- orders ----------------

  const ORDER_FIELDS = `
    id legacyResourceId name createdAt note tags phone
    displayFinancialStatus cancelledAt
    totalPriceSet { shopMoney { amount currencyCode } }
    totalOutstandingSet { shopMoney { amount } }
    shippingAddress { name firstName lastName phone address1 address2 city province zip country countryCodeV2 }
    billingAddress { name phone }
    lineItems(first: 100) { nodes { title quantity } }`;
  // Only order + shipping-address fields: needs read_orders and the Name/Phone/Address
  // protected fields, nothing else. (Weights come from the orders/create webhook,
  // which includes grams; dashboard sends use the default weight.)

  async function listRecentOrders(shop, opts, first = 30) {
    const data = await graphql(
      shop,
      `query RecentOrders($first: Int!) {
        orders(first: $first, sortKey: CREATED_AT, reverse: true) { nodes { ${ORDER_FIELDS} } }
      }`,
      { first },
      opts
    );
    return data.orders.nodes;
  }

  async function getOrder(shop, legacyId, opts) {
    const data = await graphql(
      shop,
      `query OneOrder($id: ID!) { order(id: $id) { ${ORDER_FIELDS} } }`,
      { id: `gid://shopify/Order/${legacyId}` },
      opts
    );
    return data.order;
  }

  // Tag the order and store the consignment ID in a metafield so merchants
  // can see/search it in the Shopify admin.
  async function annotateOrder(shop, legacyId, { tags = [], consignmentId }) {
    const id = `gid://shopify/Order/${legacyId}`;
    if (tags.length) {
      const d = await graphql(
        shop,
        `mutation Tag($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { message } } }`,
        { id, tags }
      );
      const errs = d.tagsAdd.userErrors;
      if (errs.length) throw new Error(errs.map((e) => e.message).join('; '));
    }
    if (consignmentId) {
      const d = await graphql(
        shop,
        `mutation Meta($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { userErrors { message } } }`,
        { m: [{ ownerId: id, namespace: 'pathao', key: 'consignment_id', type: 'single_line_text_field', value: String(consignmentId) }] }
      );
      const errs = d.metafieldsSet.userErrors;
      if (errs.length) throw new Error(errs.map((e) => e.message).join('; '));
    }
  }

  async function removeTags(shop, legacyId, tags) {
    await graphql(
      shop,
      `mutation Untag($id: ID!, $tags: [String!]!) { tagsRemove(id: $id, tags: $tags) { userErrors { message } } }`,
      { id: `gid://shopify/Order/${legacyId}`, tags }
    );
  }

  // ---------------- webhooks (registered by the app itself) ----------------
  // Shop-level subscriptions, created on app open. Safe to call repeatedly:
  // only missing or wrongly-addressed topics are (re)created.
  const APP_WEBHOOKS = [
    ['ORDERS_CREATE', '/webhooks/orders/create'],
    ['APP_UNINSTALLED', '/webhooks/app/uninstalled'],
    ['APP_SUBSCRIPTIONS_UPDATE', '/webhooks/app_subscriptions/update'],
  ];

  async function ensureWebhooks(shop, opts) {
    const data = await graphql(shop, `{ webhookSubscriptions(first: 50) { nodes { id topic uri } } }`, {}, opts);
    const existing = data.webhookSubscriptions.nodes || [];
    const created = [];
    for (const [topic, path] of APP_WEBHOOKS) {
      const uri = `${config.appUrl}${path}`;
      if (existing.some((w) => w.topic === topic && w.uri === uri)) continue;
      // Remove stale subscriptions for this topic pointing somewhere else.
      for (const w of existing.filter((x) => x.topic === topic && x.uri !== uri)) {
        await graphql(shop, `mutation Del($id: ID!) { webhookSubscriptionDelete(id: $id) { userErrors { message } } }`, { id: w.id }, opts);
      }
      const r = await graphql(
        shop,
        `mutation Sub($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
          webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) { webhookSubscription { id } userErrors { field message } }
        }`,
        { topic, sub: { uri, format: 'JSON' } },
        opts
      );
      const errs = r.webhookSubscriptionCreate.userErrors;
      if (errs.length) throw new Error(`Webhook ${topic}: ${errs.map((e) => e.message).join('; ')}`);
      created.push(topic);
    }
    return created;
  }

  // ---------------- billing (Shopify Billing API) ----------------

  async function activePlan(shop, opts) {
    const data = await graphql(
      shop,
      `{ currentAppInstallation { activeSubscriptions { id name status test trialDays currentPeriodEnd } } }`,
      {},
      opts
    );
    const sub = (data.currentAppInstallation.activeSubscriptions || []).find((s) => s.status === 'ACTIVE');
    return sub ? { plan: planFromSubscriptionName(sub.name), subscription: sub } : { plan: 'free', subscription: null };
  }

  async function createSubscription(shop, planKey, opts) {
    const plan = PLANS[planKey];
    if (!plan || plan.price <= 0) throw new Error('Unknown paid plan');
    const storeHandle = shop.replace('.myshopify.com', '');
    const returnUrl = `https://admin.shopify.com/store/${storeHandle}/apps/${config.appHandle}`;
    const data = await graphql(
      shop,
      `mutation Sub($name: String!, $returnUrl: URL!, $trialDays: Int, $test: Boolean, $lineItems: [AppSubscriptionLineItemInput!]!) {
        appSubscriptionCreate(name: $name, returnUrl: $returnUrl, trialDays: $trialDays, test: $test, lineItems: $lineItems) {
          confirmationUrl
          appSubscription { id }
          userErrors { field message }
        }
      }`,
      {
        name: subscriptionName(planKey),
        returnUrl,
        trialDays: plan.trialDays || 0,
        test: config.billingTest,
        lineItems: [{ plan: { appRecurringPricingDetails: { price: { amount: plan.price, currencyCode: 'USD' }, interval: 'EVERY_30_DAYS' } } }],
      },
      opts
    );
    const r = data.appSubscriptionCreate;
    if (r.userErrors.length) throw new Error(r.userErrors.map((e) => e.message).join('; '));
    return r.confirmationUrl;
  }

  async function cancelSubscription(shop, subscriptionId, opts) {
    const data = await graphql(
      shop,
      `mutation Cancel($id: ID!) { appSubscriptionCancel(id: $id) { userErrors { message } } }`,
      { id: subscriptionId },
      opts
    );
    const errs = data.appSubscriptionCancel.userErrors;
    if (errs.length) throw new Error(errs.map((e) => e.message).join('; '));
  }

  return { graphql, listRecentOrders, getOrder, annotateOrder, removeTags, activePlan, createSubscription, cancelSubscription, ensureWebhooks };
}

module.exports = { makeAdmin };
