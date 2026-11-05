// Keeps secrets out of logs and API answers.
//
// Any text that leaves the server (a log line, an error message sent to the browser) goes
// through redact(): the app's own secrets are blanked by value, and common credential shapes
// (connection strings with a password, bearer tokens, key=value pairs, Shopify tokens) by pattern.

const PATTERNS = [
  [/((?:postgres(?:ql)?|mongodb(?:\+srv)?|mysql|redis):\/\/)[^@\s'"]+@/gi, '$1[redacted]@'],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[redacted]'],
  [/((?:access_token|refresh_token|client_secret|password|secret[_-]?key|api[_-]?key|webhook_secret|token)"?\s*[:=]\s*"?)[^"\s,}&]{4,}/gi, '$1[redacted]'],
  [/\bshp(?:at|ss|ca|pa|ua)_[A-Za-z0-9]+/g, '[redacted]'],
];

// Personal data that must never reach the logs (the merchant still sees it in the dashboard).
const PII_PATTERNS = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[REDACTED email]'],
  // Bangladeshi mobiles in any common spelling (+880 / 880 / 0 prefix, spaces or dashes).
  [/(?:\+?88[\s-]?)?0?1[3-9]\d{2}[\s-]?\d{3}[\s-]?\d{3}\b/g, '[REDACTED phone]'],
  // Any quoted value after the word "Phone" (invalid numbers are personal data too).
  [/(phone\s*"?)[^"\s]*"/gi, '$1[REDACTED]"'],
];
const redactPII = (text) => PII_PATTERNS.reduce((s, [re, to]) => s.replace(re, to), String(text));

function makeRedactor(secrets = []) {
  const exact = [...new Set(secrets.filter((v) => v && String(v).length >= 6).map(String))]
    .sort((a, b) => b.length - a.length);
  return function redact(text) {
    let s = String(text);
    for (const v of exact) s = s.split(v).join('[redacted]');
    for (const [re, to] of PATTERNS) s = s.replace(re, to);
    return s;
  };
}

// The app's own secrets, read from config (which reads them from environment variables).
const secretsOf = (config) => [config.shopifyApiSecret, config.encryptionKey, config.adminPassword, config.databaseUrl, config.pathaoIntegrationSecret];

// A logger with the same methods whose every argument is redacted first: secrets and personal data.
function redactingLog(log, redact) {
  const clean = (a) => redactPII(redact(a instanceof Error ? a.stack || a.message : a));
  const wrap = (fn) => (...args) => fn.apply(log, args.map(clean));
  return { info: wrap(log.info || log.log), warn: wrap(log.warn || log.log), error: wrap(log.error || log.log), log: wrap(log.log || log.info) };
}

module.exports = { makeRedactor, secretsOf, redactingLog, redactPII };
