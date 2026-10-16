import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { inspectBackgroundVideo } from '../backgrounds/videoValidation'
const fixture = (name:string) => new Uint8Array(readFileSync(`tests/fixtures/background-video/${name}.mp4`))
describe('byte-derived server video validation', () => {
  it('accepts a real bounded AVC MP4 with one silent video track', async () => {
    const result=await inspectBackgroundVideo(fixture('valid'))
    expect(result).toMatchObject({ok:true,media:{kind:'video',width:320,height:180,durationMs:1000,fps:30}})
  })
  it('accepts actual 1080p cropped AVC within the primary playback envelope', async () => {
    expect(await inspectBackgroundVideo(fixture('valid-playback'), {maxWidth:1920,maxHeight:1080})).toMatchObject({ok:true,media:{width:1920,height:1080,fps:30}})
  })
  it('accepts synthetic AVC output containing standard SVC prefix NALs', async () => {
    expect(await inspectBackgroundVideo(fixture('browser-avc-prefix'))).toMatchObject({ok:true,media:{width:320,height:180,fps:30,durationMs:1000}})
  })
  it.each(['over-fps','over-size','with-audio'])('rejects %s without trusting browser metadata', async name => {
    expect((await inspectBackgroundVideo(fixture(name))).ok).toBe(false)
  })
  it('rejects malformed bytes', async () => {expect((await inspectBackgroundVideo(new Uint8Array([1,2,3]))).ok).toBe(false)})
  it('accepts the high companion but rejects forged 1080p metadata over its 1440p bitstream', async () => {
    const bytes = fixture('valid-high')
    expect((await inspectBackgroundVideo(bytes)).ok).toBe(true)
    let changed = false
    for(let i=4;i<bytes.length-32;i++) if(String.fromCharCode(...bytes.subarray(i,i+4))==='avc1') {
      new DataView(bytes.buffer).setUint16(i+28,1920)
      new DataView(bytes.buffer).setUint16(i+30,1080)
      changed = true
      break
    }
    expect(changed).toBe(true)
    expect((await inspectBackgroundVideo(bytes, {maxWidth:1920,maxHeight:1080})).ok).toBe(false)
  })
  it.each([['remove-picture','valid'],['corrupt-picture','valid'],['remove-picture','browser-avc-prefix']])('rejects %s in %s while metadata remains valid', async (mode,name) => {
    const bytes=fixture(name);const view=new DataView(bytes.buffer)
    let changed=0
    for(let box=0;box+8<=bytes.length;){
      const size=view.getUint32(box)
      if(String.fromCharCode(...bytes.subarray(box+4,box+8))==='mdat'){
        for(let at=box+8;at+4<box+size;){const length=view.getUint32(at);at+=4;const type=bytes[at]!&31;if(type===1||type===5){changed++;if(mode==='remove-picture')bytes[at]=(bytes[at]!&224)|12;else bytes.fill(0,at+1,at+length)};at+=length}
      }
      box+=size
    }
    expect(changed).toBeGreaterThan(0)
    expect((await inspectBackgroundVideo(bytes)).ok).toBe(false)
  })
  it('rejects a forged 1440p container holding 4K AVC sequence data', async () => {
    const bytes=fixture('over-size')
    // Replace avc1 sample-entry width/height; leave the actual SPS untouched.
    for(let i=4;i<bytes.length-32;i++)if(String.fromCharCode(...bytes.subarray(i,i+4))==='avc1'&&bytes[i+28]===15&&bytes[i+29]===0){new DataView(bytes.buffer).setUint16(i+28,2560);new DataView(bytes.buffer).setUint16(i+30,1440);break}
    expect((await inspectBackgroundVideo(bytes)).ok).toBe(false)
  })
})
