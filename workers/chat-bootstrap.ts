// Dormant forward-only lifecycle/recovery baseline. Keep D1 and all stored
// object data intact; a separate reviewed feature release enables chat.
interface DormantState {
  getWebSockets(): WebSocket[]
  storage: { deleteAlarm(): Promise<unknown> }
}
export class ChatRoom {
  constructor(private readonly state: DormantState) {
    for (const socket of state.getWebSockets()) socket.close(1012, 'Chat maintenance')
  }
  fetch(): Response { return new Response('Chat unavailable', { status: 503 }) }
  async alarm(): Promise<void> { await this.state.storage.deleteAlarm() }
  webSocketMessage(socket: WebSocket): void { socket.close(1012, 'Chat maintenance') }
  webSocketClose(socket: WebSocket): void { try { socket.close(1000) } catch { /* already closed */ } }
  webSocketError(socket: WebSocket): void { try { socket.close(1011) } catch { /* already closed */ } }
}
