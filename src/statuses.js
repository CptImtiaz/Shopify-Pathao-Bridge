// Courier statuses shared by the tracker and the database layer.

// Final statuses: nothing more will happen to these parcels.
const DONE = /^(order\.)?(delivered|partial[_-]delivered|partial[_-]delivery|cancelled|returned|paid[_-]return|pickup[_-]cancell?ed|cancelled_return_received|partial_delivered_return_received)$/i;

// Pathao's status check says "Pickup_Cancelled", its webhook "pickup-cancelled": store one form.
const pathaoSlug = (s) => (s ? String(s).trim().toLowerCase().replace(/^order\./, '').replace(/[\s_]+/g, '-') : s);

const isFinished = (status) => DONE.test(String(status || ''));

module.exports = { DONE, pathaoSlug, isFinished };
