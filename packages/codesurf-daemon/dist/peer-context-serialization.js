/** Safe, deterministic serialization primitives for untrusted prompt context. */
const textEncoder = new TextEncoder();
const unsafeControl = /\p{Cc}/gu;
const unsafeBidi = /\p{Bidi_Control}/gu;
export function compareText(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}
export function toWellFormedText(value) {
    let result = '';
    for (const character of value) {
        const code = character.charCodeAt(0);
        result += character.length === 1 && code >= 0xd800 && code <= 0xdfff
            ? '\uFFFD'
            : character;
    }
    return result;
}
export function utf8Bytes(value) {
    return textEncoder.encode(value).byteLength;
}
export function utf8Prefix(value, maxBytes) {
    let result = '';
    let used = 0;
    for (const character of toWellFormedText(value)) {
        const bytes = utf8Bytes(character);
        if (used + bytes > maxBytes)
            break;
        result += character;
        used += bytes;
    }
    return result;
}
export function singleLine(value) {
    return toWellFormedText(value)
        .replace(unsafeControl, ' ')
        .replace(unsafeBidi, '')
        .replace(/\s+/gu, ' ')
        .trim();
}
export function readDataProperty(value, key) {
    try {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !('value' in descriptor))
            return { ok: false };
        return { ok: true, value: descriptor.value };
    }
    catch {
        return { ok: false };
    }
}
export function safeKeys(value) {
    try {
        return Object.keys(value).sort(compareText);
    }
    catch {
        return null;
    }
}
function serialize(value, state, depth, limits) {
    if (state.remainingNodes <= 0)
        return JSON.stringify('[Node limit reached]');
    state.remainingNodes -= 1;
    if (value === null)
        return 'null';
    if (typeof value === 'string')
        return JSON.stringify(toWellFormedText(value));
    if (typeof value === 'boolean')
        return value ? 'true' : 'false';
    if (typeof value === 'number')
        return Number.isFinite(value) ? String(value) : JSON.stringify(String(value));
    if (typeof value === 'bigint')
        return JSON.stringify(`${value}n`);
    if (typeof value === 'undefined')
        return JSON.stringify('[Undefined]');
    if (typeof value === 'symbol')
        return JSON.stringify(`[Symbol: ${singleLine(value.description ?? '')}]`);
    if (typeof value === 'function')
        return JSON.stringify('[Function]');
    if (typeof value !== 'object')
        return JSON.stringify('[Unsupported value]');
    if (state.ancestors.has(value))
        return JSON.stringify('[Circular]');
    if (depth >= limits.depth)
        return JSON.stringify('[Depth limit reached]');
    state.ancestors.add(value);
    try {
        if (value instanceof Date) {
            try {
                return JSON.stringify(Number.isFinite(value.getTime()) ? value.toISOString() : '[Invalid Date]');
            }
            catch {
                return JSON.stringify('[Unserializable Date]');
            }
        }
        if (Array.isArray(value)) {
            const length = Math.min(value.length, limits.containerEntries);
            const items = [];
            for (let index = 0; index < length; index += 1) {
                const item = readDataProperty(value, String(index));
                items.push(item.ok
                    ? serialize(item.value, state, depth + 1, limits)
                    : JSON.stringify('[Inaccessible item]'));
            }
            if (value.length > length)
                items.push(JSON.stringify(`[${value.length - length} items omitted]`));
            return `[${items.join(',')}]`;
        }
        const keys = safeKeys(value);
        if (!keys)
            return JSON.stringify('[Unserializable object]');
        const selectedKeys = keys.slice(0, limits.containerEntries);
        const fields = selectedKeys.map(key => {
            const property = readDataProperty(value, key);
            const display = property.ok
                ? serialize(property.value, state, depth + 1, limits)
                : JSON.stringify('[Inaccessible property]');
            return `${JSON.stringify(toWellFormedText(key))}:${display}`;
        });
        if (keys.length > selectedKeys.length) {
            fields.push(`${JSON.stringify('...')}:${JSON.stringify(`[${keys.length - selectedKeys.length} entries omitted]`)}`);
        }
        return `{${fields.join(',')}}`;
    }
    catch {
        return JSON.stringify('[Unserializable object]');
    }
    finally {
        state.ancestors.delete(value);
    }
}
export function safeSerializeContextValue(value, limits) {
    try {
        return serialize(value, {
            remainingNodes: limits.nodes,
            ancestors: new WeakSet(),
        }, 0, limits);
    }
    catch {
        return JSON.stringify('[Unserializable value]');
    }
}
