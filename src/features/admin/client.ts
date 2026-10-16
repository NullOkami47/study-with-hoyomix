import type {ImportBatch,Decision} from '../../../workers/catalogue/types'
import type { BackgroundUploadOptions } from './backgroundTranscode'
export type {ImportBatch,Proposal,ChangeKind} from '../../../workers/catalogue/types'
export interface CatalogueStatus {configured:boolean;role:AdminRole;sheetUrl:string|null;serviceAccountEmail:string|null;lastBatch:ImportBatch|null}
export type AdminRole = 'admin' | 'owner'

export type ProviderStatus = 'unknown' | 'healthy' | 'degraded' | 'unavailable'

export interface ChkszOwnerFallbackState {
  ownerKeyConfigured: boolean
  ownerFallbackEnabled: boolean
  ownerFallbackUsable: boolean
}

export interface AdminProvider {
  key: string
  adminEnabled: boolean
  deploymentAvailable: boolean
  effectiveEnabled: boolean
  automaticPolicy: 'direct' | 'never'
  priority: number
  status: ProviderStatus
  failureClass: string | null
  latencyMs: number | null
  checkedAt: number | null
  updatedAt: number
  ownerKeyConfigured?: boolean
  ownerFallbackEnabled?: boolean
  ownerFallbackUsable?: boolean
}

export interface AdminOverview {
  providers: AdminProvider[]
  activeNoticeCount: number
}

export interface AdminAuditEntry {
  id: string
  actorUserId: string | null
  action: string
  targetKey: string
  detail: Record<string, unknown>
  createdAt: number
}

export interface AdminAuditPage {
  entries: AdminAuditEntry[]
  total: number
  exportedCount?: number
  complete?: boolean
  snapshotComplete?: boolean
  consistency?: string
  limit: number
  offset: number
}

export interface AdminAuditFilter {
  actor?: string
  action?: string
  target?: string
  module?: string
  from?: number
  to?: number
  limit?: number
  offset?: number
}

export type NoticeStatus = 'draft' | 'published' | 'archived'
export type NoticeSeverity = 'info' | 'warning' | 'critical'
export type NoticeTargeting = 'everyone' | 'authenticated' | 'anonymous' | 'admin'
export type Locale = 'zh-Hant' | 'zh-Hans' | 'en'
export type NoticeContent = Partial<Record<Locale, string>>

export interface AdminNotice {
  id: string
  revisionId: string
  status: NoticeStatus
  severity: NoticeSeverity
  targeting: NoticeTargeting
  content: NoticeContent
  startAt: number | null
  endAt: number | null
  createdAt: number
  updatedAt: number
  publishedAt: number | null
  archivedAt: number | null
}

export interface PublicNotice {
  id: string
  revisionId: string
  severity: NoticeSeverity
  targeting: NoticeTargeting
  content: NoticeContent
  startAt: number | null
  endAt: number | null
  publishedAt: number
}

export interface AdminNoticeInput {
  severity: NoticeSeverity
  targeting: NoticeTargeting
  content: NoticeContent
  startAt: number | null
  endAt: number | null
}

export interface AdminNoticePatch {
  severity?: NoticeSeverity
  targeting?: NoticeTargeting
  content?: NoticeContent
  startAt?: number | null
  endAt?: number | null
}

export interface AdminSession {
  role: AdminRole
}

export type BackgroundStatus = 'draft' | 'published' | 'archived'

export interface AdminBackgroundHighQualityVersion {
  mediaUrl: string
  width: number
  height: number
  fps: number
  byteSize: number
}

export interface AdminBackground {
  id: string
  revision: number
  status: BackgroundStatus
  kind: 'image' | 'video'
  contentType: string
  byteSize: number
  width: number
  height: number
  durationMs: number | null
  fps?: number | null
  mediaUrl: string
  posterUrl: string | null
  rightsStatus: string
  title?: string
  game?: string
  collection?: string
  displayOrder?: number
  isShipped?: boolean
  highQualityVersion?: AdminBackgroundHighQualityVersion
  createdAt: number
  updatedAt: number
  publishedAt: number | null
  archivedAt: number | null
}

/** The editable presentation metadata accepted by `PATCH /api/admin/backgrounds/:id`. */
export interface AdminBackgroundMetadataPatch {
  title?: string | null
  game?: string | null
  collection?: string | null
  displayOrder?: number | null
}

export type AdminSessionResult =
  | { status: 'authorised'; role: AdminRole }
  | { status: 'unauthorised' }
  | { status: 'unavailable' }

export type CatalogueGame = 'genshin' | 'hsr' | 'zzz'
export type CatalogueTab = 'focus' | 'sleep' | 'chill'
export type CatalogueVocalStatus = 'instrumental' | 'vocal' | 'uncertain'

export interface AdminCatalogueTrack {
  id: string
  title: string
  album: string | null
  releaseDate: string | null
  workGroupId: string
  vocalStatus: CatalogueVocalStatus
  tabs: CatalogueTab[]
  games: CatalogueGame[]
  needsClassification: boolean
  updatedAt: number
}

export interface AdminCatalogueTrackSource {
  sourceRowId: string
  provider: string
  externalId: string
  sourceType: string
  sourceStatus: string
  rightsStatus: string
  evidence: string | null
  notes: string | null
}

export interface AdminCatalogueTrackDetail extends AdminCatalogueTrack {
  metadataConfidence: number | null
  evidence: string | null
  notes: string | null
  relations: string[]
  aliases: Record<string, string[]>
  sources: AdminCatalogueTrackSource[]
}

export interface AdminCatalogueIndex {
  revision: number
  albums: string[]
  tracks: AdminCatalogueTrack[]
}

/** The editable catalogue metadata, mirroring `ALLOWED_STRUCTURAL_FIELDS.track`. */
export interface AdminCatalogueTrackEdit {
  title?: string
  album?: string | null
  release_date?: string | null
  work_group_id?: string
  vocal_status?: CatalogueVocalStatus
  focus?: boolean
  sleep?: boolean
  chill?: boolean
  needs_classification?: boolean
  metadata_confidence?: number | null
  evidence?: string | null
  notes?: string | null
}

export interface AdminCatalogueTrackEditResult {
  revision: number
  track: AdminCatalogueTrackDetail
}

interface AdminRepositoryOptions {
  fetch?: typeof fetch
}

export interface AdminRepository {
  getCatalogueStatus():Promise<CatalogueStatus>
  syncCatalogue(resync?:boolean):Promise<ImportBatch>
  exportCatalogueSheet():Promise<{exported:boolean}>
  getCatalogueBatch(batchId:string):Promise<ImportBatch>
  decideCatalogueChange(batchId:string,changeId:string,decision:Exclude<Decision,'pending'>,reviewRevision:number):Promise<ImportBatch>
  editCatalogueChange(batchId:string,changeId:string,after:Record<string,unknown>,reviewRevision:number):Promise<ImportBatch>
  approveCatalogueR2AsOwner(batchId:string,changeId:string,reviewRevision:number):Promise<ImportBatch>
  approveCatalogueHighConfidence(batchId:string,reviewRevision:number):Promise<ImportBatch>
  publishCatalogueBatch(batchId:string,reviewRevision:number):Promise<ImportBatch>
  listCatalogueTracks():Promise<AdminCatalogueIndex>
  getCatalogueTrack(trackId:string):Promise<AdminCatalogueTrackDetail>
  updateCatalogueTrack(
    trackId:string,
    changes:AdminCatalogueTrackEdit,
    expectedRevision:number,
  ):Promise<AdminCatalogueTrackEditResult>
  getOverview(): Promise<AdminOverview>
  listAudit(filter?: AdminAuditFilter): Promise<AdminAuditPage>
  exportAudit(filter?: AdminAuditFilter): Promise<AdminAuditPage>
  updateProvider(
    key: string,
    update: { enabled?: boolean; priority?: number; confirmation?: string; reason?: string },
  ): Promise<AdminProvider>
  updateProviderOrder(providerIds: readonly string[]): Promise<AdminProvider[]>
  updateChkszOwnerFallback(enabled: boolean): Promise<ChkszOwnerFallbackState>
  listNotices(): Promise<AdminNotice[]>
  createNotice(input: AdminNoticeInput): Promise<AdminNotice>
  getNotice(id: string): Promise<AdminNotice>
  patchNotice(id: string, patch: AdminNoticePatch): Promise<AdminNotice>
  publishNotice(id: string): Promise<AdminNotice>
  archiveNotice(id: string): Promise<AdminNotice>
  listPublicNotices(): Promise<PublicNotice[]>
  listBackgrounds(): Promise<AdminBackground[]>
  patchBackgroundMetadata(id: string, patch: AdminBackgroundMetadataPatch): Promise<AdminBackground>
  uploadBackground(file: File, options?: BackgroundUploadOptions): Promise<AdminBackground>
  replaceBackground(id: string, file: File, options?: BackgroundUploadOptions): Promise<AdminBackground>
  publishBackground(id: string): Promise<AdminBackground>
  archiveBackground(id: string): Promise<AdminBackground>
  restoreBackground(id: string): Promise<AdminBackground>
  purgeBackground(id: string): Promise<void>
  checkSession(): Promise<AdminSessionResult>
}

const jsonBody = async <T>(response: Response): Promise<T> => {
  if (!response.ok) throw new Error(`admin_${response.status}`)
  return response.json() as Promise<T>
}

const auditFilterToQuery = (filter?: AdminAuditFilter): string => {
  if (!filter) return ''
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(filter)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value))
  }
  const query = params.toString()
  return query ? `?${query}` : ''
}

const mutationHeaders = (origin: string): HeadersInit => ({
  'content-type': 'application/json',
  origin,
})

export function createAdminRepository(options: AdminRepositoryOptions = {}): AdminRepository {
  const fetcher = options.fetch ?? fetch
  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://localhost'

  const get = <T>(path: string) => fetcher(path, {
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  }).then((r) => jsonBody<T>(r))

  const mutate = <T>(path: string, method: string, body?: unknown) => fetcher(path, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? mutationHeaders(origin) : { accept: 'application/json', ...mutationHeaders(origin) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }).then((r) => jsonBody<T>(r))

  const mutateMedia = async <T>(path: string, file: File, options?: BackgroundUploadOptions): Promise<T> => {
    if (file.type.startsWith('video/')) {
      const { prepareBackgroundVideo } = await import('./backgroundTranscode')
      const prepared = await prepareBackgroundVideo(file, options)
      options?.onStage?.('uploading')
      const body = new FormData(); body.append('media', prepared.video); body.append('highMedia', prepared.highVideo); body.append('poster', prepared.poster)
      return fetcher(path, { method: 'POST', credentials: 'same-origin', headers: { origin }, body }).then(r => jsonBody<T>(r))
    }
    return fetcher(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': file.type, origin },
    body: file,
  }).then((r) => jsonBody<T>(r))
  }

  const backgroundAction = (id: string, action: 'publish' | 'archive' | 'restore') =>
    mutate<{ background: AdminBackground }>(
      `/api/admin/backgrounds/${encodeURIComponent(id)}/${action}`,
      'POST',
    ).then((response) => response.background)

  const catalogueBatchPath=(id:string)=>'/api/admin/catalogue/batches/'+encodeURIComponent(id)
  return {
    getCatalogueStatus:()=>get<CatalogueStatus>('/api/admin/catalogue/status'),
    syncCatalogue:(resync=false)=>mutate<ImportBatch>('/api/admin/catalogue/sync','POST',{resync}),
    exportCatalogueSheet:()=>mutate<{exported:boolean}>('/api/admin/catalogue/export-sheet','POST',{}),
    getCatalogueBatch:(id)=>get<ImportBatch>(catalogueBatchPath(id)),
    decideCatalogueChange:(id,changeId,decision,reviewRevision)=>mutate<ImportBatch>(catalogueBatchPath(id)+'/changes/'+encodeURIComponent(changeId),'PATCH',{decision,reviewRevision}),
    editCatalogueChange:(id,changeId,after,reviewRevision)=>mutate<ImportBatch>(catalogueBatchPath(id)+'/changes/'+encodeURIComponent(changeId),'PATCH',{after,reviewRevision}),
    approveCatalogueR2AsOwner:(id,changeId,reviewRevision)=>mutate<ImportBatch>(catalogueBatchPath(id)+'/changes/'+encodeURIComponent(changeId)+'/approve-r2-owner','POST',{reviewRevision}),
    approveCatalogueHighConfidence:(id,reviewRevision)=>mutate<ImportBatch>(catalogueBatchPath(id)+'/approve-high-confidence','POST',{reviewRevision}),
    publishCatalogueBatch:(id,reviewRevision)=>mutate<ImportBatch>(catalogueBatchPath(id)+'/publish','POST',{reviewRevision}),
    listCatalogueTracks:()=>get<AdminCatalogueIndex>('/api/admin/catalogue/tracks'),
    getCatalogueTrack:(trackId)=>get<AdminCatalogueTrackDetail>(
      '/api/admin/catalogue/tracks/'+encodeURIComponent(trackId),
    ),
    updateCatalogueTrack:(trackId,changes,expectedRevision)=>mutate<AdminCatalogueTrackEditResult>(
      '/api/admin/catalogue/tracks/'+encodeURIComponent(trackId),
      'PATCH',
      { changes, expectedRevision },
    ),
    async getOverview() {
      return get<AdminOverview>('/api/admin/overview')
    },
    async listAudit(filter) {
      return get<AdminAuditPage>(`/api/admin/audit${auditFilterToQuery(filter)}`)
    },
    async exportAudit(filter) {
      return get<AdminAuditPage>(`/api/admin/audit/export${auditFilterToQuery(filter)}`)
    },
    async updateProvider(key, update) {
      return mutate<{ provider: AdminProvider }>(`/api/admin/providers/${key}`, 'PATCH', update).then((r) => r.provider)
    },
    async updateProviderOrder(providerIds) {
      return mutate<{ providers: AdminProvider[] }>(
        '/api/admin/providers/order',
        'PUT',
        { providerIds },
      ).then((r) => r.providers)
    },
    async updateChkszOwnerFallback(enabled) {
      return mutate<ChkszOwnerFallbackState>(
        '/api/admin/providers/chksz/owner-fallback',
        'PUT',
        { enabled },
      )
    },
    async listNotices() {
      return get<{ notices: AdminNotice[] }>('/api/admin/notices').then((r) => r.notices)
    },
    async createNotice(input) {
      return mutate<{ notice: AdminNotice }>('/api/admin/notices', 'POST', input).then((r) => r.notice)
    },
    async getNotice(id) {
      return get<{ notice: AdminNotice }>(`/api/admin/notices/${id}`).then((r) => r.notice)
    },
    async patchNotice(id, patch) {
      return mutate<{ notice: AdminNotice }>(`/api/admin/notices/${id}`, 'PATCH', patch).then((r) => r.notice)
    },
    async publishNotice(id) {
      return mutate<{ notice: AdminNotice }>(`/api/admin/notices/${id}/publish`, 'POST').then((r) => r.notice)
    },
    async archiveNotice(id) {
      return mutate<{ notice: AdminNotice }>(`/api/admin/notices/${id}/archive`, 'POST').then((r) => r.notice)
    },
    async listPublicNotices() {
      return get<{ notices: PublicNotice[] }>('/api/notices').then((r) => r.notices)
    },
    async listBackgrounds() {
      return get<{ backgrounds: AdminBackground[] }>('/api/admin/backgrounds').then((r) => r.backgrounds)
    },
    async patchBackgroundMetadata(id, patch) {
      return mutate<{ background: AdminBackground }>(
        `/api/admin/backgrounds/${encodeURIComponent(id)}`,
        'PATCH',
        patch,
      ).then((response) => response.background)
    },
    async uploadBackground(file, options) {
      return mutateMedia<{ background: AdminBackground }>('/api/admin/backgrounds/uploads', file, options)
        .then((response) => response.background)
    },
    async replaceBackground(id, file, options) {
      return mutateMedia<{ background: AdminBackground }>(
        `/api/admin/backgrounds/${encodeURIComponent(id)}/replace`,
        file,
        options,
      ).then((response) => response.background)
    },
    async publishBackground(id) {
      return backgroundAction(id, 'publish')
    },
    async archiveBackground(id) {
      return backgroundAction(id, 'archive')
    },
    async restoreBackground(id) {
      return backgroundAction(id, 'restore')
    },
    async purgeBackground(id) {
      const response = await fetcher(`/api/admin/backgrounds/${encodeURIComponent(id)}/purge`, {
        method: 'DELETE',
        credentials: 'same-origin',
        headers: { origin },
      })
      if (!response.ok) throw new Error(`admin_${response.status}`)
    },
    async checkSession(): Promise<AdminSessionResult> {
      try {
        const response = await fetcher('/api/session', { credentials: 'same-origin', headers: { accept: 'application/json' } })
        if (response.status === 401 || response.status === 403) return { status: 'unauthorised' }
        if (!response.ok) return { status: 'unavailable' }
        const value: unknown = await response.json()
        if (typeof value !== 'object' || value === null || Array.isArray(value)) return { status: 'unavailable' }
        const user = (value as { user?: unknown }).user
        if (typeof user !== 'object' || user === null || Array.isArray(user)) {
          return user === null ? { status: 'unauthorised' } : { status: 'unavailable' }
        }
        const role = (user as { role?: unknown }).role
        if (role === 'admin' || role === 'owner') return { status: 'authorised', role }
        return { status: 'unauthorised' }
      } catch {
        return { status: 'unavailable' }
      }
    },
  }
}
