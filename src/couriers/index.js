// Courier registry. Each courier plugs in here; the dashboard lists them all.
//
// To add a courier later, create src/couriers/<key>.js exposing
//   { key, name, hasCredentials(settings), createOrder(settings, payload), orderInfo(settings, id), listStores(settings) }
// and add it to AVAILABLE below. Until then it shows as "Coming soon".

const AVAILABLE = ['pathao'];

const CATALOG = [
  { key: 'pathao', name: 'Pathao', color: '#E8202A', tagline: 'On-demand logistics and delivery across Bangladesh', region: 'Bangladesh' },
  { key: 'steadfast', name: 'Steadfast', color: '#13A538', tagline: 'Fast and reliable delivery across Bangladesh', region: 'Bangladesh' },
  { key: 'redx', name: 'RedX', color: '#D7263D', tagline: 'Smart logistics for e-commerce businesses', region: 'Bangladesh' },
  { key: 'paperfly', name: 'Paperfly', color: '#1E88E5', tagline: 'End-to-end e-commerce logistics', region: 'Bangladesh' },
  { key: 'carrybee', name: 'Carrybee', color: '#F5A300', tagline: 'Efficient courier service for your business', region: 'Bangladesh' },
  { key: 'bahok', name: 'Bahok', color: '#C2185B', tagline: 'Nationwide parcel delivery with COD', region: 'Bangladesh' },
];

function listCouriers(settings, { pathao }) {
  return CATALOG.map((c) => {
    const available = AVAILABLE.includes(c.key);
    let status = 'coming_soon';
    let detail = null;
    if (available && c.key === 'pathao') {
      const connected = pathao.hasCredentials(settings);
      status = connected && settings.pathao_store_id ? 'connected' : connected ? 'needs_store' : 'not_connected';
      detail = connected
        ? `${settings.pathao_store_name || 'Store #' + settings.pathao_store_id || ''}${settings.pathao_env === 'sandbox' ? ' · Sandbox' : ''}`
        : null;
    }
    return { ...c, available, status, detail, isDefault: c.key === (settings.default_courier || 'pathao') };
  });
}

module.exports = { CATALOG, AVAILABLE, listCouriers };
