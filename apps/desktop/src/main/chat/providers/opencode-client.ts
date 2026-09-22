export interface OpenCodeClientOptions {
  baseUrl: string
  headers: Record<string, string>
}

export type OpenCodeClientFactory<TClient> = (options: OpenCodeClientOptions) => TClient

/**
 * Keep SDK client construction behind one authenticated boundary. The local
 * OpenCode server rejects every unauthenticated endpoint, including model
 * discovery, event subscriptions, and session operations.
 */
export function createAuthenticatedOpenCodeClient<TClient>(
  createClient: OpenCodeClientFactory<TClient>,
  baseUrl: string,
  authHeaders: Record<string, string>,
): TClient {
  return createClient({ baseUrl, headers: authHeaders })
}

/**
 * Reuse the SDK client while the managed server URL is stable. A new server
 * gets a new authenticated client before any provider or session call runs.
 */
export class OpenCodeClientCache<TClient> {
  private client: TClient | null = null
  private url: string | null = null

  getOrCreate(
    url: string,
    createClient: OpenCodeClientFactory<TClient>,
    authHeaders: Record<string, string>,
  ): TClient {
    if (this.client !== null && this.url === url) {
      return this.client
    }

    this.client = createAuthenticatedOpenCodeClient(createClient, url, authHeaders)
    this.url = url
    return this.client
  }
}
