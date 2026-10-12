// Content type and Cache-Control per site file, matching what the live site has always served (S3 object metadata;
// CloudFront honours it). HTML revalidates within a minute, versioned scripts and styles cache for five minutes,
// icons for a day, and the service worker is always revalidated so an update is picked up on the next visit.
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.xml': 'application/xml; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json',
};
export function cachePolicy(key) {
  const ext = key.slice(key.lastIndexOf('.'));
  const contentType = TYPES[ext];
  if (!contentType) throw new Error(`no content type for ${key}`);
  let cacheControl = 'max-age=300';
  if (ext === '.html') cacheControl = 'max-age=60, must-revalidate';
  else if (key === 'sw.js') cacheControl = 'max-age=0, must-revalidate';
  else if (ext === '.png' || ext === '.svg') cacheControl = 'max-age=86400';
  return { contentType, cacheControl };
}
