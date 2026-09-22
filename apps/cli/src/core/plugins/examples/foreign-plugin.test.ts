// A third-party Cordis plugin, running on CodeSurf's runtime.
//
// Everything else in this repo proves CodeSurf's OWN plugins work on its
// Cordis root, which is circular: we wrote both halves. This mounts a plugin
// nobody here wrote — `@deepseek-ai/dsh-skill-badge`, installed from npm, byte
// for byte as published — and drives it through its whole lifecycle.
//
// It is a real interop check, not a shape check. The harness authors plugins in
// Cordis's FUNCTIONAL form (`export const name` / `export const inject` /
// `export function apply`), where CodeSurf's own plugins use the object form.
// Both are Cordis, both mount, and this file is the evidence.
//
// If this ever fails, the runtime has stopped being Cordis and has become a
// bespoke thing wearing its name.

import { createCodesurfRoot } from "@codesurf/runtime";
import { Service } from "@deepseek-ai/cordis";
import * as skillBadge from "@deepseek-ai/dsh-skill-badge";
import { describe, expect, it } from "vitest";

/** Cordis FiberState.ACTIVE. It is a `const enum`, so use the literal. */
const ACTIVE = 2;

interface SkillCandidate {
  name: string;
  description: string;
  invocation: { modelInvocable: boolean; userInvocable: boolean };
}
interface SkillProvider {
  name: string;
  list(): Promise<SkillCandidate[]>;
  get(candidate: SkillCandidate): Promise<{ name: string; content: string }>;
}

/**
 * The service the harness plugin asks for by name.
 *
 * CodeSurf does not ship a `skills` service, which is the interesting part: the
 * foreign plugin DECLARES what it needs, stays inert until the host supplies
 * it, and activates the moment it appears.
 */
class SkillsService extends Service {
  providers: Array<() => SkillProvider> = [];

  constructor(ctx: unknown) {
    super(ctx as never, "skills");
  }

  registerProvider(factory: () => SkillProvider): () => void {
    this.providers.push(factory);
    const remove = () => {
      this.providers = this.providers.filter((p) => p !== factory);
    };
    // Scope the registration to the CALLING fiber: `this.ctx` is the caller's
    // context, so disposing that plugin removes what it registered. This is the
    // contract CodeSurf's own services honour, and the harness plugin relies on
    // it — its `apply` registers without an explicit `ctx.effect`.
    (this as unknown as { ctx: { effect(cb: () => () => void): void } }).ctx.effect(() => remove);
    return remove;
  }
}

describe("a deepseek-harness plugin on the CodeSurf runtime", () => {
  it("is a Cordis plugin in the functional form, unmodified from npm", () => {
    expect(skillBadge.name).toBe("skill-badge");
    expect(skillBadge.inject).toEqual(["skills"]);
    expect(typeof skillBadge.apply).toBe("function");
  });

  it("stays inert until the host provides the service it injects", async () => {
    const root = createCodesurfRoot({});
    const fiber = root.plugin(skillBadge);

    // No `skills` service yet: PENDING, not failed and not crashed.
    expect(fiber.state).not.toBe(ACTIVE);
    expect((root as unknown as { skills?: unknown }).skills).toBeUndefined();

    await fiber.dispose();
  });

  it("activates and contributes its skill once `skills` exists", async () => {
    const root = createCodesurfRoot({});
    const fiber = root.plugin(skillBadge);
    new SkillsService(root);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const skills = (root as unknown as { skills: SkillsService }).skills;
    expect(skills.providers).toHaveLength(1);

    const provider = skills.providers[0]?.() as SkillProvider;
    expect(provider.name).toBe("dsh-badge");

    const [candidate] = await provider.list();
    expect(candidate?.name).toBe("dsh-badge");
    expect(candidate?.invocation).toEqual({ modelInvocable: true, userInvocable: true });

    // Its real bundled asset, read off disk by the plugin itself.
    const definition = await provider.get(candidate as SkillCandidate);
    expect(definition.content).toContain("dsh Badge");
    expect(definition.content.length).toBeGreaterThan(500);

    await fiber.dispose();
  });

  it("releases its contribution when the fiber is disposed", async () => {
    const root = createCodesurfRoot({});
    const fiber = root.plugin(skillBadge);
    new SkillsService(root);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const skills = (root as unknown as { skills: SkillsService }).skills;
    expect(skills.providers).toHaveLength(1);

    await fiber.dispose();

    // Disposal — not a host sweep — is what removes it.
    expect(skills.providers).toHaveLength(0);
  });
});
