import { afterAll, beforeAll, expect, it } from 'vitest'
import { build } from 'esbuild'
import { readFile, readdir } from 'node:fs/promises'
import { Miniflare } from './miniflare-compat'

let runtime: Miniflare
const sessionHash = 'hmac-sha256:v1:' + 'a'.repeat(64)

beforeAll(async () => {
  const worker = await build({
    stdin: { resolveDir: process.cwd(), contents: `
      import {ChatRoom} from './workers/chat/ChatRoom';
      export default {async fetch(request,env) {
        const started=performance.now(), events=[];let trips=0;
        const pause=async()=>{trips++;await new Promise(resolve=>setTimeout(resolve,100))};
        const wrap=(raw)=>({raw,bind(...values){return wrap(raw.bind(...values))},
          async first(...args){await pause();return raw.first(...args)},
          async all(...args){await pause();return raw.all(...args)},
          async run(...args){await pause();return raw.run(...args)}});
        const db={prepare(sql){return wrap(env.DB.prepare(sql))},
          async batch(statements){await pause();return env.DB.batch(statements.map(s=>s.raw))}};
        const values=new Map();let alarm=null;
        const identity={sessionHash:'${sessionHash}',visitor:'00000000-0000-4000-8000-000000000001',country:null,seenAt:Date.now()};
        const socket={readyState:1,deserializeAttachment(){return identity},serializeAttachment(){},
          send(value){const event=JSON.parse(value);if(event.type==='message')events.push({at:performance.now()-started,trips})}};
        const state={setWebSocketAutoResponse(){},getWebSockets(){return [socket]},getWebSocketAutoResponseTimestamp(){return null},
          storage:{async get(key){return values.get(key)},async put(key,value){for(const[k,v]of typeof key==='string'?[[key,value]]:Object.entries(key))values.set(k,v)},
            async getAlarm(){return alarm},async setAlarm(at){alarm=at},async deleteAlarm(){alarm=null}}};
        const response=await new ChatRoom(state,{...env,DB:db}).fetch(new Request('https://chat.internal/api/chat/messages',{
          method:'POST',headers:{'content-type':'application/json','x-chat-identity':JSON.stringify(identity)},
          body:JSON.stringify({type:'text',text:'Local delivery deadline fixture',requestId:'deadline-request'})}));
        return Response.json({status:response.status,body:await response.json(),events,trips,elapsed:performance.now()-started});
      }};` },
    bundle: true, write: false, format: 'esm', platform: 'browser',
  })
  runtime = new Miniflare({modules:true,script:worker.outputFiles[0].text,compatibilityDate:'2025-12-01',d1Databases:{DB:'chat-delivery-deadline'}})
  const db=await runtime.getD1Database('DB')
  for (const file of (await readdir('migrations')).filter(n=>n.endsWith('.sql')).sort()) {
    await db.batch((await readFile('migrations/'+file,'utf8')).split(';').map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)))
  }
  const now=Date.now()
  await db.prepare("INSERT INTO users(id,display_name,role,created_at,updated_at) VALUES('delivery-user','Local fixture','user',?,?)").bind(now,now).run()
  await db.prepare("INSERT INTO sessions(id,user_id,token_hash,expires_at,created_at,last_seen_at) VALUES('delivery-session','delivery-user',?,?,?,?)").bind(sessionHash,now+3_600_000,now,now).run()
})
afterAll(async()=>{await runtime?.dispose()})

it('delivers a committed message within one second with 100 ms D1 round-trip latency',async()=>{
  const response=await runtime.dispatchFetch('https://local.invalid/delivery')
  const result=await response.json() as {status:number;body:{message:{id:string}};events:{at:number;trips:number}[];elapsed:number}
  expect(result.status).toBe(201)
  expect(result.events).toHaveLength(1)
  const db=await runtime.getD1Database('DB')
  expect(await db.prepare('SELECT COUNT(*) AS count FROM chat_messages WHERE id=?').bind(result.body.message.id).first('count')).toBe(1)
  expect(await db.prepare('SELECT COUNT(*) AS count FROM chat_request_receipts WHERE message_id=?').bind(result.body.message.id).first('count')).toBe(1)
  expect(result.events[0].at).toBeLessThan(1000)
  expect(result.elapsed).toBeLessThan(1200)
})
