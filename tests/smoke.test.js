const { test } = require('node:test');
const assert = require('node:assert/strict');

const BASE_URL = (process.env.BASE_URL || 'https://sliit-parking-beta.vercel.app').replace(/\/$/, '');

async function get(path) {
  const response = await fetch(new URL(path, BASE_URL), {
    headers: { accept: 'application/json, text/html' },
    signal: AbortSignal.timeout(20000),
  });
  return response;
}

test('health endpoint reports database and storage ready', async () => {
  const response = await get('/api/health');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.database, 'connected');
  assert.equal(body.storage, 'configured');
});

test('public student settings are available and valid', async () => {
  const response = await get('/api/student/info');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(Number(body.pass_price) > 0, 'pass_price should be a positive number');
  assert.ok(Number(body.plan_days) > 0, 'plan_days should be a positive number');
  assert.equal(typeof body.bank_info, 'string');
});

for (const [path, marker] of [
  ['/student/', 'Student Registration'],
  ['/admin/', 'ADMIN LOGIN'],
  ['/enforcer/', 'ENFORCER LOGIN'],
]) {
  test(`public portal loads: ${path}`, async () => {
    const response = await get(path);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /text\/html/i);
    const html = await response.text();
    assert.ok(html.includes(marker), `expected portal marker: ${marker}`);
  });
}

for (const path of [
  '/api/student/me',
  '/api/student/payments',
  '/api/admin/settings',
  '/api/admin/payments',
  '/api/admin/table/students',
  '/api/enforcer/me',
  '/api/enforcer/fees',
]) {
  test(`protected endpoint rejects unauthenticated access: ${path}`, async () => {
    const response = await get(path);
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(typeof body.error, 'string');
  });
}
