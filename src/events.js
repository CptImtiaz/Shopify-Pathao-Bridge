// Live updates for open dashboards.
//
// Anything that changes a shop's orders (new order, Shopify order edit, courier
// webhook, status check, booking) calls publish(shop, type). Every dashboard of
// that shop that is open has a streaming request on /api/events and redraws
// straight away. One app instance, so an in-memory list of listeners is enough.

function makeBus() {
  const listeners = new Map(); // shop -> Set<fn>

  function subscribe(shop, fn) {
    if (!listeners.has(shop)) listeners.set(shop, new Set());
    listeners.get(shop).add(fn);
    return () => {
      const set = listeners.get(shop);
      if (!set) return;
      set.delete(fn);
      if (!set.size) listeners.delete(shop);
    };
  }

  function publish(shop, type = 'orders') {
    const set = listeners.get(shop);
    if (!set) return 0;
    for (const fn of set) { try { fn(type); } catch { /* a closed stream must not break others */ } }
    return set.size;
  }

  const count = (shop) => (listeners.get(shop) || new Set()).size;
  return { subscribe, publish, count };
}

module.exports = { makeBus };
