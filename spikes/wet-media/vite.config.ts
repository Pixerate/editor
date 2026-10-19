import { appendFileSync, mkdirSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';

// SharedArrayBuffer (wasm threads) needs cross-origin isolation.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

/** POST /__result appends a JSON line to results/manual.jsonl (for browsers we can't automate). */
function resultSink(): Plugin {
  return {
    name: 'result-sink',
    configureServer(server) {
      server.middlewares.use('/__result', (req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          mkdirSync('results', { recursive: true });
          appendFileSync('results/manual.jsonl', body.replace(/\n/g, ' ') + '\n');
          res.end('ok');
        });
      });
    },
  };
}

export default defineConfig({
  server: { port: 5199, strictPort: true, headers: isolation },
  preview: { port: 5199, headers: isolation },
  worker: { format: 'es' },
  build: { target: 'es2022' },
  plugins: [resultSink()],
});
