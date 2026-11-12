import { describe, it, expect } from 'vitest'
import { ChatRoom } from '../chat-bootstrap'

describe('dormant ChatRoom recovery',()=>{
 it('closes restored connections and stops alarms without clearing persistent data',async()=>{
  const closes:unknown[]=[]
  const socket={close:(...args:unknown[])=>closes.push(args)} as unknown as WebSocket
  let deletedAlarms=0
  const room=new ChatRoom({getWebSockets:()=>[socket],storage:{deleteAlarm:async()=>{deletedAlarms++}}})
  expect(closes).toEqual([[1012,'Chat maintenance']])
  expect(room.fetch().status).toBe(503)
  await room.alarm()
  expect(deletedAlarms).toBe(1)
  room.webSocketMessage(socket)
  expect(closes.at(-1)).toEqual([1012,'Chat maintenance'])
 })
})
