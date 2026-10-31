import { ProviderSnapshot } from "./model"

export interface SnapshotStorage {
  get(key: string): Promise<unknown>
  set(key: string, snapshot: ProviderSnapshot): Promise<void>
  remove(key: string): Promise<void>
}

/** OpenCode's plugin KV storage is global, not tied to the chat/location running a hook. */
export class SnapshotCache {
  constructor(private storage: SnapshotStorage) {}

  async read(provider: ProviderSnapshot["provider"], account: string): Promise<ProviderSnapshot | undefined> {
    const value = await this.storage.get(this.key(provider, account)).catch(() => undefined)
    const parsed = ProviderSnapshot.safeParse(value)
    if (!parsed.success || parsed.data.provider !== provider || parsed.data.status !== "ready") return undefined
    if (parsed.data.fetchedAt === null || parsed.data.fetchedAt > Date.now() + 60_000) return undefined
    return parsed.data
  }

  async write(account: string, snapshot: ProviderSnapshot): Promise<void> {
    if (snapshot.status === "signed-out" || snapshot.status === "unsupported") {
      await this.storage.remove(this.key(snapshot.provider, account))
      return
    }
    if (snapshot.status !== "ready" || snapshot.fetchedAt === null) return
    const previous = await this.read(snapshot.provider, account)
    if (previous && previous.fetchedAt! >= snapshot.fetchedAt) return
    // Parse again to strip unknown properties; only quota data, labels and freshness are durable.
    await this.storage.set(this.key(snapshot.provider, account), ProviderSnapshot.parse(snapshot))
  }

  private key(provider: string, account: string) {
    return `quota-snapshot/v1/${provider}/${encodeURIComponent(account)}`
  }
}
