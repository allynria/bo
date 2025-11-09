import http from 'node:http';

export async function waitForUp(base, opts = {}) {
  const path = String(opts.path || '/healthz');
  const timeout = Number(opts.timeout || 3000);
  const intervalMs = Number(opts.intervalMs || 100);
  const headers = opts.headers || {};
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(`${base}${path}`, { headers }, (res) => {
          // Consume and ignore body
          res.resume();
          res.on('end', () => {
            if (res.statusCode === 200) resolve();
            else reject(new Error(String(res.statusCode)));
          });
        });
        req.on('error', reject);
      });
      return true;
    } catch {}
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('service did not start');
}
