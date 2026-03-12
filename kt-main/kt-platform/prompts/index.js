// prompts/index.js — single import point for all prompts

import { buildOrgContext }   from "./org-context.js";
import { GITHUB_PROMPT }     from "./github.js";
import { ASK_PROMPT }        from "./ask-agent.js";
import { DATABASE_PROMPT }   from "./database.js";
import { CONFLUENCE_PROMPT } from "./confluence.js";
import { JIRA_PROMPT }       from "./jira.js";
import { NOTION_PROMPT }     from "./notion.js";

const orgContext = buildOrgContext();

const SECTION_LABELS = {
  biz_context:    "Business Context",
  data_context:   "Data Context",
  pipelines:      "Pipeline Inventory",
  data_sources:   "Data Sources",
  environment:    "Environment",
  infrastructure: "Infrastructure",
  data_quality:   "Data Quality",
  runbooks:       "Runbooks",
  known_issues:   "Known Issues",
  contacts:       "Contacts",
};

const SOURCE_PROMPTS = {
  github:     GITHUB_PROMPT,
  database:   DATABASE_PROMPT,
  confluence: CONFLUENCE_PROMPT,
  jira:       JIRA_PROMPT,
  notion:     NOTION_PROMPT,
};

export const PROMPTS = {
  orgContext,
  sectionLabels: SECTION_LABELS,

  // Direct access to each source's prompt object (for system prompts etc.)
  github:     GITHUB_PROMPT,
  database:   DATABASE_PROMPT,
  confluence: CONFLUENCE_PROMPT,
  jira:       JIRA_PROMPT,
  notion:     NOTION_PROMPT,
  ask:        ASK_PROMPT,

  // Get system prompt for a given source
  getSystem(sourceId) {
    return SOURCE_PROMPTS[sourceId]?.system || GITHUB_PROMPT.system;
  },

  // Build populate prompt for any source — server.js calls this per-connector
  buildPopulate({ source, sourceData, promptTemplate, sectionsToPopulate, sectionLabels }) {
    const sp = SOURCE_PROMPTS[source];
    if (!sp) throw new Error(`Unknown prompt source "${source}". Add it to prompts/index.js.`);
    return sp.build({
      // each prompt's build() takes what it needs — pass everything
      sourceData,
      githubData:     source === "github"     ? sourceData : undefined,
      schemaData:     source === "database"   ? sourceData : undefined,
      confluenceData: source === "confluence" ? sourceData : undefined,
      jiraData:       source === "jira"       ? sourceData : undefined,
      notionData:     source === "notion"     ? sourceData : undefined,
      promptTemplate,
      sectionsToPopulate,
      sectionLabels: sectionLabels || SECTION_LABELS,
      orgContext,
    });
  },

  // Build ask system + user message — contextParts is { github: data, database: data, ... }
  buildAsk({ contextParts = {}, ktContext, question }) {
    // Format each source's context
    let githubContext     = contextParts.github     ? ASK_PROMPT.formatGithubContext(contextParts.github)         : "";
    let dbContext         = contextParts.database   ? DATABASE_PROMPT.formatSchema(contextParts.database)          : null;
    let confluenceContext = contextParts.confluence ? CONFLUENCE_PROMPT.formatPages(contextParts.confluence)       : null;
    let jiraContext       = contextParts.jira       ? `JIRA:\n${JIRA_PROMPT.formatData(contextParts.jira)}`        : null;
    let notionContext     = contextParts.notion     ? `NOTION:\n${NOTION_PROMPT.formatData(contextParts.notion)}`  : null;

    return {
      system: ASK_PROMPT.system(orgContext),
      userMessage: ASK_PROMPT.userMessage({
        githubContext,
        ktContext,
        dbContext,
        confluenceContext,
        jiraContext,
        notionContext,
        question,
      }),
    };
  },
};
