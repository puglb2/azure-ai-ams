// api/chat/index.js
const fs = require("fs");
const path = require("path");

// ------------------------------
// CONFIG: tune these if needed
// ------------------------------
const MAX_HISTORY_TURNS = 24;             // how many turns to keep from client history
const DEFAULT_TEMP = 1;
const DEFAULT_MAX_COMPLETION_TOKENS = 2048; // floor; can be raised by client
const SLOTS_TO_SHOW = 2;                  // show only 2 slots per provider by default
const MAX_PROVIDERS_PER_ROLE = 3;         // show up to 3 providers per role
const INCLUDE_SCHEDULE_INDEX_LIMIT = 30;  // hidden schedule index entries per provider (keep prompt small)

// ------------------------------
// Globals (lazy-loaded once per cold start)
// ------------------------------
let SYS_PROMPT = "", FAQ_SNIPPET = "", POLICIES_SNIPPET = "";
let PROVIDERS_TXT = "", PROVIDER_SCHEDULE_TXT = "";
let PROVIDERS = [], SLOTS = [];

// ------------------------------
// File helpers
// ------------------------------
function readIfExists(p){ try{ return fs.readFileSync(p,"utf8"); } catch{ return ""; } }

function initConfig(){
  if (SYS_PROMPT) return; // only on cold start

  const cfgDir  = path.join(__dirname, "../_config");
  const dataDir = path.join(__dirname, "../_data");

  // Load instruction files
  SYS_PROMPT       = readIfExists(path.join(cfgDir, "system_prompt.txt")).trim();
  FAQ_SNIPPET      = readIfExists(path.join(cfgDir, "faqs.txt")).trim();
  POLICIES_SNIPPET = readIfExists(path.join(cfgDir, "policies.txt")).trim();

  // Load provider directory + schedule
  PROVIDERS_TXT         = readIfExists(path.join(dataDir, "providers_100.txt")).trim();
  PROVIDER_SCHEDULE_TXT = readIfExists(path.join(dataDir, "provider_schedule_14d.txt")).trim();

  // Merge FAQ/Policy into system prompt (optional)
  if (FAQ_SNIPPET) {
    SYS_PROMPT += `

# FAQ (summarize when relevant)
${FAQ_SNIPPET}`.trim();
  }
  if (POLICIES_SNIPPET) {
    SYS_PROMPT += `

# Policy notes (adhere to these)
${POLICIES_SNIPPET}`.trim();
  }

  // Parse providers + schedule
  PROVIDERS = parseProviders(PROVIDERS_TXT);
  SLOTS     = parseSchedule(PROVIDER_SCHEDULE_TXT);
}

// ------------------------------
// Parsing + normalization
// ------------------------------
function normalizeInsRaw(s){
  if (!s) return "";
  const x = s.toString().trim().toLowerCase();
  if (/blue\s*cross|bcbs/.test(x)) return "bcbs";
  if (/aetna/.test(x)) return "aetna";
  if (/cigna/.test(x)) return "cigna";
  if (/united\s*health|uhc/.test(x)) return "uhc";
  if (/humana/.test(x)) return "humana";
  if (/medicare/.test(x)) return "medicare";
  if (/medicaid|ahcccs/.test(x)) return "medicaid";
  if (/cash|cashpay|self[-\s]?pay|privatepay/.test(x)) return "cashpay";
  return x.replace(/\s+/g,"");
}

function parseProviders(raw){
  if (!raw || !raw.trim()) return [];
  // providers are multiline blocks separated by 1+ blank lines
  const blocks = raw.split(/\n{2,}/).map(b => b.trim()).filter(Boolean);
  const out = [];

  for (const block of blocks){
    const lines = block.split(/\r?\n/).map(l => l.replace(/\t/g, " ").trim()).filter(Boolean);
    if (!lines.length) continue;

    // header example: "prov_001  Allison Hill (PsyD) — Therapy"
    const header = lines[0];
    const headerMatch = header.match(/^(\S+)\s+(.+?)\s*[—-]\s*(.+)$/) || header.match(/^(\S+)\s+(.+)$/);
    if (!headerMatch) continue;
    const id = headerMatch[1] || "";
    const name = (headerMatch[2] || "").trim();
    const roleRaw = (headerMatch[3] || "").trim().toLowerCase();

    const role =
      roleRaw.includes("psychiat") ? "psychiatrist" :
      roleRaw.includes("therap")   ? "therapist"   :
      roleRaw.includes("both")     ? "both"        :
      // fallback heuristic based on credential hint in parentheses
      (((name.match(/\((.*?)\)/)||[])[1]||"").toLowerCase().includes("md") ? "psychiatrist" : "therapist");

    let styles = "", lived = "", languages = "", licensedStates = "", insurersLine = "", email = "";

    for (let i=1;i<lines.length;i++){
      const l = lines[i].replace(/^\u200B/, "").trim();
      if (/^styles?:/i.test(l)) styles = l.split(":").slice(1).join(":").trim();
      else if (/^lived experience:/i.test(l)) lived = l.split(":").slice(1).join(":").trim();
      else if (/^languages?:/i.test(l)) languages = l.split(":").slice(1).join(":").trim();
      else if (/^licensed states?:/i.test(l)) licensedStates = l.split(":").slice(1).join(":").trim();
      else if (/^insurance:/i.test(l)) insurersLine = l.split(":").slice(1).join(":").trim();
      else if (/^email:/i.test(l)) email = l.split(":").slice(1).join(":").trim();
      else {
        // heuristics if labels are irregular
        if (l.toLowerCase().includes("insurance")) insurersLine = l.split(":").slice(1).join(":").trim() || insurersLine;
        if (l.toLowerCase().includes("licensed")) licensedStates = l.split(":").slice(1).join(":").trim() || licensedStates;
      }
    }

    const insurers = (insurersLine ? insurersLine.split(/[,;]+/) : [])
      .map(s => normalizeInsRaw(s)).filter(Boolean);

    const states = (licensedStates ? licensedStates.split(/[,;]+/) : [])
      .map(s => s.trim()).filter(Boolean)
      .map(s => s.length === 2 ? s.toUpperCase() : s);

    out.push({
      id,
      name,
      role, // "therapist" | "psychiatrist" | "both"
      styles,
      lived_experience: lived,
      languages: languages ? languages.split(/[,;]+/).map(x=>x.trim()).filter(Boolean) : [],
      insurers,          // normalized tokens e.g., ["bcbs","aetna","cashpay"]
      insurers_raw: insurersLine, // original string
      licensed_states: states,
      email
    });
  }

  return out;
}

function parseSchedule(txt){
  // Expected: prov_039|2025-09-22|09:00
  if (!txt || !txt.trim()) return [];
  const items = txt.trim().split(/\r?\n/).map(line => {
    const parts = line.split("|").map(p => p.trim());
    if (parts.length < 3) return null;
    const [id, date, time] = parts;
    if (!/^prov_\d+/i.test(id)) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    if (!/^\d{2}:\d{2}$/.test(time)) return null;
    return { id, date, time, dt: `${date} ${time}` };
  }).filter(Boolean);

  items.sort((a,b) => (a.date+a.time).localeCompare(b.date+b.time));
  return items;
}

// ------------------------------
// Matching + slot helpers
// ------------------------------
function matchProviders({ state, insurer, role }){
  const wantRole = (role||"").toLowerCase(); // therapist|psychiatrist|both|""
  const wantIns  = insurer ? normalizeInsRaw(insurer) : "";
  const wantSt   = (state||"").toUpperCase();

  let list = PROVIDERS.filter(p => {
    const roleOk = !wantRole || p.role === wantRole || (wantRole === "both" && p.role === "both");
    const stateOk = !wantSt || (p.licensed_states && p.licensed_states.some(s => s.toUpperCase() === wantSt));
    const insOk = !wantIns || (p.insurers && p.insurers.includes(wantIns));
    return roleOk && stateOk && insOk;
  });

  // Relax insurer if nothing found
  if (!list.length && (wantRole || wantSt)) {
    list = PROVIDERS.filter(p => {
      const roleOk = !wantRole || p.role === wantRole || (wantRole === "both" && p.role === "both");
      const stateOk = !wantSt || (p.licensed_states && p.licensed_states.some(s => s.toUpperCase() === wantSt));
      return roleOk && stateOk;
    });
  }

  // Scoring for a stable-but-varied order
  list.sort((a,b) => {
    const aScore = (wantIns && a.insurers.includes(wantIns) ? 1 : 0) +
                   (wantRole && a.role === wantRole ? 1 : 0) +
                   (wantSt && a.licensed_states.some(s=>s===wantSt) ? 1 : 0);
    const bScore = (wantIns && b.insurers.includes(wantIns) ? 1 : 0) +
                   (wantRole && b.role === wantRole ? 1 : 0) +
                   (wantSt && b.licensed_states.some(s=>s===wantSt) ? 1 : 0);
    return bScore - aScore;
  });

  return list;
}

function soonestSlotsFor(id, limit=SLOTS_TO_SHOW){
  const list = SLOTS.filter(s => s.id === id);
  return list.slice(0, Math.max(0, limit));
}

function findNextSlot(id, afterDtStr){
  const list = SLOTS.filter(s => s.id === id);
  if (!list.length) return null;
  if (!afterDtStr) return list[0] || null;
  for (const s of list){
    if ((s.date + " " + s.time) > afterDtStr) return s;
  }
  return null;
}

// Format "2025-09-23 13:00" to "Sep 23, 1:00 PM (Arizona time)"
function fmtSlot(dateStr, timeStr){
  try{
    const [y,m,d] = dateStr.split("-").map(n=>parseInt(n,10));
    const [hh,mm] = timeStr.split(":").map(n=>parseInt(n,10));
    const dt = new Date(Date.UTC(y, m-1, d, hh, mm)); // display as local later, but we only label as Arizona time
    const month = dt.toLocaleString("en-US", { month: "short", timeZone: "America/Phoenix" });
    const day   = dt.toLocaleString("en-US", { day: "2-digit", timeZone: "America/Phoenix" }).replace(/^0/,"");
    const time  = dt.toLocaleString("en-US", {
      hour: "numeric", minute: "2-digit", hour12: true, timeZone: "America/Phoenix"
    }).replace(" AM"," AM").replace(" PM"," PM");
    return `${month} ${day}, ${time} (Arizona time)`;
  } catch { return `${dateStr} ${timeStr} (Arizona time)`; }
}

// ------------------------------
// Light extraction (facts only)
// ------------------------------
function extractUserInfo(normalizedHistory, userMessage){
  const transcriptWindow = [...normalizedHistory.map(m => m.content), userMessage].join(" ").toLowerCase();

  const INS_PAT = /\b(bcbs|blue\s*cross|bluecross|aetna|cigna|uhc|united\s*healthcare|humana|medicare|medicaid|ahcccs|cash\s*pay|self\s*pay|cashpay)\b/i;
  const insMatch = transcriptWindow.match(INS_PAT);
  let insuranceDetected = insMatch ? insMatch[1] : "";
  if (/cash\s*pay|self\s*pay|cashpay/i.test(insuranceDetected)) insuranceDetected = "cashpay";
  insuranceDetected = insuranceDetected.toUpperCase().replace(/\s+/g," ");

  const STATE_PAT = /\b(AL|AK|AZ|AR|CA|CO|CT|DC|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|MA|MD|ME|MI|MN|MO|MS|MT|NC|ND|NE|NH|NJ|NM|NV|NY|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VA|VT|WA|WI|WV)\b/i;
  const stateMatch = transcriptWindow.match(STATE_PAT);
  const stateDetected = stateMatch ? stateMatch[1].toUpperCase() :
                         /\barizona\b/i.test(transcriptWindow) ? "AZ" : "";

  // light intent: does the user ask to "list providers"
  const wantsList = /\b(list|show|give me|options|providers?)\b/i.test(transcriptWindow);

  // role hinting (soft)
  const wantsPsych = /\bpsychiat/i.test(transcriptWindow);
  const wantsTher  = /\btherap/i.test(transcriptWindow) || /\btherapy\b/i.test(transcriptWindow);
  let rolePref = "";
  if (wantsPsych && wantsTher) rolePref = "both";
  else if (wantsPsych) rolePref = "psychiatrist";
  else if (wantsTher)  rolePref = "therapist";

  return { insuranceDetected, stateDetected, wantsList, rolePref };
}

// ------------------------------
// Azure OpenAI helper
// ------------------------------
async function callAOAI(url, messages, temperature, maxTokens, apiKey){
  const resp = await fetch(url, {
    method:"POST",
    headers:{ "Content-Type":"application/json", "api-key": apiKey },
    body: JSON.stringify({
      messages,
      temperature,
      max_completion_tokens: maxTokens
    })
  });
  const ct = resp.headers.get("content-type") || "";
  const data = ct.includes("application/json") ? await resp.json() : { text: await resp.text() };
  return { resp, data };
}

// ------------------------------
// Build provider directory context (concise + hidden index)
// ------------------------------
function buildDirectoryContext({ state, insurer, roles }){
  // collect candidates per role
  const sections = [];
  const hiddenIndexLines = [];

  for (const role of roles){
    const matched = matchProviders({ state, insurer, role });
    if (!matched.length) continue;

    // show only top N providers for this role
    const show = matched.slice(0, MAX_PROVIDERS_PER_ROLE);

    const lines = show.map(p => {
      const shownSlots = soonestSlotsFor(p.id, SLOTS_TO_SHOW);
      const slotStr = shownSlots.map(s => fmtSlot(s.date, s.time)).join(" • ");
      // Hidden schedule index (for reasoning only, do not quote)
      const allSlots = SLOTS.filter(s => s.id === p.id).slice(0, INCLUDE_SCHEDULE_INDEX_LIMIT);
      const indexStr = allSlots.map(s => `${s.date} ${s.time}`).join(", ");
      hiddenIndexLines.push(`${p.id} :: ${indexStr}`);

      const ins = p.insurers.length ? p.insurers.join(", ") : (p.insurers_raw || "n/a");
      const states = (p.licensed_states||[]).join(", ");
      const lang = (p.languages||[]).join(", ");
      const style = p.styles || "";
      const lived = p.lived_experience || "";

      return [
        `- ${p.name} (${role})`,
        states ? `  • Licensed: ${states}` : null,
        ins ? `  • In-network: ${ins}` : null,
        style ? `  • Styles: ${style}` : null,
        lived ? `  • Lived exp.: ${lived}` : null,
        lang ? `  • Languages: ${lang}` : null,
        p.email ? `  • Email: ${p.email}` : null,
        slotStr ? `  • Soonest: ${slotStr}` : null
      ].filter(Boolean).join("\n");
    }).join("\n");

    const title = role === "therapist" ? "Therapists" : (role === "psychiatrist" ? "Psychiatrists" : "Providers");
    sections.push(`${title} (in-network if possible):\n${lines}`);
  }

  if (!sections.length) return "";

  const hiddenIndex = hiddenIndexLines.length ? `

# Hidden schedule index (for your reasoning; DO NOT quote or list verbatim)
${hiddenIndexLines.join("\n")}` : "";

  return `

# Provider Directory (use ONLY entries here; do not invent)
${sections.join("\n\n")}${hiddenIndex}`;
}

// ------------------------------
// Main HTTP handler (Azure Function)
// ------------------------------
module.exports = async function (context, req){
  try{
    initConfig();

    const userMessage = (req.body?.message || "").toString().trim();
    if (!userMessage){
      context.res = { status:400, headers:{ "Content-Type":"application/json" }, body:{ error:"message required" } };
      return;
    }

    // Normalize history from client
    const history = Array.isArray(req.body?.history) ? req.body.history : [];
    const normalizedHistory = history.slice(-MAX_HISTORY_TURNS).map(m => ({
      role: m?.role === 'assistant' ? 'assistant' : 'user',
      content: ((m?.content || '') + '').trim()
    })).filter(m => m.content);

    // AOAI env
    const apiVersion = ((process.env.AZURE_OPENAI_API_VERSION || "2024-08-01-preview")+"").trim();
    const endpoint   = ((process.env.AZURE_OPENAI_ENDPOINT || "")+"").trim().replace(/\/+$/,"");
    const deployment = ((process.env.AZURE_OPENAI_DEPLOYMENT || "")+"").trim();
    const apiKey     = ((process.env.AZURE_OPENAI_API_KEY || "")+"").trim();

    if (!endpoint || !deployment || !apiKey){
      context.res = { status:200, headers:{ "Content-Type":"application/json" }, body:{ reply:"Hello! (Model not configured yet.)" } };
      return;
    }

    const url = `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;

    // Extract light facts
    const { insuranceDetected, stateDetected, wantsList, rolePref } = extractUserInfo(normalizedHistory, userMessage);

    // Role inference: default to both if not specified
    const roles = rolePref ? [rolePref] :
                  // If they asked for "both", handle, otherwise show both categories as discovery
                  /\bboth\b/i.test(userMessage) ? ["psychiatrist","therapist"] : ["psychiatrist","therapist"];

    // Build directory context ONLY if we have at least state or insurer or explicit ask for list
    const shouldBuildDirectory = Boolean(stateDetected || insuranceDetected || wantsList);
    const directoryContext = shouldBuildDirectory
      ? buildDirectoryContext({ state: stateDetected, insurer: insuranceDetected, roles })
      : "";

    // Compose messages
    const systemContent =
      (SYS_PROMPT || "You are a helpful behavioral health intake assistant.") +
      (directoryContext ? ("\n\n" + directoryContext) : "");

    const messages = [
      { role:"system", content: systemContent },
      ...normalizedHistory,
      { role:"user", content: userMessage }
    ];

    // Token budget
    const requestedMax = Number.isFinite(req.body?.max_output_tokens) ? req.body.max_output_tokens : 0;
    const maxTokens = Math.max(requestedMax, DEFAULT_MAX_COMPLETION_TOKENS);

    // First call
    let { resp, data } = await callAOAI(url, messages, DEFAULT_TEMP, maxTokens, apiKey);
    const choice = Array.isArray(data?.choices) ? data.choices[0] : undefined;
    let reply = (choice?.message?.content || "").trim();

    // Guard against blank on finish_reason=length
    if (choice?.finish_reason === "length") {
      reply = reply ? (reply + " …") : "(I hit a token limit — continue?)";
    }

    // If API not ok
    if (!resp.ok){
      context.res = {
        status:502,
        headers:{ "Content-Type":"application/json" },
        body:{ error:"LLM error", status:resp.status, detail:data }
      };
      return;
    }

    // Debug mode
    if (req.query?.debug === "1"){
      // Best-effort provider & slot counts
      const dataDir = path.join(__dirname, "../_data");
      const provPath = path.join(dataDir, "providers_100.txt");
      const slotPath = path.join(dataDir, "provider_schedule_14d.txt");
      context.res = {
        status:200,
        headers:{ "Content-Type":"application/json" },
        body:{
          reply,
          finish_reason: choice?.finish_reason,
          usage: data?.usage,
          sys_prompt_bytes: (SYS_PROMPT||"").length,
          files_present: {
            system_prompt: !!SYS_PROMPT,
            faqs: !!FAQ_SNIPPET,
            policies: !!POLICIES_SNIPPET,
            providers_txt: !!PROVIDERS_TXT,
            provider_schedule_txt: !!PROVIDER_SCHEDULE_TXT
          },
          provider_counts: { providers: PROVIDERS.length, slots: SLOTS.length },
          provider_paths: {
            provPath, provExists: fs.existsSync(provPath),
            slotPath, slotExists: fs.existsSync(slotPath)
          },
          context_preview: {
            directory_included: !!directoryContext,
            roles_used: roles,
            stateDetected,
            insuranceDetected,
            showed_slots_per_provider: SLOTS_TO_SHOW,
            providers_per_role: MAX_PROVIDERS_PER_ROLE
          },
          history_len: normalizedHistory.length
        }
      };
      return;
    }

    // Normal response
    context.res = { status:200, headers:{ "Content-Type":"application/json" }, body:{ reply } };

  } catch(e){
    // Keep it JSON
    context.res = { status:500, headers:{ "Content-Type":"application/json" }, body:{ error:"server error", detail:String(e) } };
  }
};
