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

// A logger with the same methods whose every argument is redacted first.
function redactingLog(log, redact) {
  const wrap = (fn) => (...args) => fn.apply(log, args.map((a) => redact(a instanceof Error ? a.stack || a.message : a)));
  return { info: wrap(log.info || log.log), warn: wrap(log.warn || log.log), error: wrap(log.error || log.log), log: wrap(log.log || log.info) };
}

module.exports = { makeRedactor, secretsOf, redactingLog };
