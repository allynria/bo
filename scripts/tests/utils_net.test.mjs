import assert from 'node:assert';
import { test } from 'node:test';
import { getBearerOrRawToken, getTokenFromQuery, isIpAllowed, getToken } from '../utils/net.mjs';

// Helper to fake req object
function mkReq({ ip = '127.0.0.1', url = '/', auth = '', headers = {} } = {}) {
  return {
    url,
    headers: { authorization: auth, ...headers },
    socket: { remoteAddress: ip },
  };
}

test('getBearerOrRawToken handles Bearer and raw tokens', () => {
  assert.equal(getBearerOrRawToken('Bearer abc123'), 'abc123');
  assert.equal(getBearerOrRawToken('bearer XYZ'), 'XYZ');
  assert.equal(getBearerOrRawToken('rawtoken'), 'rawtoken');
  assert.equal(getBearerOrRawToken(''), '');
});

test('getTokenFromQuery extracts token from common params', () => {
  const u = new URL('http://x/path?token=abc&foo=bar');
  assert.equal(getTokenFromQuery(u), 'abc');
  const u2 = new URL('http://x/path?access_token=xyz');
  assert.equal(getTokenFromQuery(u2), 'xyz');
  const u3 = new URL('http://x/path?auth=k');
  assert.equal(getTokenFromQuery(u3), 'k');
  const u4 = new URL('http://x/path?nope=1');
  assert.equal(getTokenFromQuery(u4), '');
});

test('isIpAllowed respects allowlist env', () => {
  const prev = process.env.READYZ_IP_ALLOWLIST;
  process.env.READYZ_IP_ALLOWLIST = '127.0.0.1,10.0.0.2';
  assert.equal(isIpAllowed(mkReq({ ip: '127.0.0.1' }), 'READYZ_IP_ALLOWLIST'), true);
  assert.equal(isIpAllowed(mkReq({ ip: '10.0.0.2' }), 'READYZ_IP_ALLOWLIST'), true);
  assert.equal(isIpAllowed(mkReq({ ip: '192.168.1.1' }), 'READYZ_IP_ALLOWLIST'), false);
  process.env.READYZ_IP_ALLOWLIST = prev;
});

test('isIpAllowed considers x-forwarded-for first IP and prefix/wildcard', () => {
  const prev = process.env.READYZ_IP_ALLOWLIST;
  // prefix match allows 10.x.x.x
  process.env.READYZ_IP_ALLOWLIST = '10.';
  assert.equal(
    isIpAllowed(
      mkReq({ ip: '192.168.1.9', headers: { 'x-forwarded-for': '10.2.3.4, 1.2.3.4' } }),
      'READYZ_IP_ALLOWLIST'
    ),
    true
  );
  // wildcard allows all
  process.env.READYZ_IP_ALLOWLIST = '*';
  assert.equal(isIpAllowed(mkReq({ ip: '8.8.8.8' }), 'READYZ_IP_ALLOWLIST'), true);
  process.env.READYZ_IP_ALLOWLIST = prev;
});

test('getToken reads from Authorization header and query', () => {
  let req = mkReq({ auth: 'Bearer abc', url: '/x' });
  assert.equal(getToken(req), 'abc');
  req = mkReq({ auth: '', url: '/x?token=qq' });
  assert.equal(getToken(req), 'qq');
  req = mkReq({ auth: 'raw', url: '/x?token=qq' });
  assert.equal(getToken(req), 'raw');
});
