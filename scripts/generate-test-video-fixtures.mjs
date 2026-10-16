// Original synthetic fixtures: solid-colour video and a generated sine tone only.
// No downloaded audio, artwork, recordings, or project media are used.
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { BufferSource, BufferTarget, EncodedPacket, EncodedPacketSink, EncodedVideoPacketSource, Input, MP4, Mp4OutputFormat, Output } from 'mediabunny'
const directory = 'tests/fixtures/background-video'
mkdirSync(directory, {recursive:true})
const ffmpeg = (...args) => {
  const result = spawnSync('ffmpeg', ['-hide_banner','-loglevel','error','-y',...args], {stdio:'inherit'})
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error('ffmpeg fixture generation failed')
}
const video = (name,width,height,fps,audio=false) => ffmpeg(
  '-f','lavfi','-i',`color=c=0x224466:s=${width}x${height}:r=${fps}:d=1`,
  ...(audio ? ['-f','lavfi','-i','sine=frequency=440:duration=1'] : []),
  '-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-bf','0',
  ...(audio ? ['-c:a','aac','-shortest'] : ['-an']),
  '-map_metadata','-1','-movflags','+faststart',`${directory}/${name}.mp4`,
)
video('valid',320,180,30)
video('valid-playback',1920,1080,30)
video('valid-high',2560,1440,30)
video('over-fps',320,180,120)
video('over-size',3840,2160,30)
video('with-audio',320,180,30,true)
ffmpeg('-f','lavfi','-i','color=c=0x224466:s=320x180','-frames:v','1','-map_metadata','-1',`${directory}/poster.jpg`)
// Reproduce the SVC-prefix parser boundary with explicitly synthetic NAL metadata.
// This fixture exercises type 14 handling; it does not claim browser provenance.
const input = new Input({source:new BufferSource(readFileSync(`${directory}/valid.mp4`)),formats:[MP4]})
const track = await input.getPrimaryVideoTrack()
const config = await track.getDecoderConfig()
const target = new BufferTarget()
const output = new Output({format:new Mp4OutputFormat(),target})
const source = new EncodedVideoPacketSource('avc')
output.addVideoTrack(source)
await output.start()
for await(const packet of new EncodedPacketSink(track).packets()) {
  const data = new Uint8Array(packet.data.length+8)
  data.set([0,0,0,4,0x6e,0x80,0x80,0x07])
  data.set(packet.data,8)
  await source.add(new EncodedPacket(data,packet.type,packet.timestamp,packet.duration),{decoderConfig:config})
}
source.close()
await output.finalize()
writeFileSync(`${directory}/browser-avc-prefix.mp4`,new Uint8Array(target.buffer))
input.dispose()
console.log('Generated seven synthetic MP4 fixtures and one solid-colour JPEG.')