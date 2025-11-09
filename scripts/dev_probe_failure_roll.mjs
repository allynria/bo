import http from 'node:http';

const port = Number(process.env.PORT || 3000);
const base = `http://localhost:${port}`;
const conv_id = String(process.env.CONV_ID || 'FR1');
const text = String(process.env.TEXT || 'I try to pick the lock quietly.');

function fetchSSE(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = {
      origin: 'http://ok.test',
      authorization: 'Bearer test-token',
      accept: 'text/event-stream',
    };
    const req = http.request(
      {
        method: 'GET',
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + (u.search || ''),
        headers,
      },
      (res) => {
        let buf = '';
        const events = [];
        res.on('data', (d) => {
          buf += d.toString('utf8');
          const chunks = buf.split(/\r?\n\r?\n/);
          buf = chunks.pop();
          for (const chunk of chunks) {
            const lines = chunk.split(/\r?\n/);
            const evtLine = lines.find((l) => l.startsWith('event:')) || '';
            const dataLine = lines.find((l) => l.startsWith('data:')) || '';
            const evt = evtLine.replace(/^event:\s*/, '').trim();
            const dataStr = dataLine.replace(/^data:\s*/, '').trim();
            events.push({ evt, dataStr });
          }
        });
        res.on('end', () => resolve(events));
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function run() {
  const turn = Number(process.env.TURN || 0);
  const url = `${base}/v1/conv/stream?conv_id=${encodeURIComponent(conv_id)}&turn=${turn}&engine=urga&text=${encodeURIComponent(text)}&ts=${Date.now()}`;
  const events = await fetchSSE(url);
  const start = events.find((e) => e.evt === 'start');
  const roll = events.find((e) => e.evt === 'memory.roll');
  const evalEvt = events.find((e) => e.evt === 'failroll.eval');
  const compEvt = events.find((e) => e.evt === 'memory.fact');
  console.log('start:', start?.dataStr || '(none)');
  console.log('memory.roll:', roll?.dataStr || '(none)');
  console.log('failroll.eval:', evalEvt?.dataStr || '(none)');
  console.log('memory.fact:', compEvt?.dataStr || '(none)');
}

run().catch((e) => {
  console.error('error', e);
  process.exit(1);
});
