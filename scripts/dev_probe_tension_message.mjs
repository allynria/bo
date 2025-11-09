import http from 'node:http';

const port = Number(process.env.PORT || 4317);
const base = `http://localhost:${port}`;
const body = {
  text: 'This is intense! What do you think?!',
  conv_id: 'dev-tension-1',
  turn: 0,
  engine: 'urga',
};

function postJson(url, data) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(JSON.stringify(data || {}));
    const u = new URL(url);
    const req = http.request(
      {
        method: 'POST',
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        headers: { 'Content-Type': 'application/json', 'Content-Length': buf.length },
      },
      (res) => {
        let out = '';
        res.on('data', (d) => {
          out += d.toString();
        });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(out || '{}') });
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

const run = async () => {
  const res = await postJson(`${base}/conv/message`, body);
  console.log('status', res.status);
  console.log('tension', res.json?.tension, 'beat', res.json?.tension_beat);
  console.log('keys', Object.keys(res.json || {}));
};

run().catch((e) => {
  console.error('error', e);
  process.exit(1);
});
