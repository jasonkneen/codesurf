// Minimal ambient typings for pngjs used by the pets builtin extension.
// We only need the small synchronous surface (`new PNG({...})`, `data`,
// `width`, `PNG.sync.write`). Full upstream type defs ship as
// @types/pngjs but we avoid the extra dev dependency.

declare module "pngjs" {
  export interface PNGOptions {
    width: number;
    height: number;
    colorType?: number;
    inputHasAlpha?: boolean;
  }

  export class PNG {
    constructor(options: PNGOptions);
    width: number;
    height: number;
    data: Buffer;
    static sync: {
      write(png: PNG): Buffer;
      read(buffer: Buffer): PNG;
    };
  }
}
