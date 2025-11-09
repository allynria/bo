import * as fs from 'node:fs';
import * as path from 'node:path';
import { createMessage, assembleForModel } from '../conv/contract.mjs';

// Canonical set of 10 conversations to freeze.
// Each item maps to a single-turn conversation with optional persona/prompt variants.
// Stream final is determined by stub providers: stub:<provider>:<model>.
const CANONICAL_CONVS = [
  { name: 'golden-urga-1', text: 'Hello determinism.', engine: 'urga' },
  {
    name: 'golden-urga-2',
    text: 'Count to three: 1, 2, 3.',
    engine: 'urga',
    persona_v: 'v1',
    prompt_v: 'v2',
  },
  {
    name: 'golden-urga-3',
    text: 'Echo the word: moonlight',
    engine: 'urga',
    persona_v: 'v2',
    prompt_v: 'v1',
  },
  { name: 'golden-echo-1', text: 'Plain echo test.', engine: 'echo' },
  {
    name: 'golden-echo-2',
    text: 'Symbols: !@#$%^&*()',
    engine: 'echo',
    persona_v: 'v1',
    prompt_v: 'v3',
  },
  { name: 'golden-dreams-1', text: 'Dream a little dream.', engine: 'dreams' },
  { name: 'golden-dreams-2', text: 'Lucid visions shimmer.', engine: 'dreams', persona_v: 'v2' },
  { name: 'golden-urga-4', text: 'JSON content check {"a":1}.', engine: 'urga', prompt_v: 'v3' },
  {
    name: 'golden-echo-3',
    text: 'Whitespace     preserved',
    engine: 'echo',
    persona_v: 'v2',
    prompt_v: 'v2',
  },
  {
    name: 'golden-dreams-3',
    text: 'Final golden case.',
    engine: 'dreams',
    persona_v: 'v3',
    prompt_v: 'v3',
  },
];

function freezeOne({ name, text, engine, persona_v, prompt_v }) {
  // Compile step: user-only message, id stable via compile endpoint defaults (msg_user_0), ts=0.
  const userForCompile = createMessage({
    role: 'user',
    content: [text],
    turn: 0,
    ts: 0,
    id: 'msg_user_0',
  });
  const { bytes: compileBytes, hash: compileHash } = assembleForModel([userForCompile], {
    persona_v,
    prompt_v,
  });

  // Message step: mirrors service stability defaults (conv:0:user id, ts=0).
  const userForMessage = createMessage({
    role: 'user',
    content: [text],
    turn: 0,
    ts: 0,
    id: 'conv:0:user',
    conv_id: 'conv',
  });
  const { bytes: messageBytes, hash: messageHash } = assembleForModel([userForMessage], {
    persona_v,
    prompt_v,
  });

  // Stream final from stub providers is deterministic: stub:<provider>:<model>.
  const provider =
    engine === 'urga' ? 'stub-urga' : engine === 'echo' ? 'stub-echo' : 'stub-dreams';
  const streamFinal = `stub:${provider}:${engine}`;

  return {
    name,
    spec: { text, engine, persona_v, prompt_v },
    compile: { hash: compileHash, bytes_b64: compileBytes.toString('base64') },
    message: { hash: messageHash, bytes_b64: messageBytes.toString('base64') },
    stream: { final: streamFinal },
  };
}

function main() {
  const out = CANONICAL_CONVS.map(freezeOne);
  const dir = path.join(process.cwd(), 'scripts', 'determinism');
  const file = path.join(dir, 'golden_snapshots.json');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, convs: out }, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ ok: true, count: out.length, file }) + '\n');
}

main();
