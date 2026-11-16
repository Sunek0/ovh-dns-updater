const IPV4_REGEX =
  /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

/**
 * Returns true when `value` is a valid dotted-quad IPv4 address.
 * The application only manages OVH "A" records, so IPv6 is intentionally rejected.
 */
export function isValidIPv4(value: unknown): value is string {
  return typeof value === 'string' && IPV4_REGEX.test(value);
}

/**
 * Returns true when `value` is a globally routable IPv4 address.
 * Detected addresses must be public: a captive portal or a misconfigured
 * provider returning a private/loopback address must never reach OVH.
 */
export function isPublicIPv4(value: unknown): value is string {
  if (!isValidIPv4(value)) return false;

  const [first, second, third] = value.split('.').map(Number);

  if (first === 0 || first === 10 || first === 127 || first >= 224) return false;
  if (first === 100 && second >= 64 && second <= 127) return false;
  if (first === 169 && second === 254) return false;
  if (first === 172 && second >= 16 && second <= 31) return false;
  if (first === 192 && second === 0 && (third === 0 || third === 2)) return false;
  if (first === 192 && second === 88 && third === 99) return false;
  if (first === 192 && second === 168) return false;
  if (first === 198 && (second === 18 || second === 19)) return false;
  if (first === 198 && second === 51 && third === 100) return false;
  if (first === 203 && second === 0 && third === 113) return false;

  return true;
}
