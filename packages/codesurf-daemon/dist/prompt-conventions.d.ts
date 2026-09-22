/**
 * CodeSurf prompt conventions, injected into every chat provider (Claude,
 * Codex, OpenCode, OpenClaw, Hermes).
 *
 * Kept in the daemon package so every host and provider shares one canonical
 * set of pure strings and helpers without importing Electron main-process code.
 */
export declare function joinPromptSections(...sections: Array<string | undefined | null>): string | undefined;
export declare const CODESURF_OUTPUT_CONVENTION: string;
export declare function buildCodeSurfOutputConvention(): string;
export declare const CODESURF_INSIGHT_CONVENTION: string;
export declare function buildCodeSurfInsightConvention(): string;
export declare const CODESURF_ACTIVITY_CONVENTION: string;
export declare function buildCodeSurfActivityConvention(): string;
