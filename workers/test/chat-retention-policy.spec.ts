import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from './miniflare-compat';
import { readRetentionPolicy, updateRetentionPolicy } from '../chat/retentionPolicy';
import { history, readMessage } from '../chat/repository';
import { nextRetention, prune } from '../chat/retention';

const DAY = 86400000, now = 100 * DAY;
let runtime: Miniflare;
let db: Awaited<ReturnType<Miniflare['getD1Database']>>;
beforeAll(async () => {
  runtime = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', compatibilityDate: '2025-12-01', d1Databases: { DB: 'retention-policy' } });
  db = await runtime.getD1Database('DB');
  for (const file of (await readdir('migrations')).filter(f => f.endsWith('.sql')).sort())
    await db.batch((await readFile(`migrations/${file}`, 'utf8')).split(';').map(s => s.trim()).filter(Boolean).map(s => db.prepare(s)));
  await db.prepare("INSERT INTO users(id,display_name,role,created_at,updated_at) VALUES('owner','Owner','owner',0,0)").run();
});
afterAll(async () => runtime?.dispose());
beforeEach(async () => {
  await db.batch([db.prepare('DELETE FROM admin_audit_log'), db.prepare('DELETE FROM chat_messages'), db.prepare("DELETE FROM admin_settings WHERE setting_key='chat.retention'"), db.prepare("UPDATE chat_retention_state SET message_count=0,floor_created_at=NULL,floor_id=NULL WHERE room_id='global'")]);
});
async function message(id: string, age: number) {
  await db.prepare("INSERT INTO chat_messages(id,room_id,author_display_name,content,message_type,created_at,expires_at) VALUES (?,'global','fixture','hello','text',?,?)").bind(id, now-age*DAY, now+(30-age)*DAY).run();
  await db.prepare("UPDATE chat_retention_state SET message_count=message_count+1 WHERE room_id='global'").run();
}
it('defaults to 30 days and enforces integer bounds and optimistic revisions', async () => {
  expect(await readRetentionPolicy(db as never)).toEqual({retentionDays:30,revision:0,hiddenBefore:0});
  for (const days of [0,31,1.5,NaN]) await expect(updateRetentionPolicy(db as never, days, 0, now,'owner')).rejects.toMatchObject({status:400});
  expect(await updateRetentionPolicy(db as never,7,0,now,'owner')).toEqual({retentionDays:7,revision:1,hiddenBefore:now-7*DAY});
  await expect(updateRetentionPolicy(db as never,14,0,now,'owner')).rejects.toMatchObject({status:409});
});
it('hides existing messages immediately and never revives expired rows after extension', async () => {
  await message('old',8); await message('expires-before-extension',6); await message('recent',1);
  await updateRetentionPolicy(db as never,7,0,now,'owner');
  expect(await readMessage(db as never,'old',now)).toBeNull();
  expect((await history(db as never,undefined,now,null,null)).rows.map(m=>m.id)).toEqual(['expires-before-extension','recent']);
  await updateRetentionPolicy(db as never,30,1,now+2*DAY,'owner');
  expect(await readMessage(db as never,'old',now+2*DAY)).toBeNull();
  expect(await readMessage(db as never,'expires-before-extension',now+2*DAY)).toBeNull();
  expect(await readMessage(db as never,'recent',now+2*DAY)).not.toBeNull();
});
it('schedules effective expiry with one database read and cleans at most ten parents', async () => {
  for(let i=0;i<12;i++) await message(`old-${i}`,8);
  await updateRetentionPolicy(db as never,7,0,now,'owner');
  let reads=0;
  const counted={ prepare(sql:string){ reads++;return db.prepare(sql); } };
  expect(await nextRetention(counted as never,now)).toBeLessThanOrEqual(now);
  expect(reads).toBe(1);
  expect(await prune(db as never,now)).toBe(10);
  expect(await db.prepare("SELECT message_count AS count FROM chat_retention_state WHERE room_id='global'").first('count')).toBe(2);
  expect(await prune(db as never,now)).toBe(2);
});
it('expires new messages at the policy boundary while respecting immutable earlier expiry', async () => {
  await updateRetentionPolicy(db as never,7,0,now,'owner');
  await message('new',0);
  expect(await nextRetention(db as never,now)).toBe(now+7*DAY);
  expect(await readMessage(db as never,'new',now+7*DAY-1)).not.toBeNull();
  expect(await readMessage(db as never,'new',now+7*DAY)).toBeNull();
  await db.prepare("UPDATE chat_messages SET expires_at=? WHERE id='new'").bind(now+DAY).run();
  expect(await nextRetention(db as never,now)).toBe(now+DAY);
});
it('serialises competing initial and existing revision saves atomically', async () => {
  for (const revision of [0,1]) {
    const results=await Promise.allSettled([7,14].map(days=>updateRetentionPolicy(db as never,days,revision,now,'owner')));
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    const failed=results.find(r=>r.status==='rejected') as PromiseRejectedResult;
    expect(failed.reason).toMatchObject({status:409});
    expect((await readRetentionPolicy(db as never)).revision).toBe(revision+1);
    expect(await db.prepare("SELECT count(*) AS n FROM admin_audit_log WHERE target_key='chat.retention'").first('n')).toBe(revision+1);
  }
});
it('drains only 100 children and keeps partially cleaned parents hidden', async () => {
  await message('dependent',8);
  await db.prepare(`WITH RECURSIVE seq(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM seq WHERE x<105)
    INSERT INTO chat_message_versions(id,message_id,original_content,created_at,expires_at)
    SELECT printf('version-%03d',x),'dependent','private',?,? FROM seq`).bind(now,now+DAY).run();
  await updateRetentionPolicy(db as never,7,0,now,'owner');
  expect(await prune(db as never,now)).toBe(1);
  expect(await db.prepare('SELECT count(*) AS count FROM chat_message_versions').first('count')).toBe(5);
  expect(await db.prepare('SELECT count(*) AS count FROM chat_messages').first('count')).toBe(1);
  expect(await readMessage(db as never,'dependent',now)).toBeNull();
  expect(await nextRetention(db as never,now)).toBe(now);
  expect(await prune(db as never,now)).toBe(1);
  expect(await db.prepare('SELECT count(*) AS count FROM chat_messages').first('count')).toBe(0);
});
it('fails closed for malformed stored policy, including SQL visibility', async () => {
  await message('recent',1);
  await db.prepare("INSERT INTO admin_settings(setting_key,setting_json,updated_at) VALUES ('chat.retention','{}',?)").bind(now).run();
  await expect(readRetentionPolicy(db as never)).rejects.toThrow('chat_retention_policy_invalid');
  await expect(updateRetentionPolicy(db as never,7,0,now,'owner')).rejects.toThrow('chat_retention_policy_invalid');
  expect(await readMessage(db as never,'recent',now)).toBeNull();
  await expect(prune(db as never,now)).rejects.toThrow('chat_retention_policy_invalid');
  expect(await db.prepare('SELECT count(*) AS count FROM chat_messages').first('count')).toBe(1);
});
it('uses bounded indexed candidates when creation and immutable expiry order diverge', async () => {
  await db.prepare(`WITH RECURSIVE seq(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM seq WHERE x<9000)
    INSERT INTO chat_messages(id,room_id,author_display_name,content,created_at,expires_at)
    SELECT printf('live-%05d',x),'global','fixture','live',?-10000+x,? FROM seq`).bind(now,now+DAY).run();
  await message('later-expired',0);
  await db.prepare("UPDATE chat_messages SET expires_at=? WHERE id='later-expired'").bind(now).run();
  await db.prepare("UPDATE chat_retention_state SET message_count=9001 WHERE room_id='global'").run();
  const selections: Array<{ sql:string; args:unknown[]; results:unknown[]; meta:Record<string,unknown> }> = [];
  function observed(statement: ReturnType<typeof db.prepare>, sql:string, args:unknown[] = []): ReturnType<typeof db.prepare> {
    return new Proxy(statement, { get(target,key) {
      if(key==='bind') return (...values:never[]) => observed(target.bind(...values),sql,values);
      if(key==='all') return async () => {
        const result=await target.all();
        selections.push({sql,args,results:result.results,meta:result.meta});
        return result;
      };
      const value=Reflect.get(target,key); return typeof value==='function' ? value.bind(target) : value;
    }});
  }
  const counted={prepare(sql:string){return observed(db.prepare(sql),sql);},batch:db.batch.bind(db)};
  expect(await prune(counted as never,now)).toBe(1);
  expect(await db.prepare("SELECT id FROM chat_messages WHERE id='later-expired'").first()).toBeNull();
  expect(await db.prepare('SELECT count(*) AS count FROM chat_messages').first('count')).toBe(9000);
  const candidate=selections.find(s=>s.results.some(r=>(r as {id:string}).id==='later-expired'))!;
  expect(candidate).toBeDefined();
  // Real SQLite planner evidence; this is not a match against implementation source.
  const plan=await db.prepare(`EXPLAIN QUERY PLAN ${candidate.sql}`).bind(...candidate.args as never[]).all<{detail:string}>();
  const detail=plan.results.map((row:{detail:string})=>row.detail).join('\n');
  const rowsRead=candidate.meta.rows_read;
  console.info('RETENTION_CANDIDATE_SQLITE_COST',JSON.stringify({rowsRead:rowsRead??'unavailable',plan:plan.results}));
  expect(detail).toMatch(/idx_chat_messages_room_expiry.*expires_at</);
  expect(detail).toMatch(/idx_chat_messages_room_created.*created_at</);
  if(typeof rowsRead==='number') expect(rowsRead).toBeLessThan(100);
});
it('deduplicates overlapping expiry candidates before applying the ten-parent bound', async () => {
  for(let i=0;i<8;i++) await message(`both-${i}`,31);
  for(let i=0;i<2;i++) { await message(`policy-${i}`,8); await message(`immutable-${i}`,0); }
  await db.prepare("UPDATE chat_messages SET expires_at=? WHERE id LIKE 'immutable-%'").bind(now).run();
  await updateRetentionPolicy(db as never,7,0,now,'owner');
  expect(await prune(db as never,now)).toBe(10);
  expect((await db.prepare('SELECT id FROM chat_messages ORDER BY id').all<{id:string}>()).results.map((r:{id:string})=>r.id)).toEqual(['immutable-0','immutable-1']);
  expect(await prune(db as never,now)).toBe(2);
  expect(await db.prepare("SELECT message_count AS count FROM chat_retention_state WHERE room_id='global'").first('count')).toBe(0);
});
