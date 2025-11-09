import http from 'node:http';

const port = Number(process.env.PORT || 3000);
const base = `http://127.0.0.1:${port}`;
const url = `${base}/v1/conv/stream?conv_id=demo&turn=1&engine=urga&text=${encodeURIComponent('I try to pick the lock quietly.')}&ts=${Date.now()}`;

const headers = {
  origin: 'http://ok.test',
  authorization: 'Bearer test-token',
  accept: 'text/event-stream',
};

const req = http.request(url, { method: 'GET', headers }, (res) => {
  let buf = '';
  let n = 0;
  res.on('data', (d) => {
    buf += d.toString('utf8');
    const parts = buf.split(/\n\n+/);
    buf = parts.pop();
    for (const p of parts) {
      console.log('---SEGMENT---');
      console.log(p);
      if (p.includes('memory.contradiction')) {
        console.log('---DETECTED memory.contradiction---');
      }
      ++n;
    }
  });
  res.on('end', () => process.exit(0));
});
req.on('error', (e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
req.end();
