// Turns any error into what the browser may see. Messages written for merchants (courier refusals,
// Shopify's own "can't fulfill" reasons, validation) are shown as they are. Anything that looks
// internal (database, network, programming errors, file paths, SQL) becomes a generic message.
// Every error gets a short reference code that is also in the server log, so a merchant can quote it.
const crypto = require('crypto');

const PROGRAMMING = new Set(['TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'EvalError', 'URIError', 'AggregateError']);
const INTERNAL_TEXT = /node_modules|(?:\/[\w.-]+){2,}\.(?:js|mjs|cjs)\b|\bat \S+ \(|\bSELECT\b|\bINSERT INTO\b|\bUPDATE \w+ SET\b|\bDELETE FROM\b|relation "|column "|syntax error at|ECONN|ENOTFOUND|EAI_AGAIN|getaddrinfo|socket hang up/i;

function looksInternal(e) {
  if (!e || !e.message) return true;
  if (PROGRAMMING.has(e.name)) return true;
  if (e.severity && e.routine) return true; // node-postgres error
  if (typeof e.code === 'string' && /^(?:[0-9A-Z]{5}|E[A-Z_]{2,})$/.test(e.code)) return true; // SQLSTATE / Node system error
  return INTERNAL_TEXT.test(e.message);
}

const newRef = () => crypto.randomBytes(4).toString('hex').toUpperCase();

function publicError(e, redact = (t) => String(t)) {
  const ref = newRef();
  const status = e && Number.isInteger(e.status) && e.status >= 400 && e.status < 600 ? e.status : 500;
  let message;
  if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
    message = "The courier or Shopify took too long to answer. Try again in a minute.";
  } else if (looksInternal(e)) {
    message = `Something went wrong on our side. Try again in a minute. If it keeps happening, send us code ${ref}.`;
  } else {
    message = redact(e.message);
  }
  return { status, ref, body: { error: message, ref } };
}

module.exports = { publicError, looksInternal, newRef };
