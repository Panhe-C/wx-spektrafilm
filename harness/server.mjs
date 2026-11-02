import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';

const HARNESS_ROOT = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(HARNESS_ROOT, '..');
export const TEST_PHOTO_ROOT = process.env.TEST_PHOTOS || '/workspace/testphotos';

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
};

function safePath(base, relative) {
  const resolved = path.resolve(base, relative);
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) {
    throw new Error('Path escapes static root');
  }
  return resolved;
}

export async function startServer() {
  const server = http.createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      let filename;
      if (pathname.startsWith('/testphotos/')) {
        filename = safePath(TEST_PHOTO_ROOT, pathname.slice('/testphotos/'.length));
      } else {
        filename = safePath(PROJECT_ROOT, pathname.slice(1));
      }
      const stat = await fs.stat(filename);
      if (!stat.isFile()) {
        throw new Error('Not a file');
      }
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Length': stat.size,
        'Content-Type': MIME_TYPES[path.extname(filename)] || 'application/octet-stream',
      });
      createReadStream(filename).pipe(response);
    } catch (error) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
