import http from 'node:http';

const port = Number(process.env.PORT || 4317);
const base = `http://localhost:${port}`;
const conv_id = 'dev-tension-sse-1';
const text = 'Okay!! Are you serious? This is wild!';

function fetchSSE(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      { method: 'GET', hostname: u.hostname, port: u.port, path: u.pathname + (u.search || '') },
      (res) => {
        let buf = '';
        let startPayload = null;
        let tensionEvt = null;
        let endPayload = null;
        res.on('data', (d) => {
          buf += d.toString();
          const chunks = buf.split(/\r?\n\r?\n/);
          buf = chunks.pop();
          for (const chunk of chunks) {
            const lines = chunk.split(/\r?\n/);
            const typeLine = lines.find((l) => l.startsWith('event:')) || '';
            const dataLine = lines.find((l) => l.startsWith('data:')) || '';
            const evt = typeLine.replace(/^event:\s*/, '').trim();
            const dataStr = dataLine.replace(/^data:\s*/, '').trim();
            if (evt === 'memory.tension') {
              try {
                tensionEvt = JSON.parse(dataStr);
              } catch {}
            } else if (evt === 'start') {
              try {
                startPayload = JSON.parse(dataStr);
              } catch {}
            } else if (evt === 'end') {
              try {
                endPayload = JSON.parse(dataStr);
              } catch {}
            }
          }
          if (endPayload) resolve({ tension: tensionEvt, start: startPayload, end: endPayload });
        });
        res.on('error', reject);
        res.on('end', () => {
          if (!endPayload) resolve({ tension: tensionEvt, start: startPayload, end: null });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

const run = async () => {
  const replay = String(process.env.REPLAY || '').trim();
  const extra = replay ? '&replay=1' : '';
  const url = `${base}/conv/stream?conv_id=${encodeURIComponent(conv_id)}&turn=0&engine=urga&text=${encodeURIComponent(text)}${extra}`;
  const out = await fetchSSE(url);
  console.log('tension_evt', out.tension);
  console.log('start.tension', out.start?.tension, 'beat', out.start?.tension_beat);
  console.log('end.ok', !!out.end);
};

run().catch((e) => {
  console.error('error', e);
  process.exit(1);
});
