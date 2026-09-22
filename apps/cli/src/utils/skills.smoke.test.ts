// Visual smoke render — prints sample /skills output and always passes.
// Run with: npx vitest run src/utils/skills.smoke.test.ts
import { describe, expect, it } from "vitest";
import { discoverSkills, formatSkillsForChat } from "./skills";

describe("smoke render", () => {
  it("prints /skills layouts at width 80, 100, 140", () => {
    const skills = discoverSkills(process.cwd());
    for (const width of [80, 100, 140]) {
      console.log(`\n══════ /skills @ ${width} cols ══════`);
      console.log(formatSkillsForChat(skills, process.cwd(), { terminalWidth: width }));
    }
    console.log("\n══════ /skills paths paseo @ 100 cols ══════");
    console.log(formatSkillsForChat(skills, process.cwd(), { terminalWidth: 100, showPaths: true, filter: "paseo" }));
    expect(true).toBe(true);
  });
});
