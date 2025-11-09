import http from 'node:http';

const port = Number(process.env.PORT || 3322);
const conv_id = process.env.CONV_ID || 'FR2';
const text = process.env.TEXT || 'I pick the lock at the Old Harbor Library at dusk.';
const turn = Number(process.env.TURN || 0);
const base = `http://127.0.0.1:${port}`;
const url = `${base}/v1/conv/stream?conv_id=${encodeURIComponent(conv_id)}&turn=${turn}&engine=urga&text=${encodeURIComponent(text)}&ts=${Date.now()}`;

const headers = {
  origin: 'http://ok.test',
  authorization: 'Bearer test-token',
  accept: 'text/event-stream'
};

console.log('GET', url);
const req = http.request(url, { method: 'GET', headers }, (res) => {
  let buf = '';
  res.on('data', (d) => {
    buf += d.toString('utf8');
    const parts = buf.split(/\n\n+/);
    buf = parts.pop();
    for (const p of parts) {
      console.log('---SEGMENT---');
      console.log(p);
      if (p.includes('memory.beliefs')) {
        console.log('---DETECTED memory.beliefs---');
      }
    }
  });
  res.on('end', () => process.exit(0));
});
req.on('error', (e) => { console.error('ERR', e.message); process.exit(1); });
req.end();
