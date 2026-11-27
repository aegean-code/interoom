// Browser-test transport: local SQL permissions and local bytes only, no hosted requests.
export function localPhotoStorage(db, schedule, user) {
  async function sql(query, args) {
    await db.exec('begin;set local role authenticated');
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [user]);
    const { rows } = await db.query(query, args); await db.exec('commit'); return rows;
  }
  function run(action) {
    return schedule(async () => { try { return { data: await action(), error: null }; } catch (error) { await db.exec('rollback'); return { data: null, error }; } });
  }
  return { from(bucket) { return {
    async upload(name, blob) {
      const bytes = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob); });
      return run(async () => { await sql('insert into storage.objects(bucket_id,name,owner_id,metadata) values($1,$2,$3,$4)', [bucket, name, user, { mimetype: blob.type, size: blob.size }]); await db.query('insert into local_photo_bytes(name,bytes) values($1,$2)', [name, bytes]); return { path: name }; });
    },
    list(prefix) { return run(async () => (await sql('select split_part(name,\'/\',2) as name from storage.objects where bucket_id=$1 and split_part(name,\'/\',1)=$2', [bucket, prefix]))); },
    remove(names) { return run(async () => { const removed = await sql('delete from storage.objects where bucket_id=$1 and name=any($2) returning name', [bucket, names]); if (removed.length) await db.query('delete from local_photo_bytes where name=any($1)', [removed.map(r => r.name)]); return removed; }); },
    createSignedUrl(name) { return run(async () => { if (!(await sql('select name from storage.objects where bucket_id=$1 and name=$2', [bucket, name])).length) throw new Error('Not visible'); return { signedUrl: (await db.query('select bytes from local_photo_bytes where name=$1', [name])).rows[0].bytes }; }); },
  }; } };
}
