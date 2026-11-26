import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;

before(async () => {
  // A disposable PostgreSQL instance: none of these fixtures touch Supabase.
  await db.exec(`
    create role anon;
    create role authenticated;
    create schema auth;
    grant usage on schema auth to anon, authenticated;
    create table auth.users (
      id uuid primary key, email text, created_at timestamptz default now(),
      email_confirmed_at timestamptz, deleted_at timestamptz,
      is_anonymous boolean default false, encrypted_password text,
      raw_user_meta_data jsonb default '{}'::jsonb
    );
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
    $$;
    create publication supabase_realtime;
  `);
  for (const file of ['20261113000000_create_community.sql', '20261119000000_school_ambassadors.sql', '20261121000000_admin_member_directory.sql']) {
    await db.exec(await readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8'));
  }
  for (let number = 1; number <= 60; number++) {
    await db.query(`insert into auth.users(id,email,created_at,email_confirmed_at,is_anonymous,deleted_at,encrypted_password,raw_user_meta_data)
      values($1,$2,'2026-01-01'::timestamptz + $3::integer * interval '1 minute',
      case when $3::integer % 2 = 1 then now() else null end,$3=59,
      case when $3=60 then now() else null end,'never-return-this','{"is_admin":true}')`, [id(number), `student${number}@example.invalid`, number]);
    if (![2, 3].includes(number)) await db.query('insert into public.profiles(id,name,country,school) values($1,$2,$3,$4)', [id(number), `Student ${number}`, 'Test country', number === 4 ? '100%_Test School' : 'Test school']);
  }
  await db.query('insert into interoom_private.admins(user_id) values($1)', [id(1)]);
  await db.query('insert into public.ambassadors(user_id,school) values($1,$2)', [id(4), 'Representative school']);
  // Tied dates must still paginate deterministically.
  await db.query('update auth.users set created_at=(select created_at from auth.users where id=$1) where id=$2', [id(58), id(57)]);
});
after(async () => { await db.close(); });

async function asRole(role, userId, action) {
  await db.exec('begin');
  try {
    await db.query("select set_config('request.jwt.claim.sub', $1, true)", [userId ?? '']);
    await db.exec(`set local role ${role}`);
    return await action();
  } finally { await db.exec('rollback'); }
}
async function list(search = '', page = 0) {
  const { rows } = await db.query('select public.list_community_members($1,$2) as result', [search, page]);
  return rows[0].result;
}

test('admin can browse every registered account across all pages without duplicates', async () => {
  const expected = (await db.query('select id from auth.users where deleted_at is null and not is_anonymous order by created_at desc, id')).rows.map(row => row.id);
  await asRole('authenticated', id(1), async () => {
    const pages = await Promise.all([list('', 0), list('', 1), list('', 2)]);
    assert.deepEqual(pages.map(page => page.items.length), [25, 25, 8]);
    assert.deepEqual(pages.map(page => page.total), [58, 58, 58]);
    assert.deepEqual(pages.map(page => page.page), [0, 1, 2]);
    assert.deepEqual(pages.flatMap(page => page.items.map(person => person.user_id)), expected);
  });
});

test('accounts without a profile and without email verification are included', async () => {
  await asRole('authenticated', id(1), async () => {
    const result = await list('  STUDENT2@EXAMPLE.INVALID  ');
    assert.equal(result.total, 1);
    assert.equal(result.items[0].user_id, id(2));
    assert.equal(result.items[0].has_profile, false);
    assert.equal(result.items[0].email_verified, false);
    assert.equal(result.items[0].name, null);
  });
});

test('search treats wildcard and SQL characters literally and preserves ambassador details', async () => {
  await asRole('authenticated', id(1), async () => {
    const result = await list('%_');
    assert.equal(result.total, 1);
    assert.equal(result.items[0].user_id, id(4));
    assert.equal(result.items[0].ambassador_school, 'Representative school');
    assert.equal((await list("' OR 1=1 --")).total, 0);
    assert.deepEqual((await list('no-such-member')).items, []);
  });
});

test('only approved account fields are returned and out-of-range pages recover', async () => {
  await asRole('authenticated', id(1), async () => {
    const result = await list('', 999);
    assert.equal(result.page, 2);
    const admin = result.items.find(person => person.user_id === id(1));
    assert.equal(admin.is_admin, true);
    assert.deepEqual(Object.keys(admin).sort(), ['user_id', 'email', 'created_at', 'email_verified', 'has_profile', 'name', 'country', 'school', 'ambassador_school', 'is_admin'].sort());
    assert.equal(JSON.stringify(result).includes('never-return-this'), false);
  });
});

test('ordinary users and authenticated requests without an identity cannot list accounts', async () => {
  for (const userId of [id(4), null]) {
    await assert.rejects(asRole('authenticated', userId, () => list()), error => error.code === '42501');
  }
});

test('anonymous requests cannot execute the directory function', async () => {
  await assert.rejects(asRole('anon', null, () => list()), error => error.code === '42501');
});

test('admin revocation takes effect on the next request', async () => {
  await db.exec('begin');
  try {
    await db.query('delete from interoom_private.admins where user_id=$1', [id(1)]);
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [id(1)]);
    await db.exec('set local role authenticated');
    await assert.rejects(list(), error => error.code === '42501');
  } finally { await db.exec('rollback'); }
});

test('new directory grants no direct access to auth records or admin membership', async () => {
  for (const table of ['auth.users', 'interoom_private.admins']) {
    await assert.rejects(asRole('authenticated', id(4), () => db.query(`select * from ${table}`)), error => error.code === '42501');
  }
});

test('invalid pagination and overlong searches are rejected', async () => {
  for (const [search, page] of [['', -1], ['', null], ['x'.repeat(121), 0]]) {
    await assert.rejects(asRole('authenticated', id(1), () => list(search, page)), error => error.code === '22023');
  }
});

test('existing ambassador role checks continue to pass', async () => {
  const results = await db.exec(await readFile(new URL('./ambassadors.sql', import.meta.url), 'utf8'));
  assert.ok(results.some(result => result.rows?.some(row => String(row.result).startsWith('PASS:'))));
});
