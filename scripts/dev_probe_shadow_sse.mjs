import http from 'node:http';

function fetchSSE(url) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const events = [];
    const req = http.request(
      {
        method: 'GET',
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + (u.search || ''),
        headers: { Accept: 'text/event-stream' },
      },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (d) => {
          buf += d.toString();
          const chunks = buf.split('\n\n');
          buf = chunks.pop();
          for (const chunk of chunks) {
            const lines = chunk.split('\n');
            const typeLine = lines.find((l) => l.startsWith('event: ')) || '';
            const dataLine = lines.find((l) => l.startsWith('data: ')) || '';
            const evt = typeLine.replace('event: ', '').trim();
            const dataStr = dataLine.replace('data: ', '').trim();
            let payload = null;
            try {
              payload = JSON.parse(dataStr);
            } catch {}
            if (evt) events.push({ event: evt, payload });
          }
        });
        res.on('end', () => resolve({ status: res.statusCode || 0, events }));
      }
    );
    req.on('error', () => resolve({ status: 0, events: [] }));
    req.end();
  });
}

async function main() {
  const base = process.env.BASE || 'http://127.0.0.1:3105';
  const cid = process.env.CID || 'shadow-sse';
  const t0 = process.env.TEXT0 || "I'm terrified of hiking";
  const t1 = process.env.TEXT1 || 'I love hiking';
  const engine = process.env.ENGINE || 'echo';
  const u0 = `${base}/v1/conv/stream?conv_id=${encodeURIComponent(cid)}&turn=0&engine=${encodeURIComponent(engine)}&text=${encodeURIComponent(t0)}`;
  const s0 = await fetchSSE(u0);
  const u1 = `${base}/v1/conv/stream?conv_id=${encodeURIComponent(cid)}&turn=1&engine=${encodeURIComponent(engine)}&text=${encodeURIComponent(t1)}`;
  const s1 = await fetchSSE(u1);
  const m0 = s0.events.filter((e) => e.event === 'memory.nudge');
  const m1 = s1.events.filter((e) => e.event === 'memory.nudge');
  const end0 = s0.events.find((e) => e.event === 'end');
  const end1 = s1.events.find((e) => e.event === 'end');
  console.log(
    JSON.stringify({
      ok: s0.status === 200 && s1.status === 200,
      turn0: {
        status: s0.status,
        events: s0.events.map((e) => e.event),
        nudgeCount: m0.length,
        final: end0?.payload?.final || '',
      },
      turn1: {
        status: s1.status,
        events: s1.events.map((e) => e.event),
        nudgeCount: m1.length,
        sample: m1[0] || null,
        final: end1?.payload?.final || '',
      },
    })
  );
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
  process.exit(1);
});
