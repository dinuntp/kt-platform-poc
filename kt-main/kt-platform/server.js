// ─── KT Platform — Backend Server ──────────────────────────────────────────
// Run: node server.js
// ──────────────────────────────────────────────────────────────────────────

import "dotenv/config";
import express   from "express";
import cors      from "cors";
// TODO: Uncomment when ANTHROPIC_API_KEY is ready
// import Anthropic from "@anthropic-ai/sdk";
import { PROMPTS as _PROMPTS }    from "./prompts/index.js"; // TODO: rename back to PROMPTS when API key ready
import { CONNECTORS } from "./connectors/index.js";
import fs   from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── FILE STORAGE HELPERS ─────────────────────────────────────────────────

const DATA_DIR = path.resolve(__dirname, "kt-data");

// Slugify project name for folder name
function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// Section ID → folder name
function sectionFolder(sectionId) {
  return sectionId.replace(/_/g, "-");
}

// ── Path jail ────────────────────────────────────────────────────────────────
// Confirms a resolved path is inside DATA_DIR before any file operation.
// Throws if the path escapes — this is the hard boundary.
function assertInsideDataDir(resolvedPath) {
  if (!resolvedPath.startsWith(DATA_DIR + path.sep) && resolvedPath !== DATA_DIR) {
    throw new Error(`Path escape attempt blocked: ${resolvedPath}`);
  }
}

// Safe path builder — always use this instead of path.join(DATA_DIR, ...) directly
function dataPath(...parts) {
  const resolved = path.resolve(DATA_DIR, ...parts);
  assertInsideDataDir(resolved);
  return resolved;
}

// Ensure a directory exists
function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// Write JSON file atomically (write to tmp, rename)
function writeJSON(filePath, data) {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmp, filePath);
}

// Read JSON file, return null if missing
function readJSON(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf-8")); }
  catch { return null; }
}

// List all saved projects (folder names in kt-data/)
function listProjects() {
  if (!fs.existsSync(DATA_DIR)) return [];
  return fs.readdirSync(DATA_DIR)
    .filter(f => fs.statSync(dataPath(f)).isDirectory())
    .map(folderName => {
      const meta = readJSON(dataPath(folderName, "_meta", "project.json"));
      return meta ? { folderName, ...meta } : null;
    })
    .filter(Boolean);
}

// Save a full project to disk — one folder per section
function saveProjectToDisk(project, projectData) {
  const folderName = project._folderName || slug(project.name);
  const projectDir = dataPath(folderName);
  mkdirp(path.join(projectDir, "_meta"));

  // Write project metadata
  writeJSON(path.join(projectDir, "_meta", "project.json"), {
    id:           project.id,
    name:         project.name,
    client:       project.client,
    phase:        project.phase,
    githubKeyword: project.githubKeyword,
    enabledSources: project.enabledSources,
    createdAt:    project.createdAt,
    savedAt:      new Date().toISOString(),
    _folderName:  folderName,
  });

  // Write sign-off
  if (projectData.signoff) {
    writeJSON(path.join(projectDir, "_meta", "signoff.json"), projectData.signoff);
  }

  // Write each section into its own folder
  const checklist = projectData.checklist || {};
  for (const [sectionId, items] of Object.entries(checklist)) {
    const secDir = path.join(projectDir, sectionFolder(sectionId));
    mkdirp(secDir);

    // items.json — full structured data for the agent
    writeJSON(path.join(secDir, "items.json"), {
      sectionId,
      projectId:   project.id,
      projectName: project.name,
      savedAt:     new Date().toISOString(),
      items: (items || []).map(item => ({
        item:      item.item,
        status:    item.status,
        notes:     item.notes     || "",
        link:      item.link      || "",
        docStatus: item.docStatus || "",
        // include all extra fields
        ...Object.fromEntries(
          Object.entries(item).filter(([k]) => !["item","status","notes","link","docStatus"].includes(k))
        ),
      })),
      // Extracted links for agent context
      links: (items || [])
        .filter(i => i.link)
        .map(i => ({ item: i.item, url: i.link, notes: i.notes || "" })),
      // Summary counts
      summary: {
        total:      (items||[]).length,
        done:       (items||[]).filter(i=>i.status==="Done").length,
        inProgress: (items||[]).filter(i=>i.status==="In Progress").length,
        blocked:    (items||[]).filter(i=>i.status==="Blocked").length,
        notStarted: (items||[]).filter(i=>i.status==="Not Started").length,
      },
    });
  }

  // Write KT sessions
  if (projectData.sessions?.length) {
    const secDir = path.join(projectDir, "kt-sessions");
    mkdirp(secDir);
    writeJSON(path.join(secDir, "items.json"), {
      sectionId: "kt_sessions",
      savedAt: new Date().toISOString(),
      sessions: projectData.sessions,
    });
  }

  // Write reverse KT
  if (projectData.reverseKT?.length) {
    const secDir = path.join(projectDir, "reverse-kt");
    mkdirp(secDir);
    writeJSON(path.join(secDir, "items.json"), {
      sectionId: "reverse_kt",
      savedAt: new Date().toISOString(),
      items: projectData.reverseKT,
    });
  }

  return folderName;
}

// Load a project from disk back into app state shape
function loadProjectFromDisk(folderName) {
  const projectDir = dataPath(folderName);
  if (!fs.existsSync(projectDir)) return null;

  const project = readJSON(path.join(projectDir, "_meta", "project.json"));
  if (!project) return null;

  const signoff = readJSON(path.join(projectDir, "_meta", "signoff.json")) || {};

  // Read all section folders
  const checklist = {};
  const sectionFolders = fs.readdirSync(projectDir)
    .filter(f => f !== "_meta" && fs.statSync(path.join(projectDir, f)).isDirectory());

  for (const folder of sectionFolders) {
    const data = readJSON(path.join(projectDir, folder, "items.json"));
    if (data?.sectionId && data.items) {
      checklist[data.sectionId] = data.items;
    }
  }

  // Read sessions + reverseKT if stored as sections
  const sessions   = checklist["kt_sessions"]   ? checklist["kt_sessions"]   : readJSON(path.join(projectDir, "kt-sessions",  "items.json"))?.sessions  || [];
  const reverseKT  = checklist["reverse_kt"]    ? checklist["reverse_kt"]    : readJSON(path.join(projectDir, "reverse-kt",   "items.json"))?.items     || [];
  delete checklist["kt_sessions"];
  delete checklist["reverse_kt"];

  return { project, projectData: { checklist, sessions, reverseKT, signoff, agentDrafts: {} } };
}

// Read all section data for a project — used by the agent for full context
function loadProjectContext(folderName) {
  const projectDir = dataPath(folderName);
  if (!fs.existsSync(projectDir)) return null;

  const context = {};
  const sectionFolders = fs.readdirSync(projectDir)
    .filter(f => f !== "_meta" && fs.statSync(path.join(projectDir, f)).isDirectory());

  for (const folder of sectionFolders) {
    const data = readJSON(path.join(projectDir, folder, "items.json"));
    if (data) context[folder] = data;
  }

  return context;
}

const app       = express();
// TODO: Uncomment when ANTHROPIC_API_KEY is ready
// const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const PORT      = process.env.PORT || 3001;

app.use(cors({ origin: ["http://localhost:3001", "http://127.0.0.1:3001", "http://localhost:5173", "http://localhost:5174", "http://127.0.0.1:5173", "http://127.0.0.1:5174"] }));
app.use(express.json({ limit: "2mb" }));

// Disable caching for API responses
app.use((req, res, next) => {
  if (req.path.startsWith('/api')) {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  }
  next();
});

// ─── INPUT VALIDATION ─────────────────────────────────────────────────────

const ALLOWED_CONNECTOR_IDS = ["github", "confluence", "database", "jira", "notion"];

// Prevent path traversal — folder names must be safe slugs only
function safeFolderName(name) {
  if (!name || typeof name !== "string") return null;
  const clean = name.replace(/[^a-z0-9\-_]/gi, "");
  if (clean !== name || clean.includes("..") || clean.length > 100) return null;
  return clean;
}

// Validate enabledSources array from client
function sanitiseSources(sources) {
  if (!Array.isArray(sources)) return ["github"];
  return sources.filter(s => ALLOWED_CONNECTOR_IDS.includes(s));
}

function sseStream(res) {
  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  return (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// Dinesh: Commented out: Front end serving for UI — with proxy to this API server.
//// ─── SERVE HTML ───────────────────────────────────────────────────────────
//app.use(express.static(__dirname));
//app.get("/", (req, res) => res.sendFile(path.join(__dirname, "kt-platform.html")));

// ─── ROUTES ───────────────────────────────────────────────────────────────

// Health
app.get("/api/status", (req, res) => {
  res.json({
    status: "ok",
    client: process.env.CLIENT_NAME || "Unknown",
    claude: { configured: !!process.env.ANTHROPIC_API_KEY },
  });
});

// ─── FILE PERSISTENCE ROUTES ──────────────────────────────────────────────

// Save a project to disk
app.post("/api/project/save", (req, res) => {
  const { project, projectData } = req.body;
  if (!project?.id || !project?.name) return res.status(400).json({ error: "project.id and project.name required" });
  try {
    const folderName = saveProjectToDisk(project, projectData);
    res.json({ ok: true, folderName, savedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Load a project from disk
app.get("/api/project/load/:folderName", (req, res) => {
  const folderName = safeFolderName(req.params.folderName);
  if (!folderName) return res.status(400).json({ error: "Invalid folder name" });
  try {
    const result = loadProjectFromDisk(folderName);
    if (!result) return res.status(404).json({ error: "Project not found" });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List all saved projects on disk
app.get("/api/project/list", (req, res) => {
  try {
    res.json({ ok: true, projects: listProjects() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get full section context for agent (all items + links per section)
app.get("/api/project/context/:folderName", (req, res) => {
  const folderName = safeFolderName(req.params.folderName);
  if (!folderName) return res.status(400).json({ error: "Invalid folder name" });
  try {
    const context = loadProjectContext(folderName);
    if (!context) return res.status(404).json({ error: "Project not found" });
    res.json({ ok: true, context });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List what's saved on disk for a project (folder structure)
app.get("/api/project/files/:folderName", (req, res) => {
  const folderName = safeFolderName(req.params.folderName);
  if (!folderName) return res.status(400).json({ error: "Invalid folder name" });
  try {
    const projectDir = dataPath(folderName);
    if (!fs.existsSync(projectDir)) return res.status(404).json({ error: "Not found" });
    const structure = {};
    const folders = fs.readdirSync(projectDir).filter(f => fs.statSync(path.join(projectDir, f)).isDirectory());
    for (const folder of folders) {
      const files = fs.readdirSync(path.join(projectDir, folder));
      structure[folder] = files;
    }
    res.json({ ok: true, folderName, structure });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.get("/api/sources/status", async (req, res) => {
  try {
    const status = await CONNECTORS.getStatus();
    res.json({ connectors: status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Test a single connector live
app.post("/api/sources/test/:id", async (req, res) => {
  const id = req.params.id;
  if (!ALLOWED_CONNECTOR_IDS.includes(id)) return res.status(400).json({ error: "Unknown connector" });
  const connector = CONNECTORS[id];
  if (!connector?.testConnection) return res.status(404).json({ error: "Unknown connector" });
  try {
    await connector.testConnection();
    const mode = connector.getConnectionMode ? await connector.getConnectionMode() : "rest";
    res.json({ ok: true, mode });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ─── AGENT: POPULATE ──────────────────────────────────────────────────────
// Runs each enabled+configured connector, then asks Claude to draft KT
// sections from each source. Results are merged with source attribution.

app.post("/api/agent/populate", async (req, res) => {
  const {
    projectKeyword,
    sections,
    promptTemplate: _promptTemplate, // used in Claude block — TODO: rename back when API key ready
    enabledSources = ["github"],
  } = req.body;

  const safeSources = sanitiseSources(enabledSources);

  if (!projectKeyword) return res.status(400).json({ error: "projectKeyword required" });

  const send = sseStream(res);

  try {
    const sectionsToPopulate = sections || [
      "biz_context","pipelines","data_sources","infrastructure",
      "data_quality","known_issues","contacts",
    ];

    const allDrafts   = {};
    const sourcesMeta = [];

    for (const sourceId of safeSources) {
      const connector = CONNECTORS[sourceId];
      if (!connector) {
        send("log", { message: `⚠️  Unknown source "${sourceId}" — skipping` });
        continue;
      }
      if (!connector.isConfigured()) {
        send("log", { message: `⚠️  ${connector.meta.label}: not configured (check .env) — skipping` });
        continue;
      }

      send("log", { message: `${connector.meta.icon} Connecting to ${connector.meta.label}…` });

      let sourceData;
      try {
        sourceData = await connector.fetch({ keyword: projectKeyword });
      } catch (err) {
        send("log", { message: `⚠️  ${connector.meta.label} fetch failed: ${err.message}` });
        continue;
      }

      if (!sourceData) {
        send("log", { message: `⚠️  ${connector.meta.label}: no data found for "${projectKeyword}"` });
        continue;
      }

      if (sourceId === "github" && sourceData.mode) {
        send("log", { message: `   ↳ connected via ${sourceData.mode.toUpperCase()}` });
      }

      // Only ask Claude to populate sections this source supports
      const targetSections = sectionsToPopulate.filter(s =>
        connector.meta.sectionsSupported.includes(s)
      );
      if (!targetSections.length) continue;

      send("log", { message: `🤖 Drafting [${targetSections.join(", ")}] from ${connector.meta.label}…` });

      try {
        // TODO: Uncomment all of this block when ANTHROPIC_API_KEY is ready
        // const prompt = PROMPTS.buildPopulate({
        //   source: sourceId,
        //   promptTemplate,
        //   sourceData,
        //   sectionsToPopulate: targetSections,
        //   sectionLabels: PROMPTS.sectionLabels,
        // });
        // const response = await anthropic.messages.create({
        //   model:      "claude-sonnet-4-5",
        //   max_tokens: 2000,
        //   system:     PROMPTS.getSystem(sourceId),
        //   messages:   [{ role: "user", content: prompt }],
        // });
        // const raw    = response.content[0].text.trim();
        // const clean  = raw.replace(/```json[\s\S]*?```|```/g, "").trim();
        // const result = JSON.parse(clean);

        // Mock response — replace with real API call above when key is ready
        const result = {
          drafts: targetSections.reduce((acc, sec) => {
            acc[sec] = { content: `[Mock] Anthropic API not yet configured. Add ANTHROPIC_API_KEY to .env to enable AI drafts.`, verify: [] };
            return acc;
          }, {}),
          confidence: "low - mocked response",
        };

        // Merge drafts — multiple sources annotate their contributions
        for (const [secId, draft] of Object.entries(result.drafts || {})) {
          if (!allDrafts[secId]) {
            allDrafts[secId] = { ...draft, sources: [connector.meta.label] };
          } else {
            allDrafts[secId].content += `\n\n[${connector.meta.label}]: ${draft.content}`;
            allDrafts[secId].verify  = [...(allDrafts[secId].verify||[]), ...(draft.verify||[])];
            allDrafts[secId].sources = [...(allDrafts[secId].sources||[]), connector.meta.label];
          }
        }

        sourcesMeta.push({ id: sourceId, label: connector.meta.label, sections: targetSections, confidence: result.confidence });
        send("log", { message: `✓ ${connector.meta.label}: ${Object.keys(result.drafts||{}).length} sections drafted (confidence: ${result.confidence||"?"})` });

      } catch (err) {
        send("log", { message: `⚠️  ${connector.meta.label} drafting failed: ${err.message}` });
      }
    }

    const n = Object.keys(allDrafts).length;
    send("log",  { message: `\n✅ Done — ${n} section${n!==1?"s":""} from ${sourcesMeta.length} source${sourcesMeta.length!==1?"s":""}` });
    send("done", { drafts: allDrafts, sources: sourcesMeta });

  } catch (err) {
    send("error", { message: err.message });
  }

  res.end();
});

// ─── AGENT: ASK ───────────────────────────────────────────────────────────

app.post("/api/agent/ask", async (req, res) => {
  const { question, projectKeyword, projectFolderName, ktContext, conversationHistory: _conversationHistory, enabledSources = ["github"] } = req.body;
  if (!question) return res.status(400).json({ error: "question required" });
  const safeSources = sanitiseSources(enabledSources);
  const safeFolder  = projectFolderName ? safeFolderName(projectFolderName) : null;

  try {
    const contextParts = {};
    const activeSources = [];

    // Load full KT context from disk if project has been saved
    let _richKtContext = ktContext || "";
    if (safeFolder) {
      const diskContext = loadProjectContext(safeFolder);
      if (diskContext) {
        // Build rich context: each section with all items, notes, links
        const sections = Object.entries(diskContext).map(([folder, data]) => {
          if (!data?.items?.length) return null;
          const doneItems = data.items.filter(i => i.status === "Done" || i.status === "In Progress");
          if (!doneItems.length) return null;

          const lines = [`## ${data.sectionId?.replace(/_/g, " ").toUpperCase() || folder}`];
          doneItems.forEach(item => {
            lines.push(`- [${item.status}] ${item.item}`);
            if (item.notes) lines.push(`  Notes: ${item.notes}`);
            if (item.link)  lines.push(`  Link: ${item.link}`);
          });

          // Add all links for this section
          if (data.links?.length) {
            lines.push(`  Resources:`);
            data.links.forEach(l => lines.push(`  • ${l.item}: ${l.url}${l.notes ? " — "+l.notes : ""}`));
          }
          return lines.join("\n");
        }).filter(Boolean);

        if (sections.length) _richKtContext = sections.join("\n\n");
        activeSources.push("KT Docs (disk)");
      }
    } else if (ktContext) {
      activeSources.push("KT Docs");
    }

    for (const sourceId of safeSources) {
      const connector = CONNECTORS[sourceId];
      if (!connector?.isConfigured()) continue;
      try {
        const data = await connector.fetch({ keyword: projectKeyword });
        if (data) {
          contextParts[sourceId] = data;
          activeSources.push(connector.meta.label);
        }
      } catch { /* skip failed sources quietly */ }
    }

    // TODO: Uncomment all of this block when ANTHROPIC_API_KEY is ready
    // const { system, userMessage } = PROMPTS.buildAsk({
    //   contextParts,
    //   ktContext: richKtContext,
    //   question,
    // });
    // const response = await anthropic.messages.create({
    //   model:      "claude-sonnet-4-5",
    //   max_tokens: 1000,
    //   system,
    //   messages:   [...(conversationHistory||[]), { role:"user", content: userMessage }],
    // });
    // res.json({ answer: response.content[0].text, sources: activeSources.length ? activeSources : ["General Knowledge"] });

    // Mock response — replace with real API call above when key is ready
    res.json({ answer: "[Mock] Anthropic API not yet configured. Add ANTHROPIC_API_KEY to .env to enable Ask Agent.", sources: activeSources.length ? activeSources : ["General Knowledge"] });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── START ────────────────────────────────────────────────────────────────

const configuredSources = Object.entries(CONNECTORS)
  .filter(([,v]) => typeof v === "object" && v.isConfigured?.())
  .map(([,c]) => `${c.meta.icon} ${c.meta.label}`);

app.listen(PORT, () => {
  // COMMENTED OUT: Original log message before front end proxy setup
  //console.log(`\n🚀 KT Platform Backend running on http://localhost:${PORT}`);
  console.log(`\n🚀 KT Platform running on http://localhost:${PORT}`);
  console.log(`   Client:  ${process.env.CLIENT_NAME || "Not set"}`);
  console.log(`   Claude:  ${process.env.ANTHROPIC_API_KEY ? "✓ API key configured" : "✗ ANTHROPIC_API_KEY not set in .env"}`);
  console.log(`   Sources: ${configuredSources.length ? configuredSources.join("  ") : "none configured — add keys to .env"}`);
  //Dinesh: COMMENTED OUT: Original log message before front end proxy setup
  //console.log(`\n   Frontend: Open http://localhost:5173 (or 5174) in your browser.\n`);
  console.log(`\n   Open kt-platform.html in your browser.\n`);
});