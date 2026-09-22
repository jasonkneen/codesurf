/**
 * Default home directory for CodeSurf state. Can be overridden by setting
 * the CODESURF_HOME env var or by passing `homeDir` to `createDaemonManager`.
 */
export declare const CODESURF_HOME_DIRNAME = ".codesurf";
export declare function defaultCodesurfHome(): string;
export declare const CODESURF_HOME: string;
/**
 * Version of the @codesurf/daemon package itself. Hosts (desktop, TUI) should
 * report this string as the daemon's `appVersion` rather than their own
 * package version, so two hosts at different release cadences don't trigger
 * each other's force-restart logic. Override via CODESURF_DAEMON_VERSION_PIN.
 */
export declare const DAEMON_PACKAGE_VERSION = "0.1.0";
