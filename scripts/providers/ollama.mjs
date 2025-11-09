// Minimal Ollama provider wrapper for chat-style requests
// Uses Ollama's /api/chat endpoint to preserve role-based messages

export async function chat({ host = 'http://127.0.0.1:11434', model, messages = [], options = {}, stream = false } = {}) {
  const m = String(model || '').trim();
  if (!m) throw new Error('ollama_model_missing');
  const url = String(host || '').trim().replace(/\/$/, '') + '/api/chat';
  const payload = {
    model: m,
    messages: Array.isArray(messages) ? messages : [],
    stream: !!stream,
    options: options && typeof options === 'object' ? options : undefined,
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    let text = '';
    try { text = await res.text(); } catch {}
    throw new Error(`ollama_error_${res.status}: ${text}`);
  }
  const data = await res.json();
  // Non-streaming: Ollama returns an object with message.content or a list of responses
  let output = '';
  try {
    if (data && data.message && typeof data.message.content === 'string') {
      output = data.message.content;
    } else if (typeof data.response === 'string') {
      output = data.response;
    }
  } catch {}
  return { provider: 'ollama', model: m, output, raw: data };
}

// Async generator streaming chat deltas from Ollama
export async function* chatStream({ host = 'http://127.0.0.1:11434', model, messages = [], options = {} } = {}) {
  const m = String(model || '').trim();
  if (!m) throw new Error('ollama_model_missing');
  const url = String(host || '').trim().replace(/\/$/, '') + '/api/chat';
  const payload = {
    model: m,
    messages: Array.isArray(messages) ? messages : [],
    stream: true,
    options: options && typeof options === 'object' ? options : undefined,
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    let text = '';
    try { text = await res.text(); } catch {}
    throw new Error(`ollama_error_${res.status}: ${text}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        const j = JSON.parse(line);
        if (j?.done === true) {
          return;
        }
        // Prefer incremental content from message.content, fallback to response
        const delta = (j?.message && typeof j.message.content === 'string')
          ? j.message.content
          : (typeof j?.response === 'string' ? j.response : '');
        if (delta) {
          yield delta;
        }
      } catch {
        // ignore parse errors; buffer may split JSON chunks
      }
    }
  }
}
