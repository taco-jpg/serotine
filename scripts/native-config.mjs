/** Public configuration only. This does not resolve DNS or accept a runtime
 * renderer-selected host; native hosts independently validate the baked value. */
export function validateNativeOrigin(value, { development = true } = {}) {
  const url = new URL(value)
  const host = url.hostname
  const labels = host.split('.')
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.port
    || labels.length < 2 || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
    || !/^[a-z]{2,63}$/i.test(labels.at(-1)) || /(?:^|\.)(?:localhost|local|internal|lan|home|onion)$/i.test(host)) {
    throw new Error('SEROTINE_RELAY_ORIGIN must be a public HTTPS hostname on port 443, with no path, credentials, query or fragment.')
  }
  if (!development && (/(?:^|\.)(?:invalid|test|example)$/i.test(host) || /(?:^|\.)example\.(?:com|net|org)$/i.test(host))) {
    throw new Error('A release requires the deployed relay, not a reserved example or test hostname.')
  }
  return url.origin
}
