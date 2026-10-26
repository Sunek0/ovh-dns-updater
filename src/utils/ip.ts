const IPV4_REGEX =
  /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

/**
 * Returns true when `value` is a valid dotted-quad IPv4 address.
 * The application only manages OVH "A" records, so IPv6 is intentionally rejected.
 */
export function isValidIPv4(value: unknown): value is string {
  return typeof value === 'string' && IPV4_REGEX.test(value);
}
