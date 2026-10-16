import { BufferSource, EncodedPacketSink, Input, MP4 } from 'mediabunny'
import { BACKGROUND_VIDEO_MAX_BYTES, type BackgroundMediaInspection } from './mediaValidation'
import { BACKGROUND_VIDEO_MAX_DURATION_SECONDS, BACKGROUND_VIDEO_MAX_FPS, BACKGROUND_VIDEO_MAX_HEIGHT, BACKGROUND_VIDEO_MAX_WIDTH } from '../../src/features/backgrounds/videoPolicy'

/** Read AVC sequence dimensions from the bitstream, not caller/container claims. */
interface VideoDimensionsCap { maxWidth: number; maxHeight: number }
const highCap: VideoDimensionsCap = { maxWidth: BACKGROUND_VIDEO_MAX_WIDTH, maxHeight: BACKGROUND_VIDEO_MAX_HEIGHT }

function spsSize(nal: Uint8Array, cap: VideoDimensionsCap): { width: number; height: number; id: number } {
  if ((nal[0]! & 31) !== 7 || nal.length > 1024) throw new Error()
  const bytes = [...nal.slice(1)].filter((value, i, raw) => !(value === 3 && i > 1 && raw[i-1] === 0 && raw[i-2] === 0))
  let offset = 0
  const bits = (count: number): number => {
    if (offset + count > bytes.length * 8) throw new Error()
    let value = 0
    for (let i=0;i<count;i++) { value = value * 2 + ((bytes[offset >> 3]! >> (7-(offset & 7))) & 1); offset++ }
    return value
  }
  const ue = (): number => { let zeros=0; while(bits(1)===0) { if(++zeros>24) throw new Error() }; return 2**zeros-1+bits(zeros) }
  const se = (): number => { const code=ue(); return code%2 ? (code+1)/2 : -code/2 }
  const profile = bits(8); bits(16); const id=ue();if(id>31)throw new Error()
  let chroma=1
  if ([100,110,122,244,44,83,86,118,128,138,139,134,135].includes(profile)) {
    chroma=ue(); if(chroma>3)throw new Error();if(chroma===3&&bits(1))chroma=0
    ue();ue();bits(1)
    if(bits(1)) for(let i=0;i<(chroma===3?12:8);i++)if(bits(1)) {
      let last=8,next=8
      for(let j=0;j<(i<6?16:64);j++){if(next!==0)next=(last+se()+256)%256;last=next===0?last:next}
    }
  }
  ue();const order=ue()
  if(order===0)ue()
  else if(order===1){bits(1);se();se();const count=ue();if(count>256)throw new Error();for(let i=0;i<count;i++)se()}
  else if(order!==2)throw new Error()
  ue();bits(1);const width=(ue()+1)*16,heightInUnits=ue()+1,frame=bits(1)
  if(!frame)bits(1);bits(1)
  const crop=bits(1)?[ue(),ue(),ue(),ue()]:[0,0,0,0]
  // AVC pads coded frames to macroblocks: 1080p commonly stores 1088 rows.
  if(width>Math.ceil(cap.maxWidth/16)*16||heightInUnits*16*(2-frame)>Math.ceil(cap.maxHeight/16)*16)throw new Error()
  const cropX=chroma===0||chroma===3?1:2,cropY=(chroma===1?2:1)*(2-frame)
  return {width:width-(crop[0]!+crop[1]!)*cropX,height:heightInUnits*16*(2-frame)-(crop[2]!+crop[3]!)*cropY,id}
}
function nalUnsignedFields(nal: Uint8Array, count: number): number[] {
  const bytes=[...nal.subarray(1,33)].filter((value,i,raw)=>!(value===3&&i>1&&raw[i-1]===0&&raw[i-2]===0))
  let bit=0
  const read=()=>{if(bit>=bytes.length*8)throw new Error();return (bytes[bit>>3]!>>(7-(bit++&7)))&1}
  return Array.from({length:count},()=>{let zeros=0;while(read()===0)if(++zeros>24)throw new Error();let value=0;for(let i=0;i<zeros;i++)value=value*2+read();return 2**zeros-1+value})
}
const withinCap = ({width,height}:{width:number;height:number}, cap: VideoDimensionsCap) => width>0&&height>0&&width<=cap.maxWidth&&height<=cap.maxHeight

export async function inspectBackgroundVideo(bytes: Uint8Array, cap: VideoDimensionsCap = highCap): Promise<BackgroundMediaInspection> {
  if(bytes.length>BACKGROUND_VIDEO_MAX_BYTES)return {ok:false,error:'media_too_large'}
  const input=new Input({source:new BufferSource(bytes),formats:[MP4]})
  try {
    const tracks=await input.getTracks()
    if(tracks.length!==1||!tracks[0]!.isVideoTrack())throw new Error()
    const track=tracks[0]!
    if(await track.getCodec()!=='avc')throw new Error()
    const width=await track.getDisplayWidth(),height=await track.getDisplayHeight()
    if(!withinCap({width,height},cap))return {ok:false,error:'invalid_dimensions'}
    const config=await track.getDecoderConfig()
    if(!config?.codec.startsWith('avc1.')||!config.description)throw new Error()
    const desc=config.description instanceof ArrayBuffer?new Uint8Array(config.description):new Uint8Array(config.description.buffer,config.description.byteOffset,config.description.byteLength)
    if(desc.length<8||desc[0]!==1)throw new Error()
    const nalLength=(desc[4]!&3)+1,count=desc[5]!&31
    if(count<1||count>4)throw new Error()
    let offset=6
    const spsIds=new Set<number>(),ppsIds=new Set<number>()
    for(let i=0;i<count;i++){
      if(offset+2>desc.length)throw new Error()
      const length=(desc[offset]!<<8)|desc[offset+1]!;offset+=2
      if(length<1||offset+length>desc.length)throw new Error()
      const sps=spsSize(desc.subarray(offset,offset+length),cap)
      if(!withinCap(sps,cap))return {ok:false,error:'invalid_dimensions'}
      spsIds.add(sps.id)
      offset+=length
    }
    const ppsCount=desc[offset++]
    if(!ppsCount||ppsCount>16)throw new Error()
    for(let i=0;i<ppsCount;i++){
      if(offset+2>desc.length)throw new Error()
      const length=(desc[offset]!<<8)|desc[offset+1]!;offset+=2
      if(length<2||offset+length>desc.length||(desc[offset]!&31)!==8)throw new Error()
      const [pps,sps]=nalUnsignedFields(desc.subarray(offset,offset+length),2)
      if(pps!>255||!spsIds.has(sps!))throw new Error();ppsIds.add(pps!)
      offset+=length
    }
    const duration=await track.computeDuration()
    if(Math.abs(await track.getFirstTimestamp())>.001)throw new Error()
    if(!Number.isFinite(duration)||duration<=0||duration>BACKGROUND_VIDEO_MAX_DURATION_SECONDS+.001)throw new Error()
    let packetCount=0
    for await(const packet of new EncodedPacketSink(track).packets()) {
      if(++packetCount>3601)throw new Error()
      const data=packet.data
      let firstPictureSlice=false
      for(let at=0;at<data.length;){
        if(at+nalLength>data.length)throw new Error()
        let length=0;for(let j=0;j<nalLength;j++)length=length*256+data[at+j]!
        at+=nalLength;if(length<1||at+length>data.length)throw new Error()
        const type=data[at]!&31,nal=data.subarray(at,at+length)
        // Chromium's AVC encoder emits a standard SVC prefix (type 14) before
        // each ordinary type 1/5 picture. It is metadata, never picture proof.
        if((data[at]!&128)||![1,5,6,7,8,9,10,11,12,14].includes(type))throw new Error()
        if(type===14&&length<4)throw new Error()
        if(type===7){const sps=spsSize(nal,cap);if(!withinCap(sps,cap))return {ok:false,error:'invalid_dimensions'};spsIds.add(sps.id)}
        if(type===8){const [pps,sps]=nalUnsignedFields(nal,2);if(pps!>255||!spsIds.has(sps!))throw new Error();ppsIds.add(pps!)}
        if(type===1||type===5){
          if(length<5)throw new Error()
          const [firstMb,sliceType,pps]=nalUnsignedFields(nal,3)
          if(firstMb!>=Math.ceil(width/16)*Math.ceil(height/16)||sliceType!>9||!ppsIds.has(pps!))throw new Error()
          if(firstMb===0)firstPictureSlice=true
        }
        at+=length
      }
      if(!firstPictureSlice)throw new Error()
    }
    const metrics=await track.computeFrameRateMetrics({targetPacketCount:Infinity})
    if(!packetCount||!Number.isFinite(metrics.maxFrameRate)||metrics.maxFrameRate>BACKGROUND_VIDEO_MAX_FPS+.0001)throw new Error()
    return {ok:true,media:{kind:'video',contentType:'video/mp4',extension:'mp4',bytes:bytes.length,width,height,durationMs:Math.round(duration*1000),fps:Math.min(BACKGROUND_VIDEO_MAX_FPS,metrics.bestGuessFrameRate)}}
  }catch{return {ok:false,error:'invalid_media'}}finally{input.dispose()}
}
