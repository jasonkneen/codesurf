export interface FileIdentity {
  device: string
  inode: string
  byteCount: number
  mtimeMs: number
  ctimeMs: number
}

export function readVerifiedFile(options: {
  path: string
  identity: FileIdentity
  maxBytes: number
  label?: string
  beforeFinalStat?: () => void | Promise<void>
}): Promise<{ data: Buffer; stat: import('node:fs').Stats; identity: FileIdentity }>
