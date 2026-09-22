import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
export function chatCliSessionStorePath(homeDir) {
    return join(homeDir, 'chat-cli', 'sessions.json');
}
export function normalizeChatCliSessionIdentity(identity) {
    const provider = String(identity.provider ?? '').trim();
    const model = String(identity.model ?? '').trim();
    const workspaceDir = resolve(String(identity.workspaceDir ?? '').trim() || process.cwd());
    const agentId = String(identity.agentId ?? '').trim();
    return { provider, model, workspaceDir, agentId };
}
export function chatCliSessionKey(identity) {
    const normalized = normalizeChatCliSessionIdentity(identity);
    return createHash('sha256')
        .update(`${normalized.provider}\0${normalized.model}\0${normalized.workspaceDir}\0${normalized.agentId}`)
        .digest('hex')
        .slice(0, 24);
}
function normalizeSession(value) {
    if (!value || typeof value !== 'object')
        return null;
    const candidate = value;
    const provider = String(candidate.provider ?? '').trim();
    const model = String(candidate.model ?? '').trim();
    const workspaceDir = String(candidate.workspaceDir ?? '').trim();
    const key = String(candidate.key ?? '').trim();
    if (!provider || !model || !workspaceDir || !key)
        return null;
    return {
        key,
        provider,
        model,
        workspaceDir: resolve(workspaceDir),
        agentId: typeof candidate.agentId === 'string' ? candidate.agentId.trim() : '',
        sessionId: typeof candidate.sessionId === 'string' && candidate.sessionId.trim() ? candidate.sessionId.trim() : null,
        jobId: typeof candidate.jobId === 'string' && candidate.jobId.trim() ? candidate.jobId.trim() : null,
        lastSequence: Number.isFinite(candidate.lastSequence) ? Math.max(0, Number(candidate.lastSequence)) : 0,
        updatedAt: typeof candidate.updatedAt === 'string' && candidate.updatedAt.trim()
            ? candidate.updatedAt.trim()
            : new Date(0).toISOString(),
    };
}
export function readChatCliSessionStore(homeDir) {
    try {
        const parsed = JSON.parse(readFileSync(chatCliSessionStorePath(homeDir), 'utf8'));
        const rawSessions = parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {};
        const sessions = {};
        for (const raw of Object.values(rawSessions)) {
            const session = normalizeSession(raw);
            if (session)
                sessions[session.key] = session;
        }
        const activeKey = typeof parsed.activeKey === 'string' && sessions[parsed.activeKey] ? parsed.activeKey : null;
        return { version: 1, activeKey, sessions };
    }
    catch {
        return { version: 1, activeKey: null, sessions: {} };
    }
}
export function writeChatCliSessionStore(homeDir, store) {
    const filePath = chatCliSessionStorePath(homeDir);
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(store, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(tempPath, filePath);
}
export function readChatCliSession(homeDir, identity) {
    const key = chatCliSessionKey(identity);
    return readChatCliSessionStore(homeDir).sessions[key] ?? null;
}
export function upsertChatCliSession(homeDir, session) {
    const identity = normalizeChatCliSessionIdentity(session);
    const key = session.key ?? chatCliSessionKey(identity);
    const nextSession = {
        key,
        provider: identity.provider,
        model: identity.model,
        workspaceDir: identity.workspaceDir,
        agentId: identity.agentId,
        sessionId: typeof session.sessionId === 'string' && session.sessionId.trim() ? session.sessionId.trim() : null,
        jobId: typeof session.jobId === 'string' && session.jobId.trim() ? session.jobId.trim() : null,
        lastSequence: Number.isFinite(session.lastSequence) ? Math.max(0, Number(session.lastSequence)) : 0,
        updatedAt: session.updatedAt ?? new Date().toISOString(),
    };
    const store = readChatCliSessionStore(homeDir);
    store.sessions[key] = nextSession;
    store.activeKey = key;
    writeChatCliSessionStore(homeDir, store);
    return nextSession;
}
export function clearChatCliSession(homeDir, identity) {
    const key = chatCliSessionKey(identity);
    const store = readChatCliSessionStore(homeDir);
    delete store.sessions[key];
    if (store.activeKey === key)
        store.activeKey = null;
    writeChatCliSessionStore(homeDir, store);
}
