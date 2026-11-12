// Opt-in, local-only browser proof. No application/provider requests or policy changes.
// node src/features/liquid-glass/studioNativeRenderer.browser.mjs
import { build } from 'esbuild'
import { chromium } from '@playwright/test'
import { createServer } from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'
import assert from 'node:assert/strict'

const here = new URL('./', import.meta.url)
const output = new URL('.validation/', here)
await mkdir(output, { recursive: true })
const bundled = await build({ stdin: { contents: `import { createStudioNativeRenderer } from './studioNativeRenderer'; window.studio = createStudioNativeRenderer(68);`, resolveDir: fileURLToPath(here), loader: 'ts' }, bundle: true, write: false, format: 'iife' })
const fixture = `const canvas=document.createElement('canvas');canvas.width=800;canvas.height=600;const ctx=canvas.getContext('2d');let frame=0;window.freeze=false;function tick(){if(!window.freeze){ctx.fillStyle='#172c47';ctx.fillRect(0,0,800,600);for(let x=-30;x<840;x+=22){ctx.fillStyle=x%44===0?'#f3d69b':'#79b0d0';ctx.fillRect(x+frame%22,0,7,600)}frame++}requestAnimationFrame(tick)}tick();const video=document.querySelector('video');video.srcObject=canvas.captureStream(20);video.play();`
const html = '<!doctype html><link rel="stylesheet" href="/fixture.css"><video autoplay muted playsinline></video><section data-studio-glass-surface><button>Readable foreground</button></section><script src="/fixture.js"></script><script src="/renderer.js"></script>'
const css = `html,body{margin:0}video{position:fixed;inset:0;width:800px;height:600px;object-fit:fill}section{position:absolute;left:80px;top:80px;width:600px;height:400px;border-radius:32px;z-index:1;--studio-native-blur:0px}button{position:absolute;left:220px;top:180px}${await readFile(new URL('StudioGlassEnvironment.css', here),'utf8')}`
const violations = [], requests = []
const server = createServer(async (req, res) => {
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; media-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'")
  try {
    const path = new URL(req.url, 'http://localhost').pathname
    if (path === '/fixture.css') { res.setHeader('Content-Type', 'text/css'); res.end(css) }
    else if (path === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(fixture) }
    else if (path === '/renderer.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(bundled.outputFiles[0].text) }
    else if (/^\/glass\/refraction\/[ce]-[a-z0-9-]+\.png$/.test(path)) {
      res.setHeader('Content-Type','image/png'); res.end(await readFile(new URL(`../../..${path.replace('/glass','/public/glass')}`, here)))
    } else if (path === '/') res.end(html)
    else { res.statusCode=404;res.end() }
  } catch { res.statusCode=404;res.end() }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
const browser = await chromium.launch({ channel:'chrome', headless:true })
// Small PNG reader for screenshot pixel assertions; supports Chrome's RGB/RGBA8.
function pixels(buffer) {
  let at=8,w,h,channels;const parts=[]
  while(at<buffer.length){const length=buffer.readUInt32BE(at),type=buffer.toString('ascii',at+4,at+8),data=buffer.subarray(at+8,at+8+length);if(type==='IHDR'){w=data.readUInt32BE(0);h=data.readUInt32BE(4);assert.equal(data[8],8);channels=data[9]===2?3:4}if(type==='IDAT')parts.push(data);at+=12+length}
  const raw=inflateSync(Buffer.concat(parts)),stride=w*channels,out=Buffer.alloc(h*stride)
  for(let y=0;y<h;y++){const filter=raw[y*(stride+1)];for(let x=0;x<stride;x++){const left=x>=channels?out[y*stride+x-channels]:0,up=y?out[(y-1)*stride+x]:0,ul=y&&x>=channels?out[(y-1)*stride+x-channels]:0,p=left+up-ul,pa=Math.abs(p-left),pb=Math.abs(p-up),pc=Math.abs(p-ul);const add=[0,left,up,Math.floor((left+up)/2),pa<=pb&&pa<=pc?left:pb<=pc?up:ul][filter];out[y*stride+x]=(raw[y*(stride+1)+1+x]+add)&255}}
  return {w,h,channels,data:out}
}
function difference(a,b,rect){a=pixels(a);b=pixels(b);let sum=0,count=0;for(let y=rect.y;y<rect.y+rect.h;y++)for(let x=rect.x;x<rect.x+rect.w;x++)for(let c=0;c<3;c++){sum+=Math.abs(a.data[(y*a.w+x)*a.channels+c]-b.data[(y*b.w+x)*b.channels+c]);count++}return sum/count}
try {
  const page=await browser.newPage({viewport:{width:800,height:600}})
  await page.exposeFunction('reportViolation', value => violations.push(value))
  await page.addInitScript(() => document.addEventListener('securitypolicyviolation',event => window.reportViolation({directive:event.violatedDirective,uri:event.blockedURI})))
  page.on('request', request => requests.push(request.url()))
  await page.goto(origin)
  await page.waitForSelector('[data-studio-glass-ready="true"]')
  await page.waitForFunction(() => document.querySelector('video').currentTime > 0.1)
  await page.evaluate(() => { window.freeze=true })
  await page.waitForTimeout(200)
  await page.evaluate(() => document.querySelector('video').pause())
  const on=await page.screenshot()
  await page.evaluate(() => window.studio.setEdge(0))
  const off=await page.screenshot()
  const edgeDelta=difference(on,off,{x:81,y:130,w:18,h:280})
  const centreDelta=difference(on,off,{x:200,y:180,w:100,h:80})
  assert.ok(edgeDelta>2, `edge must visibly refract: ${edgeDelta}`)
  assert.ok(centreDelta<0.5, `centre must remain neutral: ${centreDelta}`)
  await page.evaluate(() => { window.studio.setEdge(68);window.freeze=false;document.querySelector('video').play() })
  await page.waitForTimeout(150);const liveA=await page.screenshot();await page.waitForTimeout(220);const liveB=await page.screenshot()
  const liveDelta=difference(liveA,liveB,{x:81,y:130,w:18,h:280});assert.ok(liveDelta>2)
  assert.equal(await page.locator('video').count(),1)
  assert.equal(await page.locator('canvas').count(),0)
  assert.deepEqual(violations,[]);assert.ok(requests.every(url=>url.startsWith(origin)))
  const result={browser:await browser.version(),edgeDelta,centreDelta,liveDelta,violations,requests:requests.length,videoElements:1,rendererCanvases:0}
  await writeFile(new URL('native-on.png',output),on);await writeFile(new URL('native-off.png',output),off)
  await writeFile(new URL('native-result.json',output),JSON.stringify(result,null,2));console.log(JSON.stringify(result))
  await page.evaluate(()=>window.studio.destroy());assert.equal(await page.locator('[data-studio-optics-owned]').count(),0)
} finally { await browser.close(); await new Promise(resolve=>server.close(resolve)) }
