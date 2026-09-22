import { utf8Bytes, utf8Prefix } from './peer-context-serialization.js';
export function createContextualPromptFragment(owner, text, maxUtf8Bytes, volatility = 'per-turn') {
    const boundedText = utf8Bytes(text) <= maxUtf8Bytes
        ? text
        : utf8Prefix(text, maxUtf8Bytes);
    return Object.freeze({
        owner,
        volatility,
        maxUtf8Bytes,
        text: boundedText,
    });
}
