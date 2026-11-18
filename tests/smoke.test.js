const { test } = require('node:test');
const assert = require('node:assert/strict');

const STUDENT_URL = (process.env.STUDENT_URL || process.env.BASE_URL || 'https://sliit-parking-beta.vercel.app').replace(/\/$/, '');
const ADMIN_URL = (process.env.ADMIN_URL || 'https://sliit-parking-admin.vercel.app').replace(/\/$/, '');
const ENFORCER_URL = (process.env.ENFORCER_URL || 'https://sliit-parking-enforcer.vercel.app').replace(/\/$/, '');

async function request(base, path) {
  return fetch(new URL(path, `${base}/`), {
    headers: { accept: 'application/json, text/html' },
    signal: AbortSignal.timeout(20000),
  });
}

test('student host health and public settings', async () => {
  const health = await request(STUDENT_URL, '/api/health');
  assert.equal(health.status, 200);
  const status = await health.json();
  assert.equal(status.ok, true);
  assert.equal(status.database, 'connected');
  assert.equal(status.storage, 'configured');

  const info = await request(STUDENT_URL, '/api/student/info');
  assert.equal(info.status, 200);
  const body = await info.json();
  assert.ok(Number(body.pass_price) > 0);
  assert.ok(Number(body.pass_bike_price) > 0);
  assert.ok(Number(body.plan_days) > 0);
  assert.equal(typeof body.bank_info, 'string');
});

for (const [name, base, marker] of [
  ['student', STUDENT_URL, 'Student Registration'],
  ['admin', ADMIN_URL, 'Admin Portal'],
  ['enforcer', ENFORCER_URL, 'Enforcer Portal'],
]) {
  test(`${name} portal loads at its own domain root`, async () => {
    const response = await request(base, '/');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /text\/html/i);
    assert.ok((await response.text()).includes(marker));
  });
}

for (const [name, base, paths] of [
  ['student', STUDENT_URL, ['/api/student/me', '/api/student/payments']],
  ['admin', ADMIN_URL, ['/api/admin/settings', '/api/admin/payments', '/api/admin/table/students']],
  ['enforcer', ENFORCER_URL, ['/api/enforcer/me', '/api/enforcer/fees']],
]) {
  for (const path of paths) {
    test(`${name} protected API rejects anonymous access: ${path}`, async () => {
      const response = await request(base, path);
      assert.equal(response.status, 401);
      const body = await response.json();
      assert.equal(typeof body.error, 'string');
    });
  }
}

for (const [name, base, forbiddenPaths] of [
  ['student', STUDENT_URL, ['/admin/', '/enforcer/', '/api/admin/settings', '/api/enforcer/me']],
  ['admin', ADMIN_URL, ['/student/', '/enforcer/', '/api/student/info', '/api/enforcer/me']],
  ['enforcer', ENFORCER_URL, ['/student/', '/admin/', '/api/student/info', '/api/admin/settings']],
]) {
  for (const path of forbiddenPaths) {
    test(`${name} domain blocks cross-portal path: ${path}`, async () => {
      const response = await request(base, path);
      assert.equal(response.status, 404);
      const body = await response.json();
      assert.match(body.error, /not available on this domain/i);
    });
  }
}
