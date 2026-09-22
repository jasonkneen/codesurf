const FORBIDDEN_RUNTIME_ROOTS = new Set([
    'contracts',
    'node_modules',
    'scripts',
    'src',
    'test',
]);
function safePathSegments(value) {
    return !value.includes('\\')
        && !value.includes('\0')
        && !/^[a-z]:/iu.test(value)
        && !value.startsWith('/')
        && value.split('/').every(segment => segment && segment !== '.' && segment !== '..');
}
function normalizeRuntimeEntry(value) {
    if (typeof value !== 'string')
        throw new Error('daemon package files entries must be strings');
    const normalized = value.replace(/^\.\//u, '').replace(/\/+$/u, '');
    if (!normalized || !safePathSegments(normalized)) {
        throw new Error(`unsafe daemon package files entry: ${String(value)}`);
    }
    const [root] = normalized.split('/');
    if (FORBIDDEN_RUNTIME_ROOTS.has(root)) {
        throw new Error(`daemon runtime files must not publish ${root}/`);
    }
    return normalized;
}
/**
 * Resolve the complete package-owned runtime copy contract. Build hosts use
 * this instead of maintaining their own bin/dist/vendor lists.
 */
export function getDaemonRuntimeEntries(manifest) {
    if (!Array.isArray(manifest.files)) {
        throw new Error('@codesurf/daemon package.json must declare a files array');
    }
    return [...new Set([
            ...manifest.files.map(normalizeRuntimeEntry),
            'package.json',
        ])];
}
/** Resolve every importable compiled export and reject private/bin targets. */
export function getDaemonCompiledExports(manifest) {
    if (!manifest.exports || typeof manifest.exports !== 'object') {
        throw new Error('@codesurf/daemon package.json must declare exports');
    }
    const compiled = [];
    for (const [subpath, rawTarget] of Object.entries(manifest.exports)) {
        if (subpath === './package.json')
            continue;
        const relativeSubpath = subpath === '.' ? 'index' : subpath.replace(/^\.\//u, '');
        if ((subpath !== '.' && !subpath.startsWith('./'))
            || !safePathSegments(relativeSubpath)) {
            throw new Error(`@codesurf/daemon export has an unsafe subpath: ${subpath}`);
        }
        if (!rawTarget || typeof rawTarget !== 'object' || Array.isArray(rawTarget)) {
            throw new Error(`@codesurf/daemon export ${subpath} must be a compiled conditional export`);
        }
        const target = rawTarget;
        if (typeof target.types !== 'string'
            || typeof target.import !== 'string'
            || typeof target.default !== 'string'
            || !target.types.startsWith('./dist/')
            || !target.import.startsWith('./dist/')
            || !safePathSegments(target.types.slice(2))
            || !safePathSegments(target.import.slice(2))
            || target.import !== target.default) {
            throw new Error(`@codesurf/daemon export ${subpath} must resolve to compiled dist`);
        }
        compiled.push({
            subpath,
            types: target.types,
            import: target.import,
        });
    }
    return compiled;
}
/** Convert the compiled export contract into bare package import specifiers. */
export function getDaemonPublicSpecifiers(manifest, packageName = '@codesurf/daemon') {
    if (!packageName || packageName.endsWith('/')) {
        throw new Error('daemon package name must be a non-empty bare specifier');
    }
    return getDaemonCompiledExports(manifest).map(target => (target.subpath === '.' ? packageName : `${packageName}${target.subpath.slice(1)}`));
}
