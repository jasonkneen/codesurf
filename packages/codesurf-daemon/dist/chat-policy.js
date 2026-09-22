import { constants } from 'node:fs';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
export const MAX_PERSONA_DOCUMENT_BYTES = 256 * 1024;
export const MAX_PERSONA_COUNT = 128;
export const MAX_PERSONA_ID_BYTES = 64;
export const MAX_PERSONA_PROMPT_BYTES = 16 * 1024;
export const MAX_PERSONA_INHERITANCE_DEPTH = 8;
export const MAX_PERSONA_TOOLS = 128;
export class ChatPolicyError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = 'ChatPolicyError';
        this.code = code;
    }
}
export const DEFAULT_PERSONAS = [
    { id: 'agent', name: 'Agent', description: 'Full autonomous access to all tools', systemPrompt: '', tools: null, icon: 'robot', color: '#3568ff', isBuiltin: true },
    { id: 'ask', name: 'Ask', description: 'Read-only Q&A mode — no file modifications', systemPrompt: 'You are in read-only mode. Do not modify files or run destructive commands.', tools: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'], icon: 'help', color: '#56c288', isBuiltin: true },
    { id: 'plan', name: 'Plan', description: 'Plan without execution — outline steps before acting', systemPrompt: 'Create a detailed plan. Do not execute changes until the user approves.', tools: ['Read', 'Glob', 'Grep', 'WebSearch'], icon: 'map', color: '#f5a623', isBuiltin: true },
    { id: 'polly', name: 'Polly', description: 'Orchestrator — coordinates work and delegates to other personas', systemPrompt: "You are Polly, CodeSurf's orchestrator. You are a tech lead, not a solo coder: break the request into clear subtasks, decide which persona, engine, or tool should handle each, sequence the work, and keep the user informed at every step. Prefer delegating and verifying over doing everything yourself — and never let a single unchecked pass stand in for real verification; when something is built, get it independently confirmed. Work from evidence, not memory: ground claims in files, line numbers, and command output. Be terse and direct — surface assumptions and blockers early, and push back when something looks wrong. When you say you'll do something, do it now rather than narrating intent. You prepare and stage work for the human to review and decide; you don't ship or merge on their behalf.", tools: null, icon: 'star', color: '#b368c9', isBuiltin: true },
    { id: 'gemma', name: 'Gemma', description: 'General-purpose assistant for everyday tasks', systemPrompt: "You are Gemma, CodeSurf's general-purpose assistant — and the embodiment of its 'omni' principle: the user gets the same clear, consistent, well-structured Gemma no matter which underlying model or engine is running beneath you. Lead with the answer, then the detail. Use whatever tools and skills are available to carry a task through end to end rather than stopping at advice. When a request is genuinely ambiguous, ask one sharp clarifying question; otherwise make a reasonable assumption, state it, and proceed. Be warm, plain-spoken, and concise, scaling depth to the task. You leverage the full capability of whatever engine runs you, while always presenting it in one consistent voice.", tools: null, icon: 'bolt', color: '#00acd7', isBuiltin: true },
];
const PERSONA_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TOOL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/ -]*$/;
const PERSONA_OVERLAY_FIELDS = new Set([
    'id',
    'name',
    'description',
    'systemPrompt',
    'tools',
    'icon',
    'color',
    'isBuiltin',
    'defaultNextMode',
    'defaultBinding',
    'extends',
    'skills',
    'source',
]);
const PERSONA_BINDING_FIELDS = new Set(['provider', 'model']);
const WRITE_CAPABLE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'apply_patch'].map(normalizeToolName));
function invalid(message) {
    throw new ChatPolicyError('CHAT_PERSONA_INVALID', message);
}
function utf8Bytes(value) {
    return Buffer.byteLength(value, 'utf8');
}
function boundedString(value, field, maxBytes) {
    if (typeof value !== 'string')
        invalid(`${field} must be a string`);
    if (utf8Bytes(value) > maxBytes)
        invalid(`${field} exceeds ${maxBytes} UTF-8 bytes`);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
        invalid(`${field} contains control characters`);
    }
    return value;
}
function validId(value, field) {
    const id = boundedString(value, field, MAX_PERSONA_ID_BYTES).trim();
    if (!PERSONA_ID_PATTERN.test(id))
        invalid(`${field} is invalid`);
    return id;
}
function parseTools(value, field) {
    if (value === null)
        return null;
    if (!Array.isArray(value))
        invalid(`${field} must be null or an array of tool names`);
    if (value.length > MAX_PERSONA_TOOLS)
        invalid(`${field} exceeds ${MAX_PERSONA_TOOLS} entries`);
    const seen = new Set();
    return value.map((tool, index) => {
        const name = boundedString(tool, `${field}[${index}]`, 128).trim();
        if (!TOOL_PATTERN.test(name))
            invalid(`${field}[${index}] is invalid`);
        const key = normalizeToolName(name);
        if (seen.has(key))
            invalid(`${field} contains duplicate tool ${name}`);
        seen.add(key);
        return name;
    });
}
function parseOverlay(value, index) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        invalid(`personas[${index}] must be an object`);
    }
    const input = value;
    for (const field of Object.keys(input)) {
        if (!PERSONA_OVERLAY_FIELDS.has(field))
            invalid(`personas[${index}] contains unknown field ${field}`);
    }
    const id = validId(input.id, `personas[${index}].id`);
    if (id.startsWith('discovered-'))
        return null;
    const output = { id };
    const textLimits = {
        name: 256,
        description: 2 * 1024,
        systemPrompt: MAX_PERSONA_PROMPT_BYTES,
        icon: 128,
        color: 64,
        defaultNextMode: 64,
        source: 128,
    };
    for (const [field, maxBytes] of Object.entries(textLimits)) {
        if (Object.hasOwn(input, field)) {
            const text = boundedString(input[field], `personas[${index}].${field}`, maxBytes);
            if ((field === 'name' || field === 'icon' || field === 'color') && !text.trim()) {
                invalid(`personas[${index}].${field} must not be empty`);
            }
            ;
            output[field] = text;
        }
    }
    if (Object.hasOwn(input, 'tools'))
        output.tools = parseTools(input.tools, `personas[${index}].tools`);
    if (Object.hasOwn(input, 'extends'))
        output.extends = validId(input.extends, `personas[${index}].extends`);
    if (Object.hasOwn(input, 'isBuiltin')) {
        if (typeof input.isBuiltin !== 'boolean')
            invalid(`personas[${index}].isBuiltin must be a boolean`);
        output.isBuiltin = input.isBuiltin;
    }
    if (Object.hasOwn(input, 'skills')) {
        if (!Array.isArray(input.skills) || input.skills.length > 32)
            invalid(`personas[${index}].skills is invalid`);
        const seenSkills = new Set();
        output.skills = input.skills.map((skill, skillIndex) => {
            const normalized = boundedString(skill, `personas[${index}].skills[${skillIndex}]`, 128).trim();
            if (!normalized || seenSkills.has(normalized))
                invalid(`personas[${index}].skills contains an empty or duplicate entry`);
            seenSkills.add(normalized);
            return normalized;
        });
    }
    if (Object.hasOwn(input, 'defaultBinding')) {
        if (!input.defaultBinding || typeof input.defaultBinding !== 'object' || Array.isArray(input.defaultBinding)) {
            invalid(`personas[${index}].defaultBinding must be an object`);
        }
        const binding = input.defaultBinding;
        for (const field of Object.keys(binding)) {
            if (!PERSONA_BINDING_FIELDS.has(field)) {
                invalid(`personas[${index}].defaultBinding contains unknown field ${field}`);
            }
        }
        output.defaultBinding = {
            ...(Object.hasOwn(binding, 'provider')
                ? { provider: boundedString(binding.provider, `personas[${index}].defaultBinding.provider`, 128).trim() }
                : {}),
            ...(Object.hasOwn(binding, 'model')
                ? { model: boundedString(binding.model, `personas[${index}].defaultBinding.model`, 256).trim() }
                : {}),
        };
    }
    return output;
}
function normalizeToolName(name) {
    return String(name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}
function clonePersona(persona) {
    return {
        ...persona,
        tools: persona.tools === null ? null : [...persona.tools],
        ...(persona.defaultBinding ? { defaultBinding: { ...persona.defaultBinding } } : {}),
        ...(persona.skills ? { skills: [...persona.skills] } : {}),
    };
}
function cloneDefaultPersonas() {
    return DEFAULT_PERSONAS.map(clonePersona);
}
function assertNoToolWidening(base, child, label) {
    if (base === null)
        return;
    if (child === null)
        invalid(`${label} cannot widen a restricted base to unrestricted tools`);
    const allowed = new Set(base.map(normalizeToolName));
    if (child.some(tool => !allowed.has(normalizeToolName(tool)))) {
        invalid(`${label} cannot grant tools that its base does not allow`);
    }
}
export function overlayAuthoritativePersonas(document) {
    if (!Array.isArray(document))
        invalid('agents.json must contain an array');
    if (document.length > MAX_PERSONA_COUNT)
        invalid(`agents.json exceeds ${MAX_PERSONA_COUNT} personas`);
    const overlays = new Map();
    for (let index = 0; index < document.length; index += 1) {
        const overlay = parseOverlay(document[index], index);
        if (!overlay)
            continue;
        if (overlays.has(overlay.id))
            invalid(`agents.json contains duplicate persona id ${overlay.id}`);
        if (!DEFAULT_PERSONAS.some(persona => persona.id === overlay.id) && overlay.isBuiltin === true) {
            invalid(`custom persona ${overlay.id} cannot claim to be built in`);
        }
        overlays.set(overlay.id, overlay);
    }
    const builtins = new Map(DEFAULT_PERSONAS.map(persona => [persona.id, persona]));
    const resolved = new Map();
    const resolvePersona = (id, stack = []) => {
        const cached = resolved.get(id);
        if (cached)
            return cached;
        if (stack.includes(id))
            invalid(`persona inheritance cycle: ${[...stack, id].join(' -> ')}`);
        if (stack.length >= MAX_PERSONA_INHERITANCE_DEPTH) {
            invalid(`persona inheritance exceeds depth ${MAX_PERSONA_INHERITANCE_DEPTH}`);
        }
        const overlay = overlays.get(id);
        const builtin = builtins.get(id);
        if (!overlay) {
            if (!builtin)
                invalid(`persona ${id} is not defined`);
            const clone = clonePersona(builtin);
            resolved.set(id, clone);
            return clone;
        }
        const explicitBaseId = overlay.extends;
        const explicitBaseExists = explicitBaseId
            ? overlays.has(explicitBaseId) || builtins.has(explicitBaseId)
            : false;
        if (explicitBaseId && !explicitBaseExists) {
            invalid(`persona ${id} extends missing persona ${explicitBaseId}`);
        }
        const base = explicitBaseExists
            ? resolvePersona(explicitBaseId, [...stack, id])
            : builtin;
        const explicitTools = Object.hasOwn(overlay, 'tools');
        const tools = explicitTools
            ? overlay.tools
            : base
                ? base.tools
                : [];
        if (base)
            assertNoToolWidening(base.tools, tools, `persona ${id}`);
        if (builtin)
            assertNoToolWidening(builtin.tools, tools, `built-in persona ${id}`);
        const persona = {
            id,
            name: overlay.name ?? base?.name ?? id,
            description: overlay.description ?? base?.description ?? '',
            systemPrompt: overlay.systemPrompt ?? base?.systemPrompt ?? '',
            tools: tools === null ? null : [...tools],
            icon: overlay.icon ?? base?.icon ?? 'robot',
            color: overlay.color ?? base?.color ?? '#3568ff',
            isBuiltin: Boolean(builtin),
            ...(overlay.defaultNextMode ?? base?.defaultNextMode
                ? { defaultNextMode: overlay.defaultNextMode ?? base?.defaultNextMode }
                : {}),
            ...(overlay.defaultBinding ?? base?.defaultBinding
                ? { defaultBinding: { ...(overlay.defaultBinding ?? base?.defaultBinding) } }
                : {}),
            ...(explicitBaseId ? { extends: explicitBaseId } : {}),
            ...(overlay.skills ?? base?.skills ? { skills: [...(overlay.skills ?? base?.skills ?? [])] } : {}),
            ...(overlay.source ?? base?.source ? { source: overlay.source ?? base?.source } : {}),
        };
        resolved.set(id, persona);
        return persona;
    };
    return [
        ...DEFAULT_PERSONAS.map(persona => resolvePersona(persona.id)),
        ...[...overlays.keys()]
            .filter(id => !builtins.has(id))
            .map(id => resolvePersona(id)),
    ];
}
function pathIsWithin(root, candidate) {
    const rel = relative(root, candidate);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
function stableFileTuple(left, right) {
    return left.dev === right.dev
        && left.ino === right.ino
        && left.mode === right.mode
        && left.size === right.size
        && left.mtimeMs === right.mtimeMs
        && left.ctimeMs === right.ctimeMs;
}
async function readBoundedPersonaFile(workspaceRoot) {
    const canonicalRoot = await realpath(workspaceRoot);
    const parentPath = join(canonicalRoot, '.codesurf', 'customisation');
    const canonicalParent = await realpath(parentPath);
    if (canonicalParent !== parentPath || !pathIsWithin(canonicalRoot, canonicalParent)) {
        invalid('agents.json parent must be a canonical directory inside the registered workspace');
    }
    const path = join(canonicalParent, 'agents.json');
    const pathInfo = await lstat(path);
    if (pathInfo.isSymbolicLink() || !pathInfo.isFile())
        invalid('agents.json must be a regular non-symlink file');
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
        const before = await handle.stat();
        if (!before.isFile() || before.size > MAX_PERSONA_DOCUMENT_BYTES) {
            invalid(`agents.json exceeds ${MAX_PERSONA_DOCUMENT_BYTES} bytes or is not a file`);
        }
        const buffer = Buffer.alloc(MAX_PERSONA_DOCUMENT_BYTES + 1);
        let offset = 0;
        while (offset < buffer.length) {
            const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
            if (bytesRead === 0)
                break;
            offset += bytesRead;
        }
        if (offset > MAX_PERSONA_DOCUMENT_BYTES)
            invalid(`agents.json exceeds ${MAX_PERSONA_DOCUMENT_BYTES} bytes`);
        const after = await handle.stat();
        const currentPath = await realpath(path);
        const currentInfo = await lstat(path);
        if (currentPath !== path
            || currentInfo.isSymbolicLink()
            || currentInfo.dev !== after.dev
            || currentInfo.ino !== after.ino
            || !stableFileTuple(before, after)) {
            invalid('agents.json changed while it was being verified');
        }
        return buffer.subarray(0, offset).toString('utf8');
    }
    finally {
        await handle.close();
    }
}
export const AGENT_MODE_RESOLUTION_DENIED_ERROR = 'The selected agent could not be verified against the workspace agent definitions. Refusing to launch rather than fall back to looser permissions.';
export async function resolveAuthoritativePersona(options) {
    const agentId = typeof options.agentId === 'string' ? options.agentId.trim() : '';
    if (!agentId)
        return { ok: true, agentMode: null };
    const workspaceRoot = typeof options.workspaceRoot === 'string' ? options.workspaceRoot.trim() : '';
    if (!workspaceRoot)
        return { ok: false, error: AGENT_MODE_RESOLUTION_DENIED_ERROR };
    let personas;
    try {
        const raw = await readBoundedPersonaFile(workspaceRoot);
        personas = overlayAuthoritativePersonas(JSON.parse(raw));
    }
    catch (error) {
        if (error?.code === 'ENOENT') {
            personas = cloneDefaultPersonas();
        }
        else {
            return { ok: false, error: AGENT_MODE_RESOLUTION_DENIED_ERROR };
        }
    }
    const agentMode = personas.find(persona => persona.id === agentId) ?? null;
    return agentMode
        ? { ok: true, agentMode }
        : { ok: false, error: AGENT_MODE_RESOLUTION_DENIED_ERROR };
}
export async function listAuthoritativePersonas(workspaceRoot) {
    const root = typeof workspaceRoot === 'string' ? workspaceRoot.trim() : '';
    if (!root)
        return cloneDefaultPersonas();
    try {
        return overlayAuthoritativePersonas(JSON.parse(await readBoundedPersonaFile(root)));
    }
    catch {
        return cloneDefaultPersonas();
    }
}
export async function bindChatRequestToWorkspace(request, workspace) {
    const requestedId = typeof request.workspaceId === 'string' ? request.workspaceId.trim() : '';
    if (!requestedId)
        throw new ChatPolicyError('CHAT_WORKSPACE_REQUIRED', 'workspaceId is required');
    if (requestedId !== workspace.id) {
        throw new ChatPolicyError('CHAT_WORKSPACE_UNKNOWN', `Workspace not found: ${requestedId}`);
    }
    const registeredPath = String(workspace.path ?? '').trim();
    if (!registeredPath) {
        throw new ChatPolicyError('CHAT_WORKSPACE_UNKNOWN', `Workspace ${requestedId} has no registered root`);
    }
    let canonicalRoot;
    try {
        canonicalRoot = await realpath(resolve(registeredPath));
        if (!(await stat(canonicalRoot)).isDirectory()) {
            throw new Error('registered workspace root is not a directory');
        }
    }
    catch {
        throw new ChatPolicyError('CHAT_WORKSPACE_UNKNOWN', `Workspace ${requestedId} has no registered root`);
    }
    let suppliedRoot = null;
    if (typeof request.workspaceDir === 'string' && request.workspaceDir.trim()) {
        try {
            suppliedRoot = await realpath(resolve(request.workspaceDir.trim()));
        }
        catch {
            throw new ChatPolicyError('CHAT_WORKSPACE_MISMATCH', 'workspaceDir does not match the registered workspace root');
        }
    }
    if (suppliedRoot && suppliedRoot !== canonicalRoot) {
        throw new ChatPolicyError('CHAT_WORKSPACE_MISMATCH', 'workspaceDir does not match the registered workspace root');
    }
    const projectContext = request.projectContext && typeof request.projectContext === 'object' && !Array.isArray(request.projectContext)
        ? request.projectContext
        : {};
    return {
        ...request,
        workspaceId: workspace.id,
        workspaceDir: canonicalRoot,
        projectContext: { ...projectContext, workspaceDir: canonicalRoot },
        agentMode: null,
    };
}
export function assertProviderPersonaEnforceable(providerValue, persona) {
    const tools = persona?.tools;
    if (tools == null)
        return;
    const personaId = persona?.id ?? '(unknown)';
    const provider = String(providerValue ?? '').trim().toLowerCase();
    if (provider === 'claude')
        return;
    if (provider === 'codex' && tools.length > 0 && !tools.some(tool => WRITE_CAPABLE_TOOLS.has(normalizeToolName(tool)))) {
        return;
    }
    if (provider === 'hermes' && tools.length === 0)
        return;
    throw new ChatPolicyError('CHAT_PERSONA_PROVIDER_UNSUPPORTED', `Provider ${provider || '(missing)'} cannot enforce persona ${personaId}'s tool restrictions; refusing to launch unrestricted`);
}
export function codexExecPermissionArgs(modeValue) {
    const mode = String(modeValue ?? '');
    if (mode === 'full-access')
        return ['--dangerously-bypass-approvals-and-sandbox'];
    if (mode === 'auto')
        return ['--sandbox', 'workspace-write', '-c', 'approval_policy=on-failure'];
    if (mode === 'read-only')
        return ['--sandbox', 'read-only', '-c', 'approval_policy=on-request'];
    return ['--sandbox', 'workspace-write', '-c', 'approval_policy=on-request'];
}
const PRIVILEGED_CHAT_CONTEXT_FIELDS = [
    'agentMode',
    'projectContext',
    'memoryPrompt',
    'contextBuckets',
    'skillsPrompt',
    'skillsSummary',
    'roomContext',
    'roomAckSequence',
    'contextPrompt',
    'fileReferencePrompt',
    'untrustedPeerContext',
    'peers',
    'providerTransport',
    'negotiatedTools',
    'expandedMessages',
    'imageAttachments',
    'asyncExecution',
];
export function stripUntrustedPrivilegedChatContext(request) {
    const stripped = { ...request };
    for (const field of PRIVILEGED_CHAT_CONTEXT_FIELDS)
        delete stripped[field];
    return stripped;
}
