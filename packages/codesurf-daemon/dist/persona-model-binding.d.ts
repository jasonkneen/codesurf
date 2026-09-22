export interface PersonaModelSeed {
    /** Provider id to seed, if the binding specifies one. */
    provider?: string;
    /** Model id to seed, if the binding specifies one. */
    model?: string;
}
/** Minimal persona shape this resolver needs (a soft, optional binding). */
export interface PersonaBindingLike {
    provider?: string;
    model?: string;
}
export interface PersonaLike {
    defaultBinding?: PersonaBindingLike;
}
/**
 * Resolve the SOFT model seed for a persona (precedence layer 2). Returns null
 * when the persona carries no usable soft default, so the caller leaves the
 * composer/provider untouched (preserving the user's current/saved selection).
 */
export declare function resolvePersonaModelSeed(persona: PersonaLike | null | undefined): PersonaModelSeed | null;
