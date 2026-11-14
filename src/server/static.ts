import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
};

const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

/** Serves the built web app; any unknown page path gets index.html so the app's own routing takes over. */
export function staticAssets(dir: string) {
  const root = resolve(dir);
  const file = async (path: string) => {
    const full = resolve(join(root, path));
    if (full !== root && !full.startsWith(root + sep)) return null;
    try { return (await stat(full)).isFile() ? full : null; } catch { return null; }
  };
  return {
    async fetch(req: Request): Promise<Response> {
      if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
      let path: string;
      try { path = decodeURIComponent(new URL(req.url).pathname); } catch { return new Response('Bad request', { status: 400 }); }
      let found = await file(path);
      if (!found && !extname(path)) found = await file('index.html');
      if (!found) return new Response('Not found', { status: 404, headers: SECURITY });
      const ext = extname(found).toLowerCase();
      const hashed = path.startsWith('/assets/');
      const headers = {
        ...SECURITY,
        'Content-Type': TYPES[ext] || 'application/octet-stream',
        'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
      };
      return new Response(req.method === 'HEAD' ? null : await readFile(found), { headers });
    },
  };
}
