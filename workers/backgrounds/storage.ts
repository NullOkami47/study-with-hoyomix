export interface BackgroundStoredObject {
  key: string
  size: number
  body: ReadableStream | ArrayBuffer | Uint8Array
  httpMetadata?: { contentType?: string }
}

export interface BackgroundBucket {
  put(
    key: string,
    value: ArrayBuffer | Uint8Array,
    options: {
      httpMetadata: { contentType: string; cacheControl: string }
      customMetadata: Record<string, string>
    },
  ): Promise<{ key: string; size: number } | null>
  head(key: string): Promise<{ key: string; size: number } | null>
  get(key: string): Promise<BackgroundStoredObject | null>
  delete(key: string): Promise<void>
}
