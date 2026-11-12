import { createApp, h, nextTick, watch } from 'vue'
import PlayerBar from '../../src/features/player/PlayerBar.vue'
import { createPlaybackStore } from '../../src/features/player/store'
import { ProviderRegistry } from '../../src/features/player/providers/registry'
import { inspectBuffer } from '../../src/features/player/bufferReadiness'
import { playbackLog } from '../../src/features/player/playbackLog'
import type { Track } from '../../src/features/catalog/types'
import type { TransitionMode } from '../../src/features/player/transitionEngine'

const output = document.querySelector('#result')!
const make = (id: string, title = id, externalId = id): Track => ({
  id, title, aliases: {}, games: ['genshin'], tabs: ['focus'], relationIds: [], workGroupId: 'fixture',
  vocalStatus: 'instrumental', needsClassification: false, sources: [{provider:'chksz',externalId}],
})
let resolveCounts: Record<string, number> = {}
const provider = { id: 'lx', canResolve: () => true, resolve: async (t: Track) => {
  resolveCounts[t.id] = (resolveCounts[t.id] || 0) + 1
  return {kind:'audio' as const, url: location.origin + '/__transition/media/' + t.id, mimeType:'audio/wav'}
} }
const registry = new ProviderRegistry([{provider, enabled:true, priority:1, timeoutMs:1000}])
const store = createPlaybackStore({loadRegistry: () => Promise.resolve(registry),
  storage: {getItem: key => key.includes('shuffle') ? 'false' : null, setItem: () => {}}})
createApp({render: () => h(PlayerBar, {store})}).mount('#player')
const active = () => document.querySelector<HTMLAudioElement>('[data-audio-role="active"]')
const standby = () => document.querySelector<HTMLAudioElement>('[data-audio-role="standby"]')
let report: Record<string, unknown> = {phase:'ready'}
let running = false
let lastCommitAt = performance.now()
watch(() => store.currentTrack.value?.id, () => {lastCommitAt = performance.now()}, {flush:'sync'})
let longTaskMs = 0
try {new PerformanceObserver(list => {for (const entry of list.getEntries()) longTaskMs += entry.duration}).observe({type:'longtask', buffered:false})} catch { /* Optional browser metric. */ }
const heap = () => (performance as Performance & {memory?: {usedJSHeapSize: number}}).memory?.usedJSHeapSize
const show = () => {
  const el = active()
  output.textContent = JSON.stringify({...report, current:store.currentTrack.value?.id, provider:store.activeProviderId.value,
    intent:store.playbackIntent.value, status:store.status.value, visibility:document.visibilityState,
    active:el ? {time:el.currentTime, duration:el.duration, paused:el.paused, ...inspectBuffer(el)} : null,
    standby:inspectBuffer(standby(),5.5), resolves:resolveCounts,
    events:playbackLog.snapshot().filter(e => /^(transition\.|preparation\.|resolve\.failed)/.test(e.type)).slice(-25)}, null, 2)
}
setInterval(show,500)
const mode = () => {
  store.setTransitionMode?.((document.querySelector('#mode') as HTMLSelectElement).value as TransitionMode)
  store.setCrossfadeDuration?.(5)
}
document.querySelector('#mode')!.addEventListener('change', mode)
async function start(_real = false) {
  store.stop(); resolveCounts = {}; playbackLog.clear(); mode(); store.setVolume(.12)
  store.setRepeatMode('all')
  // Original controlled tracks; operators supply their own separately licensed live inputs.
  const tracks = ['a','b','quiet'].map(id => ({...make(id),sources:[{provider:'lx',externalId:id}]}))
  store.reconcileUpcomingQueue(tracks)
  report = {phase:'controlled'}
  await store.playQueueIndex(0); await nextTick()
  show()
}
async function wait(predicate: () => boolean, ms = 15000) {
  const deadline = performance.now() + ms
  while (!predicate()) {
    if (!running || performance.now() >= deadline) throw new Error('Measurement stopped or timed out')
    await new Promise(resolve => setTimeout(resolve,50))
  }
}
document.querySelector('#start')!.addEventListener('click', () => {void start().catch(() => {report={phase:'failed'};show()})})
document.querySelector('#live')!.addEventListener('click', () => {void start(true).catch(() => {report={phase:'live-unavailable'};show()})})
document.querySelector('#near-end')!.addEventListener('click', () => {const el=active(); if(el && Number.isFinite(el.duration)) el.currentTime=el.duration-8})
document.querySelector('#stop')!.addEventListener('click', () => {running=false;store.stop();report={...report,phase:'stopped'};show()})
document.querySelector('#measure')!.addEventListener('click', async () => {
  if(running) return
  running=true
  const results: Array<Record<string, unknown>> = []
  const heapBefore=heap(), longTasksBefore=longTaskMs, measuredAt=performance.now()
  try {
    await start(); report={phase:'measuring'}
    for(let index=0; index<6; index++) {
      await wait(() => !!standby() && inspectBuffer(standby(),5.5).ready)
      const from=active()!, to=standby()!, prepared=store.preparedNext.value!
      const url=to.getAttribute('src'), trackId=prepared.track.id, readiness=inspectBuffer(to,5.5)
      const before=(await (await fetch('/__transition/requests')).json()).requests
      let progressAt=0, handoffAt=0, bothPausedMs=0, maxTimerIntervalMs=0, last=performance.now()
      const onProgress=() => {if(!progressAt && to.currentTime>.08){progressAt=performance.now();handoffAt=lastCommitAt}}
      to.addEventListener('timeupdate',onProgress)
      const timer=setInterval(() => {
        const now=performance.now(); maxTimerIntervalMs=Math.max(maxTimerIntervalMs,now-last)
        if(from.paused && to.paused) bothPausedMs+=now-last
        last=now
      },20)
      try {
        const started=performance.now()
        const lead = store.transitionMode?.value === 'smart' ? 8 : store.transitionMode?.value === 'crossfade' ? 4.5 : .6
        from.currentTime=from.duration-lead
        await wait(() => active()===to && progressAt>0,12000)
        await wait(() => document.querySelector('.player-bar')?.getAttribute('data-transition-active')!=='true',9000)
        const after=(await (await fetch('/__transition/requests')).json()).requests
        results.push({mode:store.transitionMode?.value??'baseline-off',trackId,readyBefore:readiness.ready,
          bufferedSeconds:readiness.bufferedSeconds,reused:active()===to,sourceUnchanged:to.getAttribute('src')===url,
          extraMediaRequests:(after['/__transition/media/'+trackId]||0)-(before['/__transition/media/'+trackId]||0),
          observedBothPausedMs:bothPausedMs, scheduledToProgressMs:progressAt-started,
          handoffToProgressMs:progressAt-handoffAt,maxTimerIntervalMs,
          transition:playbackLog.snapshot().filter(event => event.type === 'transition.start').at(-1) ?? null})
        report={phase:'measuring',results};show()
      } finally {clearInterval(timer);to.removeEventListener('timeupdate',onProgress)}
    }
    const latencies=results.map(r => Number(r.handoffToProgressMs)).sort((a,b)=>a-b)
    report={phase:'complete',results,medianMs:(latencies[2]+latencies[3])/2,p95Ms:latencies[5],
      heapBefore,heapAfter:heap(),longTaskMs:longTaskMs-longTasksBefore,elapsedMs:performance.now()-measuredAt,userAgent:navigator.userAgent}
  } catch(error) {report={phase:'failed',error:String(error),results}}
  finally {running=false;store.pause();active()?.pause();show()}
})
