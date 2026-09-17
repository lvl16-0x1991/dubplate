const secrets = new Set();
let sink = () => {};
const listeners = new Set();

export function setLogSecret(value) {
  if (value) secrets.add(value);
  else secrets.clear();
}

export function redact(value) {
  let text = String(value ?? '');
  for (const secret of secrets) text = text.replaceAll(secret, '[REDACTED]');
  return text
    .replace(/(?:mfa\.[A-Za-z0-9_-]{20,}|[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{20,})/g, '[REDACTED]')
    .replace(/(Authorization\s*[:=]\s*(?:Bot|Bearer)\s+)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
}

export function setLogSink(fn) {
  if (typeof fn !== 'function') throw new TypeError('Log sink must be a function.');
  sink = fn;
}

export function subscribeLogs(fn) {
  if (typeof fn !== 'function') throw new TypeError('Log listener must be a function.');
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(level, message, error) {
  const entry = Object.freeze({ timestamp: new Date().toISOString(), level,
    message: redact(`${message}${error ? `: ${error.message ?? error}` : ''}`) });
  for (const output of [sink, ...listeners]) {
    try { output(entry); } catch { /* A consumer must not interrupt audio or token redaction. */ }
  }
}

export const log = {
  debug: (message) => emit('debug', message),
  info: (message) => emit('info', message),
  warn: (message, error) => emit('warn', message, error),
  error: (message, error) => emit('error', message, error),
};
