// prompts/jira.js — Jira scan prompt config
export const JIRA_PROMPT = {
  system: `You are a Data Engineering KT specialist analysing Jira tickets.
Extract known issues, technical debt, and business context from issue titles,
descriptions and labels. Write for engineers inheriting this project.`,

  formatData({ issues, projectKey }) {
    if (!issues?.length) return "No Jira issues found.";
    return [
      `Project: ${projectKey} | Issues found: ${issues.length}`,
      issues.map(i =>
        `[${i.key}] ${i.type} | ${i.status} | ${i.priority}\n  ${i.summary}` +
        (i.labels?.length ? `\n  Labels: ${i.labels.join(", ")}` : "") +
        (i.description ? `\n  ${i.description}` : "")
      ).join("\n\n"),
    ].join("\n\n").trim();
  },

  rules: [
    "Extract bugs and open defects for the Known Issues section.",
    "Identify tech debt tickets (labels like debt, refactor, cleanup) for Known Issues.",
    "Pull epics and their goals into Business Context.",
    "Note assignees and reporters as potential contacts.",
    "Flag any tickets marked as blockers or critical priority.",
  ],

  responseFormat(sections) {
    const lines = sections.map(s => `    "${s}": { "content": "...", "verify": ["item1"] }`).join(",\n");
    return `Respond ONLY with valid JSON — no markdown:\n{\n  "confidence": "low|medium|high",\n  "drafts": {\n${lines}\n  }\n}\nOnly include: ${sections.join(", ")}`;
  },

  build({ sourceData, sectionsToPopulate, orgContext }) {
    const target = sectionsToPopulate?.length ? sectionsToPopulate : ["known_issues","biz_context"];
    return [
      orgContext ? orgContext : null,
      `JIRA DATA:\n${this.formatData(sourceData)}`,
      `\nTASK: Draft KT for: ${target.join(", ")}`,
      `\nRULES:\n${this.rules.map((r,i) => `${i+1}. ${r}`).join("\n")}`,
      `\n${this.responseFormat(target)}`,
    ].filter(Boolean).join("\n\n").trim();
  },
};
