// ─────────────────────────────────────────────────────────────────────────────
// connectors/jira.js
//
// ENV VARS:
//   JIRA_URL      — e.g. https://mycompany.atlassian.net
//   JIRA_EMAIL    — Atlassian account email
//   JIRA_TOKEN    — API token
//   JIRA_PROJECT  — Default project key e.g. "DE" or "DATA"
// ─────────────────────────────────────────────────────────────────────────────

const JIRA_URL     = process.env.JIRA_URL;
const JIRA_PROJECT = process.env.JIRA_PROJECT || "";

const jiraHeaders = () => ({
  Authorization: `Basic ${Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_TOKEN}`).toString("base64")}`,
  Accept:        "application/json",
});

async function jiraFetch(path) {
  const res = await fetch(`${JIRA_URL}/rest/api/3${path}`, { headers: jiraHeaders() });
  if (!res.ok) throw new Error(`Jira API ${res.status}: ${path}`);
  return res.json();
}

export const jiraConnector = {
  meta: {
    label:       "Jira",
    icon:        "🎯",
    description: "Epics, bugs, tech debt tickets, open issues",
    docsUrl:     "https://developer.atlassian.com/cloud/jira/platform/rest/v3/",
    envVars: [
      { key: "JIRA_URL",     label: "Jira URL",       required: true,  hint: "https://yourco.atlassian.net" },
      { key: "JIRA_EMAIL",   label: "Account Email",  required: true,  hint: "your@email.com" },
      { key: "JIRA_TOKEN",   label: "API Token",      required: true,  hint: "From id.atlassian.com → Security → API tokens" },
      { key: "JIRA_PROJECT", label: "Project Key",    required: false, hint: "e.g. DE or DATA" },
    ],
    sectionsSupported: ["known_issues", "runbooks", "biz_context"],
  },

  isConfigured: () => !!(process.env.JIRA_URL && process.env.JIRA_EMAIL && process.env.JIRA_TOKEN),

  async testConnection() {
    await jiraFetch("/myself");
    return true;
  },

  async fetch({ keyword, projectKey }) {
    const project = projectKey || JIRA_PROJECT;
    const jql = encodeURIComponent(
      `project = "${project}" AND (summary ~ "${keyword}" OR description ~ "${keyword}" OR labels = "${keyword}") ORDER BY updated DESC`
    );

    const data = await jiraFetch(`/search?jql=${jql}&maxResults=30&fields=summary,status,priority,labels,issuetype,description,assignee,created,updated`);

    const issues = (data.issues || []).map(i => ({
      key:         i.key,
      summary:     i.fields.summary,
      type:        i.fields.issuetype?.name,
      status:      i.fields.status?.name,
      priority:    i.fields.priority?.name,
      labels:      i.fields.labels || [],
      assignee:    i.fields.assignee?.displayName,
      url:         `${JIRA_URL}/browse/${i.key}`,
      description: i.fields.description?.content?.[0]?.content?.[0]?.text?.slice(0, 300) || "",
      updated:     i.fields.updated?.split("T")[0],
    }));

    return { issues, projectKey: project };
  },
};
