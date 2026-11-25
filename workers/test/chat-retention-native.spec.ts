import {it,expect} from 'vitest';
import {build} from 'esbuild';
import {readFileSync,readdirSync,mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Miniflare,Log,LogLevel} from './miniflare-compat';
import {convertV4MiniflareOptions} from 'miniflare';

it('native SQLite DO reconstruction retains an unresolved completion and Owner finalises without another SQL batch',async()=>{
 const compile=async(inject:boolean)=>{
  const source=`import {ChatRoom as Original} from './workers/chat/ChatRoom';
  export class ChatRoom extends Original {
   constructor(state,env){
    const raw=state.storage,counter={batches:0};let committed=false;
    const storage=new Proxy(raw,{get(t,k){if(k==='put')return async(key,value)=>{const entries=typeof key==='string'?{[key]:value}:key;
      if(${inject}&&committed&&entries['retention-paused']===true)throw Error('local compensation unavailable');
      await t.put(key,value);if(${inject}&&entries['retention-paused']===false){committed=true;throw Error('local acknowledgement lost');}};
     const v=Reflect.get(t,k,t);return typeof v==='function'?v.bind(t):v;}});
    const stateProxy=new Proxy(state,{get(t,k){if(k==='storage')return storage;const v=Reflect.get(t,k,t);return typeof v==='function'?v.bind(t):v;}});
    const database={prepare:q=>env.DB.prepare(q),batch:async ss=>{counter.batches++;return env.DB.batch(ss);}};
    super(stateProxy,{...env,DB:database});this.localCounter=counter;this.localInstance=crypto.randomUUID();
   }
   async fetch(r){let response;if(new URL(r.url).pathname==='/__fixture/alarm'){try{await this.alarm();response=new Response('ok')}catch{response=new Response('stopped',{status:503})}}else response=await super.fetch(r);
    const h=new Headers(response.headers);h.set('x-local-instance',this.localInstance);h.set('x-local-batches',String(this.localCounter.batches));return new Response(response.body,{status:response.status,headers:h});}
  }
  export default {fetch(r,env){return env.CHAT.get(env.CHAT.idFromName('global')).fetch(r)}};`;
  return(await build({stdin:{contents:source,resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'browser'})).outputFiles[0].text;
 };
 const persist=mkdtempSync(join(tmpdir(),'retention-native-causal-'));
 const options=(script:string)=>({modules:true,script,compatibilityDate:'2025-12-01',resourcePersistencePath:persist,resourceTmpPath:persist,bindings:{PUBLIC_ORIGIN:'https://fixture.invalid'},d1Databases:{DB:'local-retention-causal'},durableObjects:{CHAT:{className:'ChatRoom',useSQLite:true}},log:new Log(LogLevel.ERROR)});
 const mf=new Miniflare(options(await compile(true)));
 try{
  let db=await mf.getD1Database('DB');for(const f of readdirSync('migrations').filter(x=>x.endsWith('.sql')).sort())await db.batch(readFileSync('migrations/'+f,'utf8').split(';').map(x=>x.trim()).filter(Boolean).map(q=>db.prepare(q)));
  await db.prepare("INSERT INTO users(id,display_name,role,created_at,updated_at)VALUES('local-owner','Synthetic Owner','owner',0,0)").run();
  const localHash='hmac-sha256:v1:'+'0'.repeat(64);
  await db.prepare("INSERT INTO sessions(id,user_id,token_hash,expires_at,created_at,last_seen_at)VALUES('local-session','local-owner',?,?,0,0)").bind(localHash,Date.now()+86400000).run();
  await db.prepare("INSERT INTO chat_messages(id,author_display_name,content,created_at,expires_at)VALUES('local-parent','Synthetic','private fixture',0,1)").run();await db.prepare('UPDATE chat_retention_state SET message_count=1').run();
  await db.prepare("WITH RECURSIVE seq(x)AS(SELECT 1 UNION ALL SELECT x+1 FROM seq WHERE x<132)INSERT INTO chat_reports(id,message_id,reason,status,created_at)SELECT 'local-report-'||x,'local-parent','private fixture','resolved',0 FROM seq").run();
  const headers={'x-chat-identity':JSON.stringify({sessionHash:localHash,visitor:'fixture',country:'TW',seenAt:Date.now()}),'content-type':'application/json'};
  const first=await mf.dispatchFetch('https://fixture.invalid/__fixture/alarm');expect(first.status).toBe(503);expect(first.headers.get('x-local-batches')).toBe('1');
  const beforeResponse=await mf.dispatchFetch('https://fixture.invalid/api/chat/moderation/retention',{headers}),instance=beforeResponse.headers.get('x-local-instance'),before=await beforeResponse.json() as any;
  expect(before.paused).toBe(true);expect(before.durablePaused).toBe(false);expect(before.recoveryAction).toBe('finalise');
  await mf.setOptions(convertV4MiniflareOptions(options(await compile(false))));db=await mf.getD1Database('DB');
  const afterResponse=await mf.dispatchFetch('https://fixture.invalid/api/chat/moderation/retention',{headers}),after=await afterResponse.json() as any;
  expect(afterResponse.headers.get('x-local-instance')!==instance).toBe(true);expect(after.token===before.token).toBe(true);expect(after.paused).toBe(true);
  expect((await mf.dispatchFetch('https://fixture.invalid/__fixture/alarm')).headers.get('x-local-batches')).toBe('0');
  expect(await db.prepare('SELECT COUNT(*) AS n FROM chat_reports').first('n')).toBe(32);
  const recover=await mf.dispatchFetch('https://fixture.invalid/api/chat/moderation/retention',{method:'POST',headers,body:JSON.stringify({expectedToken:after.token})});expect(recover.status).toBe(200);expect(recover.headers.get('x-local-batches')).toBe('0');
  const replay=await mf.dispatchFetch('https://fixture.invalid/api/chat/moderation/retention',{method:'POST',headers,body:JSON.stringify({expectedToken:after.token})});expect(replay.status).toBe(409);
  expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
 }finally{await mf.dispose();}
});
