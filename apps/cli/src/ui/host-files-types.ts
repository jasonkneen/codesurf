/** Host file access — implemented by src/ui/host-files.ts (node) and src/ui-web/host-files.ts (HTTP). */
export interface HostFiles {
  hrefForPath(path: string, line?: number): string;
  exists(path: string): boolean;
  open(path: string): boolean;
}
