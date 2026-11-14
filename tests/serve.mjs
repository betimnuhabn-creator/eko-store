// Tiny static server for the web export with single-page-app fallback.
//   node tests/serve.mjs [dir] [port]
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const root = process.argv[2] ?? 'dist';
const port = Number(process.argv[3] ?? 8081);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.ttf': 'font/ttf' };

createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  let file = join(root, path);
  try {
    if (!(await stat(file)).isFile()) throw 0;
  } catch {
    file = join(root, 'index.html');
  }
  res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' });
  res.end(await readFile(file));
}).listen(port, () => console.log(`http://localhost:${port}`));
