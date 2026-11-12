import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { build } from 'esbuild'
import { readFile, readdir } from 'node:fs/promises'
import { Miniflare } from './miniflare-compat'
import { issueSession } from '../auth/session'
import { createChatClient } from '../../src/features/chat/client'

const origin='https://study.example'
const secret='local-retention-api-secret-at-least-thirty-two-characters'
let runtime:Miniflare
let db:Awaited<ReturnType<Miniflare['getD1Database']>>
const tokens:Record<string,string>={}
const path='/api/chat/moderation/retention-policy'
async function request(route=path,user='owner',method='GET',body?:unknown,requestOrigin=origin){
  return runtime.dispatchFetch(origin+route,{method,headers:{origin:requestOrigin,...(tokens[user]?{cookie:'__Host-session='+tokens[user]}:{}),'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})})
}
beforeAll(async()=>{
  // Suppress autonomous cleanup only in this disposable test fixture so hidden
  // receipts remain physically present; request handling uses the real Worker.
  const bundle=await build({stdin:{resolveDir:process.cwd(),contents:`import worker,{ChatRoom as ProductionChatRoom} from './workers/index'; export default worker; export class ChatRoom extends ProductionChatRoom { async alarm(){} }`},bundle:true,write:false,format:'esm',platform:'browser'})
  runtime=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2025-12-01',durableObjects:{CHAT:{className:'ChatRoom',useSQLite:true}},d1Databases:{DB:'chat-policy-api'},bindings:{PUBLIC_ORIGIN:origin,SESSION_HMAC_SECRET:secret}})
  db=await runtime.getD1Database('DB')
  for(const file of (await readdir('migrations')).filter(n=>n.endsWith('.sql')).sort())await db.batch((await readFile('migrations/'+file,'utf8')).split(';').map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)))
  const now=Date.now()
  for(const role of ['user','moderator','admin','owner']){
    await db.prepare('INSERT INTO users(id,display_name,role,created_at,updated_at) VALUES(?,?,?,?,?)').bind(role,role,role,now,now).run()
    tokens[role]=(await issueSession(db as never,role,secret,now,crypto)).token
  }
})
beforeEach(async()=>{
  await db.batch([db.prepare("DELETE FROM admin_audit_log"),db.prepare("DELETE FROM admin_settings WHERE setting_key='chat.retention'"),db.prepare('DELETE FROM chat_messages'),db.prepare('DELETE FROM chat_send_state'),db.prepare("UPDATE chat_retention_state SET message_count=0,floor_created_at=NULL,floor_id=NULL WHERE room_id='global'")])
})
afterAll(async()=>{await runtime?.dispose()})

it('only permits the existing Owner session to read or change the policy',async()=>{
  expect((await request(path,'')).status).toBe(401)
  for(const role of ['user','moderator','admin']){
    expect((await request(path,role)).status).toBe(403)
    expect((await request(path,role,'PATCH',{retentionDays:7,expectedRevision:0})).status).toBe(403)
  }
  const response=await request()
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(await response.json()).toMatchObject({retentionDays:30,revision:0})
  expect((await request(path,'owner','PATCH',{retentionDays:7,expectedRevision:0},'https://evil.example')).status).toBe(403)
  expect((await request(path,'owner','GET',undefined,'https://evil.example')).status).toBe(403)
})

it('rejects invalid days and stale revisions without changing the saved policy',async()=>{
  for(const value of [0,31,7.5,'7',null])expect((await request(path,'owner','PATCH',{retentionDays:value,expectedRevision:0})).status).toBe(400)
  expect((await request(path,'owner','PATCH',{retentionDays:7,expectedRevision:0,unexpected:true})).status).toBe(400)
  const saved=await request(path,'owner','PATCH',{retentionDays:7,expectedRevision:0})
  expect(saved.status).toBe(200)
  expect(await saved.json()).toMatchObject({retentionDays:7,revision:1})
  expect((await request(path,'owner','PATCH',{retentionDays:14,expectedRevision:0})).status).toBe(409)
  expect(await (await request()).json()).toMatchObject({retentionDays:7,revision:1})
})

it.each([
  '{"retentionDays":"7","revision":1,"hiddenBefore":0}',
  '{"retentionDays":7.0,"revision":1,"hiddenBefore":0}',
  '{"retentionDays":7e0,"revision":1,"hiddenBefore":0}',
  '{"retentionDays":7,"retentionDays":1,"revision":1,"hiddenBefore":0}',
  '{ "retentionDays":7,"revision":1,"hiddenBefore":0 }',
])('refuses message writes for a malformed persisted policy: %s',async rawPolicy=>{
  await db.prepare("INSERT INTO admin_settings(setting_key,setting_json,updated_at) VALUES('chat.retention',?,?)").bind(rawPolicy,Date.now()).run()
  const response=await request('/api/chat/messages','user','POST',{type:'text',text:'Local malformed-policy fixture',requestId:'malformed-policy'})
  expect(response.status).toBe(500)
  expect(await db.prepare('SELECT COUNT(*) AS count FROM chat_messages').first('count')).toBe(0)
  expect(await db.prepare('SELECT COUNT(*) AS count FROM chat_request_receipts').first('count')).toBe(0)
  expect(await db.prepare("SELECT message_count FROM chat_retention_state WHERE room_id='global'").first('message_count')).toBe(0)
})

it('does not expose newly expired messages through the moderation report listing',async()=>{
  const now=Date.now(),day=86400000
  await db.prepare("INSERT INTO chat_messages(id,user_id,author_display_name,content,message_type,created_at,expires_at) VALUES('reported-old','user','Local fixture','Private old fixture','text',?,?)").bind(now-8*day,now+22*day).run()
  await db.prepare("INSERT INTO chat_reports(id,reporter_user_id,message_id,reason,created_at) VALUES('old-report','owner','reported-old','Local report fixture',?)").bind(now).run()
  // Seed a persisted policy directly so cleanup cannot mask a visibility bug.
  await db.prepare("INSERT INTO admin_settings(setting_key,setting_json,updated_at) VALUES('chat.retention',?,?)").bind(JSON.stringify({retentionDays:7,revision:1,hiddenBefore:0}),now).run()
  const result=await (await request('/api/chat/moderation')).json() as {reports:unknown[]}
  expect(result.reports).toEqual([])
  expect((await request('/api/chat/moderation/messages/reported-old')).status).toBe(404)
})

it('hides old history and moderation details after shrinking and never revives them on extension',async()=>{
  const now=Date.now(),day=86400000
  for(const [id,age]of [['old',8],['recent',1]] as const){
    await db.prepare("INSERT INTO chat_messages(id,user_id,author_display_name,content,message_type,created_at,expires_at) VALUES(?,'user','Local fixture','Local retention fixture','text',?,?)").bind(id,now-age*day,now+(30-age)*day).run()
  }
  await db.prepare("UPDATE chat_retention_state SET message_count=2 WHERE room_id='global'").run()
  const before=await (await request('/api/chat','')).json() as {messages:{id:string}[]}
  expect(before.messages.map(m=>m.id)).toContain('old')
  const socketResponse=await runtime.dispatchFetch(origin+'/api/chat/socket',{headers:{origin,upgrade:'websocket',cookie:'__Host-session='+tokens.owner}})
  expect(socketResponse.status).toBe(101)
  const socket=socketResponse.webSocket!
  const reset=new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('policy reset not delivered')),5000);socket.addEventListener('message',event=>{if(JSON.parse(String(event.data)).type==='reset'){clearTimeout(timer);resolve()}})})
  socket.accept()
  try{
    expect((await request(path,'owner','PATCH',{retentionDays:7,expectedRevision:0})).status).toBe(200)
    await reset
    const shrunk=await (await request('/api/chat','')).json() as {messages:{id:string}[]}
    expect(shrunk.messages.map(m=>m.id)).not.toContain('old')
    expect(shrunk.messages.map(m=>m.id)).toContain('recent')
    expect((await request('/api/chat/moderation/messages/old')).status).toBe(404)
    expect((await request(path,'owner','PATCH',{retentionDays:30,expectedRevision:1})).status).toBe(200)
    const extended=await (await request('/api/chat','')).json() as {messages:{id:string}[]}
    expect(extended.messages.map(m=>m.id)).not.toContain('old')
    expect(extended.messages.map(m=>m.id)).toContain('recent')
  }finally{socket.close()}
})


it('atomically records Owner identity, previous/new policy, revisions and timestamp only for accepted saves',async()=>{
  const before=Date.now()
  expect((await request(path,'owner','PATCH',{retentionDays:7,expectedRevision:0})).status).toBe(200)
  const setting=await db.prepare("SELECT * FROM admin_settings WHERE setting_key='chat.retention'").first()
  expect(setting).toMatchObject({updated_by:'owner'})
  const audit=await db.prepare("SELECT * FROM admin_audit_log WHERE target_key='chat.retention'").first()
  expect(audit).toMatchObject({actor_user_id:'owner',action:'chat.retention.update',created_at:setting!.updated_at})
  expect(audit!.created_at).toBeGreaterThanOrEqual(before)
  expect(JSON.parse(audit!.detail_json as string)).toEqual({previous:{retentionDays:30,revision:0,hiddenBefore:0},next:JSON.parse(setting!.setting_json as string),timestamp:setting!.updated_at})
  expect((await request(path,'owner','PATCH',{retentionDays:14,expectedRevision:0})).status).toBe(409)
  expect((await request(path,'owner','PATCH',{retentionDays:31,expectedRevision:1})).status).toBe(400)
  expect(await db.prepare('SELECT count(*) AS n FROM admin_audit_log').first('n')).toBe(1)
})

it.each([false,true])('rolls back policy and actor changes when audit persistence fails (existing=%s)',async existing=>{
  if(existing)expect((await request(path,'owner','PATCH',{retentionDays:14,expectedRevision:0})).status).toBe(200)
  const previous=await db.prepare("SELECT * FROM admin_settings WHERE setting_key='chat.retention'").first()
  await db.prepare("CREATE TRIGGER fail_retention_audit BEFORE INSERT ON admin_audit_log WHEN NEW.target_key='chat.retention' BEGIN SELECT RAISE(ABORT,'fixture audit failure'); END").run()
  try{
    expect((await request(path,'owner','PATCH',{retentionDays:7,expectedRevision:existing?1:0})).status).toBe(500)
    expect(await db.prepare("SELECT * FROM admin_settings WHERE setting_key='chat.retention'").first()).toEqual(previous)
    expect(await db.prepare('SELECT count(*) AS n FROM admin_audit_log').first('n')).toBe(existing?1:0)
  }finally{await db.prepare('DROP TRIGGER fail_retention_audit').run()}
})

it('actual client retries a lost acknowledgement after policy hiding without writes or disclosure, then releases the expired requestId',async()=>{
  const ids:string[]=[],responses:Array<{status:number;body:unknown}>=[]
  let loseAck=true
  const client=createChatClient({request:async(url,init)=>{
    const body=JSON.parse(init!.body as string);ids.push(body.requestId)
    const response=await request(String(url),'user','POST',body)
    responses.push({status:response.status,body:await response.clone().json()})
    if(loseAck){loseAck=false;throw Error('fixture lost acknowledgement')}
    return response as unknown as Response
  }})
  const payload={type:'text' as const,text:'Hidden retry fixture'}
  await expect(client.send(payload)).rejects.toThrow('fixture lost acknowledgement')
  const id=(responses[0].body as {message:{id:string}}).message.id
  // Deterministic age advancement, retaining the immutable physical expiry.
  await db.prepare('UPDATE chat_messages SET created_at=? WHERE id=?').bind(Date.now()-8*86400000,id).run()
  expect((await request(path,'owner','PATCH',{retentionDays:7,expectedRevision:0})).status).toBe(200)
  const snapshot=async()=>Promise.all([
    db.prepare('SELECT * FROM chat_messages').all(),db.prepare('SELECT * FROM chat_request_receipts').all(),
    db.prepare('SELECT * FROM chat_send_state').all(),db.prepare('SELECT * FROM chat_retention_state').all(),
  ]).then(rows=>rows.map((r:{results:unknown[]})=>r.results))
  const before=await snapshot()
  await expect(client.send(payload)).rejects.toThrow('request_id_expired')
  expect(responses[1]).toEqual({status:410,body:{error:'request_id_expired'}})
  expect(ids[1]).toBe(ids[0]);expect(await snapshot()).toEqual(before)
  expect(client.messages.value).toEqual([])
  await db.prepare('DELETE FROM chat_send_state').run()
  await client.send(payload)
  expect(ids[2]).not.toBe(ids[0]);expect(responses[2].status).toBe(201)
  client.stop()
})

// Wave G exploration (task 25, L-20, design Property 15): one rank rule for delete and ban, and one
// audit entry per action that names the real target. Chat audit rows can live in either table
// (D14), so these assertions count both and look for the target ID in any column.
const MODERATION='/api/chat/moderation'
const seedMessage=async(id:string,author:string)=>{
  const now=Date.now()
  await db.prepare("INSERT INTO chat_messages(id,user_id,author_display_name,content,message_type,created_at,expires_at) VALUES(?,?,?,'Wave G moderation fixture','text',?,?)").bind(id,author,author,now,now+29*86400000).run()
  await db.prepare("UPDATE chat_retention_state SET message_count=message_count+1 WHERE room_id='global'").run()
}
const auditRows=async(adminAction:string,chatActions:string[])=>[
  ...(await db.prepare('SELECT * FROM admin_audit_log WHERE action=?').bind(adminAction).all()).results,
  ...(await db.prepare(`SELECT * FROM moderation_actions WHERE action IN (${chatActions.map(()=>'?').join(',')})`).bind(...chatActions).all()).results,
]
it('L-20: refuses a moderator deleting an owner message with 403 and leaves it visible',async()=>{
  await db.prepare('DELETE FROM moderation_actions').run()
  await seedMessage('owner-message','owner')
  const response=await request(MODERATION,'moderator','POST',{action:'delete',messageId:'owner-message'})
  expect(response.status).toBe(403)
  expect(await db.prepare("SELECT deleted_at FROM chat_messages WHERE id='owner-message'").first('deleted_at')).toBeNull()
  expect(await auditRows('chat.delete',['delete_message'])).toHaveLength(0)
})
it('L-20: an allowed moderator delete of a user message writes exactly one audit entry',async()=>{
  await db.prepare('DELETE FROM moderation_actions').run()
  await seedMessage('user-message','user')
  expect((await request(MODERATION,'moderator','POST',{action:'delete',messageId:'user-message'})).status).toBe(200)
  const rows=await auditRows('chat.delete',['delete_message'])
  expect(rows).toHaveLength(1)
  expect(JSON.stringify(rows[0])).toContain('user-message')
})
it.each([
  ['filter',{action:'filter',filter:{id:'wave-g-filter',kind:'literal',pattern:'wavegprobe',replacement:'***',enabled:true}}],
  ['remove_filter',{action:'remove_filter',filterId:'wave-g-filter'}],
] as const)('L-20: records one %s audit entry carrying the filter ID',async(action,body)=>{
  await db.prepare('DELETE FROM moderation_actions').run()
  if(action==='remove_filter')expect((await request(MODERATION,'owner','POST',{action:'filter',filter:{id:'wave-g-filter',kind:'literal',pattern:'wavegprobe',replacement:'***',enabled:true}})).status).toBe(200)
  await db.prepare('DELETE FROM admin_audit_log').run()
  expect((await request(MODERATION,'owner','POST',body)).status).toBe(200)
  const rows=await auditRows(`chat.${action}`,[action])
  expect(rows).toHaveLength(1)
  expect(JSON.stringify(rows[0])).toContain('wave-g-filter')
  expect(rows[0]).not.toMatchObject({target_key:'settings'})
  await db.prepare("DELETE FROM filter_rules WHERE id='wave-g-filter'").run()
})
