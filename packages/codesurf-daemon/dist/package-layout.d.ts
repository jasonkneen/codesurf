export interface DaemonPackageExportTarget {
    types: string;
    import: string;
    default: string;
}
export interface DaemonPackageManifest {
    files?: unknown;
    exports?: Record<string, unknown>;
}
export interface DaemonCompiledExport {
    subpath: string;
    types: string;
    import: string;
}
/**
 * Resolve the complete package-owned runtime copy contract. Build hosts use
 * this instead of maintaining their own bin/dist/vendor lists.
 */
export declare function getDaemonRuntimeEntries(manifest: DaemonPackageManifest): string[];
/** Resolve every importable compiled export and reject private/bin targets. */
export declare function getDaemonCompiledExports(manifest: DaemonPackageManifest): DaemonCompiledExport[];
/** Convert the compiled export contract into bare package import specifiers. */
export declare function getDaemonPublicSpecifiers(manifest: DaemonPackageManifest, packageName?: string): string[];
