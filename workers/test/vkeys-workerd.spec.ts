import { afterAll, beforeAll, expect, it } from 'vitest'
import { build } from 'esbuild'
import { Miniflare } from './miniflare-compat'
let mf: Miniflare
beforeAll(async()=>{
 const result=await build({stdin:{contents:`import { createVkeysHandler } from './workers/providers/vkeysRoutes';
 const MID='SYNTHETICMID01';
 const body=new Uint8Array(5000);body.set([255,251,144,0]);
 const env={PUBLIC_ORIGIN:'https://study.example',VKEYS_ENABLED:'true',DB:{prepare:()=>({all:async()=>({results:[{providerKey:'vkeys',enabled:1,priority:50}]})})}};
 const allow={limit:async()=>({success:true})};
 const transport=async(input,init)=>{const u=new URL(input);if(u.hostname==='api.vkeys.cn')return Response.json({code:0,data:u.pathname.endsWith('/info')?{songMID:MID,title:'Synthetic Study Track',singer:'Synthetic Artist',interval:149,pay:'免费',qualityInfo:[{type:6,size:5000}]}:{songMID:MID,url:'https://stream.qqmusic.qq.com/test.mp3'}});const requestedRange=new Headers(init?.headers).get('range');if(requestedRange==='bytes=0-4095'&&new Headers(init?.headers).get('if-match')!=='"workerd-fixture-v1"')throw new Error('Independent prefix requires the representation If-Match');const match=/^bytes=(\\d+)-(\\d*)$/.exec(new Headers(init?.headers).get('range')??'');const start=match?+match[1]:0,end=match?.[2]?Math.min(+match[2],body.length-1):body.length-1;return new Response(body.slice(start,end+1),{status:match?206:200,headers:{'content-type':'application/x-www-form-urlencoded',etag:'"workerd-fixture-v1"','content-length':String(end-start+1),...(match?{'content-range':'bytes '+start+'-'+end+'/'+body.length}:{})}})};
 export default{fetch(request){return createVkeysHandler(env,{fetch:transport,limiter:allow,globalLimiter:allow,identities:[{trackId:'synthetic-track',neteaseId:'900000001',tencentMid:MID,title:'Synthetic Study Track',titleAliases:[],artists:['Synthetic Artist'],durationSeconds:149}]}).fetch(request)}}`,resolveDir:process.cwd(),loader:'ts'},bundle:true,format:'esm',platform:'browser',write:false})
 mf=new Miniflare({modules:true,script:result.outputFiles[0]!.text,compatibilityDate:'2025-12-01'})
})
afterAll(async()=>{await mf?.dispose()})
it('bundles and streams corrected MP3 with real workerd Cache API and Range',async()=>{
 const resolved=await mf.dispatchFetch('https://study.example/api/providers/vkeys/resolve',{method:'POST',headers:{origin:'https://study.example','content-type':'application/json'},body:JSON.stringify({externalId:'synthetic-track'})})
 expect(resolved.status).toBe(200)
 const ticket=await resolved.json() as {url:string}
 const full=await mf.dispatchFetch('https://study.example'+ticket.url)
 expect(full.status).toBe(200);expect(full.headers.get('content-type')).toBe('audio/mpeg');expect((await full.arrayBuffer()).byteLength).toBe(5000)
 const seek=await mf.dispatchFetch('https://study.example'+ticket.url,{headers:{range:'bytes=4500-4599'}})
 expect(seek.status).toBe(206);expect(seek.headers.get('content-type')).toBe('audio/mpeg');expect(seek.headers.get('content-range')).toBe('bytes 4500-4599/5000');expect((await seek.arrayBuffer()).byteLength).toBe(100)
})
