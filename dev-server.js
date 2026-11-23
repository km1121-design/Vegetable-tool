/**
 * 手元で動かすための小さなサーバー（npm run dev → http://localhost:8788）。
 * public/ を配り、/api/<名前> を api/<名前>.js へつなぐ。環境変数は .dev.vars（KEY=値 の行）から読む。
 * 本番は Cloudflare Pages（functions/api/[[route]].js）が同じ役をする。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = path.dirname(new URL(import.meta.url).pathname);
if (fs.existsSync(path.join(root, '.dev.vars'))) {
  for (const line of fs.readFileSync(path.join(root, '.dev.vars'), 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (match) process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  const route = url.pathname.match(/^\/api\/([a-z0-9-]+)$/)?.[1];
  if (route) {
    const file = path.join(root, 'api', `${route}.js`);
    if (!fs.existsSync(file)) { res.writeHead(404).end('{}'); return; }
    let text = '';
    for await (const chunk of req) text += chunk;
    let status = 200;
    const headers = { 'Content-Type': 'application/json; charset=utf-8' };
    const response = {
      setHeader(key, value) { headers[key] = value; return response; },
      status(code) { status = code; return response; },
      json(data) { res.writeHead(status, headers).end(JSON.stringify(data)); return response; },
    };
    const { default: handler } = await import(file);
    await handler({ method: req.method, url: req.url, query: Object.fromEntries(url.searchParams), headers: req.headers, body: text ? JSON.parse(text) : {} }, response);
    return;
  }
  const file = path.join(root, 'public', url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
  if (!file.startsWith(path.join(root, 'public')) || !fs.existsSync(file)) { res.writeHead(404).end('not found'); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' }).end(fs.readFileSync(file));
}).listen(Number(process.env.PORT) || 8788, () => console.log(`http://localhost:${Number(process.env.PORT) || 8788}`));
