/**
 * Central contract for context injected into provider prompts.
 *
 * A fragment owns its content and carries its enforced byte ceiling with it;
 * callers may unwrap `text`, but must not concatenate additional context into
 * the fragment before provider dispatch. Volatility records whether a provider
 * session installs the fragment once or receives it on every turn.
 */
export interface ContextualPromptFragment<Owner extends string = string> {
    owner: Owner;
    volatility: 'stable-session' | 'per-turn';
    maxUtf8Bytes: number;
    text: string;
}
export declare function createContextualPromptFragment<Owner extends string>(owner: Owner, text: string, maxUtf8Bytes: number, volatility?: ContextualPromptFragment<Owner>['volatility']): ContextualPromptFragment<Owner>;
