// Courier registry. Each courier plugs in here; the dashboard lists them all.
//
// To add a courier: create src/couriers/<key>.js (see steadfast.js), wire it into
// shipping.js (booking), routes/api.js (settings + status refresh) and
// routes/webhooks.js (status webhook), then add it to AVAILABLE below.
// Until then it shows as "Coming soon".

const AVAILABLE = ['pathao', 'steadfast'];

const CATALOG = [
  { key: 'pathao', name: 'Pathao', color: '#E8202A', tagline: 'Delivery across Bangladesh', region: 'Bangladesh' },
  { key: 'steadfast', name: 'Steadfast', color: '#13A538', tagline: 'Delivery across Bangladesh', region: 'Bangladesh' },
  { key: 'redx', name: 'RedX', color: '#D7263D', tagline: 'Nationwide courier', region: 'Bangladesh' },
  { key: 'paperfly', name: 'Paperfly', color: '#1E88E5', tagline: 'E-commerce delivery', region: 'Bangladesh' },
  { key: 'carrybee', name: 'Carrybee', color: '#F5A300', tagline: 'Parcel delivery', region: 'Bangladesh' },
  { key: 'bahok', name: 'Bahok', color: '#C2185B', tagline: 'Nationwide COD delivery', region: 'Bangladesh' },
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
        ? `${settings.pathao_store_name || 'Pickup store #' + settings.pathao_store_id || ''}${settings.pathao_env === 'sandbox' ? ' · Sandbox' : ''}`
        : null;
    }
    if (available && c.key === 'steadfast') {
      status = settings.steadfast_api_key && settings.steadfast_secret_enc ? (settings.steadfast_auth_error ? 'needs_keys' : 'connected') : 'not_connected';
      detail = status === 'connected' ? 'API connected' : status === 'needs_keys' ? 'Keys rejected' : null;
    }
    return { ...c, available, status, detail, isDefault: c.key === (settings.default_courier || 'pathao') };
  });
}

const COURIER_NAMES = Object.fromEntries(CATALOG.map((c) => [c.key, c.name]));

module.exports = { CATALOG, AVAILABLE, COURIER_NAMES, listCouriers };
