export async function getMcpAuthHeaders(): Promise<Record<string, string>> {
  const token = await window.electron?.mcp?.getToken?.()
  if (!token) return {}
  return { Authorization: `Bearer ${token}` }
}

export async function postMcpEndpoint(
  port: number,
  path: string,
  body: unknown,
): Promise<Response> {
  const headers = await getMcpAuthHeaders()
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

export async function openMcpEventSource(
  port: number,
  cardId: string,
  workspaceId?: string,
): Promise<EventSource | null> {
  const token = await window.electron?.mcp?.getToken?.()
  if (!token) return null
  const params = new URLSearchParams({ card_id: cardId, token })
  if (workspaceId) params.set('workspace_id', workspaceId)
  return new EventSource(`http://127.0.0.1:${port}/events?${params.toString()}`)
}
