/* Local LLM Studio — front-end controller.
 * Talks only to the Flask proxy (same origin), so there is no CORS surface.
 * Streams Ollama's NDJSON response and renders tokens live.
 *
 * XSS note: assistant content is rendered through window.renderMarkdown, which
 * HTML-escapes the entire source string FIRST and only then re-introduces a
 * fixed set of safe tags. No untrusted text reaches the DOM unescaped. */
(function () {
  "use strict";

  const LS_MODEL_KEY = "lls.lastModel";
  const LS_CONVOS_KEY = "lls.conversations"; // array of conversation objects
  const LS_SIDEBAR_KEY = "lls.sidebarCollapsed";
  const LS_THEME_KEY = "lls.theme";
  const LS_FONT_KEY = "lls.fontScale";
  const TITLE_MAX = 40;
  const PREFERRED_LOCAL_MODEL = "gemma4:12b-it-qat";
  const REPLACED_LOCAL_MODELS = new Set(["gemma4:latest", "gemma4:e2b", "gemma4:12b", "gemma3:12b-it-qat"]);

  // Where the lifecycle supervisor lives (empty if run without the launcher).
  const CONTROL_URL = (
    document.querySelector('meta[name="control-url"]')?.content || ""
  ).replace(/\/$/, "");

  // ---- State ----
  let messages = []; // {role, content} — the full multi-turn conversation
  let controller = null; // AbortController for the in-flight stream
  let streaming = false;
  let activeId = null; // id of the conversation currently on screen
  let healthTimer = null; // interval id for the Ollama health poll
  let attachments = []; // pending attachments for the next message: {kind, name, ...}
  let convoQuery = ""; // sidebar search filter (lowercased)
  let latestGrounding = []; // notes that grounded the most recent answer
  let latestRagMeta = null; // {k, returned, min_score} for the most recent answer
  let graphData = null; // cached /api/graph payload
  let graphRendered = false; // lay the knowledge graph out once
  let graphScale = 1, graphRot = 0; // user zoom + drag-rotate of the graph
  let graphDragging = false, graphLastAngle = 0, graphWired = false;
  let graphDragMoved = false; // true if the last gesture rotated (so a node "click" is suppressed)
  let modelList = []; // [{name, size}] from /api/models
  let arenaMode = false; // Model Arena view active
  let paneSeq = 0; // (reserved) instance counter for arena panes
  let arenaControllers = []; // in-flight AbortControllers for arena streams
  let arenaCols = []; // per-column {model, body, tps, ttft, toks, done, tokps}
  const LS_ELO_KEY = "lls.arenaElo"; // {modelName: elo}
  const ARENA_COLORS = ["var(--col-1)", "var(--col-2)", "var(--col-3)", "var(--col-4)"];
  let cloudModels = {}; // connected cloud model id -> provider
  let flagshipModels = {}; // pre-listed flagship id -> provider (shown when provider not connected)
  let connectedProviders = new Set();
  // Always-visible flagship cloud models (placeholders until the key is connected;
  // once connected, the provider's REAL model list replaces these).
  const FLAGSHIPS = [
    { provider: "anthropic", id: "claude-opus-4-7", label: "Claude Opus 4.7" },
    { provider: "openai", id: "gpt-5.5", label: "GPT-5.5" },
    { provider: "gemini", id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
    { provider: "grok", id: "grok-4", label: "Grok 4" },
  ];
  const providerOf = (m) => cloudModels[m] || flagshipModels[m] || "";
  let arenaLayout = "grid"; // "grid" | "tabs"

  // ---- Favorite models (persisted) — starred models pin to a section at the top of
  // both the model dropdown and the Arena race list. ----
  const LS_FAV_KEY = "lls.favoriteModels";
  let favoriteModels = new Set();
  try {
    favoriteModels = new Set(JSON.parse(localStorage.getItem(LS_FAV_KEY) || "[]"));
  } catch (_) { favoriteModels = new Set(); }
  const isFavorite = (id) => favoriteModels.has(id);
  function toggleFavorite(id) {
    if (!id) return;
    if (favoriteModels.has(id)) favoriteModels.delete(id);
    else favoriteModels.add(id);
    localStorage.setItem(LS_FAV_KEY, JSON.stringify([...favoriteModels]));
    renderArenaModelChips();   // refresh the race list's ⭐ section + stars
    renderModelMenu();         // refresh the dropdown's ⭐ section + stars
  }
  let selectedCol = null; // the selected pane (object reference)
  let penHolder = null; // who can edit the live doc — mirrors the selected pane (used in #53)
  let docOpen = false; // a file is open in the live viewer
  let docName = ""; // its basename
  let docContent = ""; // its text (empty for binary)
  let docKind = ""; // markdown | text | image | pdf | video | binary
  let docEditable = false; // text files only
  let userHasPen = false; // the user took the pen for manual editing
  let tpsSeries = []; // recent tokens/sec readings for the HUD sparkline
  let hudPsTimer = null; // /api/ps poll while the HUD is open

  // ---- Elements ----
  const el = {
    app: document.querySelector(".app"),
    transcript: document.getElementById("transcript"),
    emptyState: document.getElementById("emptyState"),
    input: document.getElementById("input"),
    cmdPalette: document.getElementById("cmdPalette"),
    attach: document.getElementById("attach"),
    fileInput: document.getElementById("fileInput"),
    attachStrip: document.getElementById("attachStrip"),
    micBtn: document.getElementById("micBtn"),
    voiceToggle: document.getElementById("voiceToggle"),
    send: document.getElementById("send"),
    stop: document.getElementById("stop"),
    newChat: document.getElementById("newChat"),
    quit: document.getElementById("quit"),
    settings: document.getElementById("settings"),
    settingsModal: document.getElementById("settingsModal"),
    portInput: document.getElementById("portInput"),
    themeSelect: document.getElementById("themeSelect"),
    fontSizeRange: document.getElementById("fontSizeRange"),
    fontSizeValue: document.getElementById("fontSizeValue"),
    settingsCancel: document.getElementById("settingsCancel"),
    settingsApply: document.getElementById("settingsApply"),
    gallery: document.getElementById("gallery"),
    galleryModal: document.getElementById("galleryModal"),
    galleryClose: document.getElementById("galleryClose"),
    galleryList: document.getElementById("galleryList"),
    galleryPreview: document.getElementById("galleryPreview"),
    newChatSidebar: document.getElementById("newChatSidebar"),
    sidebarToggle: document.getElementById("sidebarToggle"),
    convoList: document.getElementById("convoList"),
    convoEmpty: document.getElementById("convoEmpty"),
    convoSearch: document.getElementById("convoSearch"),
    exportChat: document.getElementById("exportChat"),
    tagline: document.getElementById("tagline"),
    anthropicKey: document.getElementById("anthropicKey"),
    openaiKey: document.getElementById("openaiKey"),
    anthropicStatus: document.getElementById("anthropicStatus"),
    openaiStatus: document.getElementById("openaiStatus"),
    brainToggle: document.getElementById("brainToggle"),
    brainPanel: document.getElementById("brainPanel"),
    brainClose: document.getElementById("brainClose"),
    bhStatus: document.getElementById("bhStatus"),
    bhModel: document.getElementById("bhModel"),
    bhNotes: document.getElementById("bhNotes"),
    bhReindex: document.getElementById("bhReindex"),
    brainSources: document.getElementById("brainSources"),
    brainRagMeta: document.getElementById("brainRagMeta"),
    brainGraph: document.getElementById("brainGraph"),
    brainGraphMeta: document.getElementById("brainGraphMeta"),
    brainGraphTip: document.getElementById("brainGraphTip"),
    notePreview: document.getElementById("notePreview"),
    noteTitle: document.getElementById("noteTitle"),
    noteBody: document.getElementById("noteBody"),
    noteClose: document.getElementById("noteClose"),
    arenaToggle: document.getElementById("arenaToggle"),
    arenaView: document.getElementById("arenaView"),
    arenaModels: document.getElementById("arenaModels"),
    arenaModelsToggle: document.getElementById("arenaModelsToggle"),
    arenaModelsCount: document.getElementById("arenaModelsCount"),
    albList: document.getElementById("albList"),
    arenaPrompt: document.getElementById("arenaPrompt"),
    arenaPromptText: document.getElementById("arenaPromptText"),
    arenaPromptCount: document.getElementById("arenaPromptCount"),
    arenaGrid: document.getElementById("arenaGrid"),
    arenaTabs: document.getElementById("arenaTabs"),
    arenaDocToggle: document.getElementById("arenaDocToggle"),
    docPanel: document.getElementById("docPanel"),
    docTitle: document.getElementById("docTitle"),
    docPen: document.getElementById("docPen"),
    docOpenRow: document.getElementById("docOpenRow"),
    docBrowseBtn: document.getElementById("docBrowseBtn"),
    docView: document.getElementById("docView"),
    docEdit: document.getElementById("docEdit"),
    docActions: document.getElementById("docActions"),
    docTakePen: document.getElementById("docTakePen"),
    docSave: document.getElementById("docSave"),
    docClose: document.getElementById("docClose"),
    hudToggle: document.getElementById("hudToggle"),
    hudPanel: document.getElementById("hudPanel"),
    hudClose: document.getElementById("hudClose"),
    hudTps: document.getElementById("hudTps"),
    hudSpark: document.getElementById("hudSpark"),
    hudCtxText: document.getElementById("hudCtxText"),
    hudCtxFill: document.getElementById("hudCtxFill"),
    hudGpuText: document.getElementById("hudGpuText"),
    hudLayers: document.getElementById("hudLayers"),
    hudModel: document.getElementById("hudModel"),
    modelPicker: document.getElementById("modelPicker"),
    modelMenuBtn: document.getElementById("modelMenuBtn"),
    modelMenuLabel: document.getElementById("modelMenuLabel"),
    modelMenu: document.getElementById("modelMenu"),
    statusDot: document.getElementById("statusDot"),
    statusLabel: document.getElementById("statusLabel"),
    tempSlider: document.getElementById("tempSlider"),
    tempValue: document.getElementById("tempValue"),
    capBadges: document.getElementById("capBadges"),
    tps: document.getElementById("tpsReadout"),
    ctxFill: document.getElementById("ctxFill"),
    ctxLabel: document.getElementById("ctxLabel"),
  };

  // Phase 6 slice 2 — project files panel + @file mentions.
  Object.assign(el, {
    filesToggle: document.getElementById("filesToggle"),
    filesPanel: document.getElementById("filesPanel"),
    filesClose: document.getElementById("filesClose"),
    filesChange: document.getElementById("filesChange"),
    filesTree: document.getElementById("filesTree"),
    filesRoot: document.getElementById("filesRoot"),
    filePalette: document.getElementById("filePalette"),
    agentWritesToggle: document.getElementById("agentWritesToggle"),
    agentWritesState: document.getElementById("agentWritesState"),
    filesChanges: document.getElementById("filesChanges"),
    changesRefresh: document.getElementById("changesRefresh"),
  });

  // Per-model capability cache (thinking + context window), filled once per model
  // from /api/capabilities so the UI auto-enables reasoning and sizes the context meter.
  const capCache = {}; // model -> {thinking, window}
  let ctxWindow = 0; // selected model's effective context window (tokens)
  let ctxUsed = 0;   // tokens used by the current conversation (from Ollama's counts)

  // ---- Conversation store (localStorage, no backend) ----
  // Each conversation: {id, title, model, messages:[{role,content}], updatedAt}.
  function loadConvos() {
    try {
      const raw = localStorage.getItem(LS_CONVOS_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }

  function saveConvos(list) {
    try {
      localStorage.setItem(LS_CONVOS_KEY, JSON.stringify(list));
    } catch (_) {
      /* storage full or unavailable — stay silent, app still works in-memory */
    }
  }

  function newId() {
    return "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function deriveTitle(msgs) {
    const first = msgs.find((m) => m.role === "user");
    if (!first) return "New chat";
    const text = first.content.trim().replace(/\s+/g, " ");
    if (!text) return "New chat";
    return text.length > TITLE_MAX ? text.slice(0, TITLE_MAX).trimEnd() + "…" : text;
  }

  function relativeTime(ts) {
    const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (secs < 45) return "just now";
    const mins = Math.round(secs / 60);
    if (mins < 60) return mins + "m ago";
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + "h ago";
    const days = Math.round(hrs / 24);
    if (days < 7) return days + "d ago";
    return new Date(ts).toLocaleDateString();
  }

  // Persist the current transcript into the store. Skips empty conversations so
  // a fresh "New chat" never clutters the sidebar until it has real content.
  function persistCurrent() {
    if (messages.length === 0) return;
    const list = loadConvos();
    const existing = activeId ? list.find((c) => c.id === activeId) : null;
    const convo = {
      id: activeId || newId(),
      title: deriveTitle(messages),
      model: el.modelPicker.value || "",
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      ctxUsed: ctxUsed,
      // Carry lineage forward so a branch keeps its parent link as it grows.
      parentId: existing ? existing.parentId || null : null,
      parentTitle: existing ? existing.parentTitle || null : null,
      branchedFromIdx: existing && existing.branchedFromIdx != null ? existing.branchedFromIdx : null,
      updatedAt: Date.now(),
    };
    activeId = convo.id;
    const idx = list.findIndex((c) => c.id === convo.id);
    if (idx >= 0) list[idx] = convo;
    else list.push(convo);
    saveConvos(list);
    renderSidebar();
  }

  // ---- Connection status ----
  async function refreshHealth() {
    try {
      const res = await fetch("/api/health");
      const data = await res.json();
      setStatus(data.ok);
    } catch (_) {
      setStatus(false);
    }
  }

  function setStatus(up) {
    el.statusDot.classList.toggle("up", up);
    el.statusDot.classList.toggle("down", !up);
    el.statusLabel.textContent = up ? "connected" : "offline";
  }

  // ---- Models ----
  function setPickerMessage(text) {
    el.modelPicker.replaceChildren();
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = text;
    el.modelPicker.appendChild(opt);
  }

  function chooseInitialModel(models, saved) {
    const installed = new Set(models.map((m) => m.name));
    if (saved && installed.has(saved)) {
      return REPLACED_LOCAL_MODELS.has(saved) && installed.has(PREFERRED_LOCAL_MODEL)
        ? PREFERRED_LOCAL_MODEL
        : saved;
    }
    if (saved && saved in cloudModels) return saved;
    return installed.has(PREFERRED_LOCAL_MODEL) ? PREFERRED_LOCAL_MODEL : (models[0]?.name || "");
  }

  async function loadModels() {
    try {
      const res = await fetch("/api/models");
      const data = await res.json();
      if (data.error) {
        setPickerMessage(data.error);
        setStatus(false);
        return;
      }
      const models = data.models || [];
      modelList = models;
      if (arenaMode) renderArenaModelChips();
      if (models.length === 0) {
        setPickerMessage("no models — run: ollama pull llama3.2");
        return;
      }
      el.modelPicker.replaceChildren();
      for (const m of models) {
        const opt = document.createElement("option");
        opt.value = m.name;
        opt.textContent = `${m.name} · ${m.size}`;
        el.modelPicker.appendChild(opt);
      }
      appendCloudOptions(); // add the ☁ Cloud group (if any providers connected)

      const saved = localStorage.getItem(LS_MODEL_KEY);
      const selected = chooseInitialModel(models, saved);
      if (selected) {
        el.modelPicker.value = selected;
        if (selected !== saved) localStorage.setItem(LS_MODEL_KEY, selected);
      }
      refreshCapBadges(); // show the selected model's capability chips
      refreshContextWindow(); // size the context meter to the selected model
      updateTagline(); // honest offline/cloud badge for the current model
      updateModelMenuBtn(); // reflect the selection in the custom dropdown trigger
    } catch (_) {
      setPickerMessage("could not reach server");
    }
  }

  // Append (or refresh) the "☁ Cloud" optgroup in the model picker from the
  // currently-connected providers. Local models are never touched.
  function appendCloudOptions() {
    const prior = el.modelPicker.querySelector("optgroup.cloud-group");
    if (prior) prior.remove();
    const realIds = Object.keys(cloudModels);
    const flagIds = Object.keys(flagshipModels);
    if (!realIds.length && !flagIds.length) return;
    const group = document.createElement("optgroup");
    group.className = "cloud-group";
    group.label = "☁ Cloud";
    for (const id of realIds) {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = "☁ " + id;
      group.appendChild(opt);
    }
    // Flagship placeholders (only for providers not yet connected).
    for (const f of FLAGSHIPS) {
      if (connectedProviders.has(f.provider)) continue;
      const opt = document.createElement("option");
      opt.value = f.id;
      opt.textContent = "☁ " + f.label + " — connect key";
      group.appendChild(opt);
    }
    el.modelPicker.appendChild(group);
  }

  // ---- Custom model dropdown: favorites section + per-model stars, layered over the
  // hidden native <select> (which a star can't live inside). The select stays the
  // value source-of-truth, so every existing `.value`/change consumer keeps working. ----
  function selectModel(id) {
    if (!id) return;
    el.modelPicker.value = id;
    el.modelPicker.dispatchEvent(new Event("change")); // reuse all existing change wiring
    closeModelMenu();
  }
  function updateModelMenuBtn() {
    if (!el.modelMenuLabel) return;
    const o = el.modelPicker.selectedOptions[0];
    el.modelMenuLabel.textContent = (o && o.textContent) || "Select a model";
  }
  function renderModelMenu() {
    if (!el.modelMenu) return;
    el.modelMenu.replaceChildren();
    const opts = [...el.modelPicker.options].filter((o) => o.value);
    if (!opts.length) {
      const e = document.createElement("div");
      e.className = "model-menu-empty";
      e.textContent = "no models";
      el.modelMenu.appendChild(e);
      return;
    }
    const current = el.modelPicker.value;
    const label = (t) => {
      const s = document.createElement("div");
      s.className = "model-menu-label";
      s.textContent = t;
      el.modelMenu.appendChild(s);
    };
    const makeRow = (o) => {
      const row = document.createElement("div");
      row.className = "model-menu-row" + (o.value === current ? " current" : "");
      row.setAttribute("role", "option");
      const name = document.createElement("span");
      name.className = "mm-name";
      name.textContent = o.textContent;
      const star = document.createElement("span");
      star.className = "mm-star" + (isFavorite(o.value) ? " on" : "");
      star.textContent = isFavorite(o.value) ? "★" : "☆";
      star.title = isFavorite(o.value) ? "Unfavorite" : "Favorite";
      star.addEventListener("click", (e) => { e.stopPropagation(); toggleFavorite(o.value); });
      row.append(name, star);
      row.addEventListener("click", () => selectModel(o.value));
      return row;
    };
    const isCloud = (o) => o.parentElement && o.parentElement.classList && o.parentElement.classList.contains("cloud-group");
    const favs = opts.filter((o) => isFavorite(o.value));
    if (favs.length) { label("★ Favorites"); favs.forEach((o) => el.modelMenu.appendChild(makeRow(o))); }
    const locals = opts.filter((o) => !isCloud(o));
    const clouds = opts.filter((o) => isCloud(o));
    if (locals.length) { label("💻 Local"); locals.forEach((o) => el.modelMenu.appendChild(makeRow(o))); }
    if (clouds.length) { label("☁ Cloud"); clouds.forEach((o) => el.modelMenu.appendChild(makeRow(o))); }
  }
  function openModelMenu() {
    renderModelMenu();
    el.modelMenu.classList.remove("hidden");
    if (el.modelMenuBtn) el.modelMenuBtn.setAttribute("aria-expanded", "true");
  }
  function closeModelMenu() {
    if (el.modelMenu) el.modelMenu.classList.add("hidden");
    if (el.modelMenuBtn) el.modelMenuBtn.setAttribute("aria-expanded", "false");
  }
  function toggleModelMenu() {
    if (!el.modelMenu) return;
    el.modelMenu.classList.contains("hidden") ? openModelMenu() : closeModelMenu();
  }

  // Keep the topbar tagline honest: local = "offline · private · $0";
  // a cloud model = "cloud · <provider> · billed".
  function updateTagline() {
    if (!el.tagline) return;
    const provider = providerOf(el.modelPicker.value);
    if (provider) {
      el.tagline.textContent = "cloud · " + provider + " · billed";
      el.tagline.classList.add("cloud");
    } else {
      el.tagline.textContent = "offline · private · $0";
      el.tagline.classList.remove("cloud");
    }
  }

  // ---- Cloud providers (Settings → Cloud models) ----
  async function loadProviders() {
    let data;
    try {
      const res = await fetch("/api/providers");
      data = await res.json();
    } catch (_) {
      return; // backend without the route (stale worker) — just stay local
    }
    cloudModels = {};
    connectedProviders = new Set();
    for (const [provider, info] of Object.entries(data || {})) {
      const statusEl = document.getElementById(provider + "Status");
      const btn = document.querySelector('.cloud-connect-btn[data-provider="' + provider + '"]');
      if (info && info.connected) {
        connectedProviders.add(provider);
        if (statusEl) {
          statusEl.textContent = "connected · " + (info.models || []).length + " models";
          statusEl.className = "cloud-status connected";
        }
        if (btn) btn.textContent = "Disconnect";
        for (const m of info.models || []) cloudModels[m] = provider;
      } else {
        if (statusEl) {
          statusEl.textContent = "not connected";
          statusEl.className = "cloud-status";
        }
        if (btn) btn.textContent = "Connect";
      }
    }
    // Flagship placeholders for any provider that isn't connected yet.
    flagshipModels = {};
    for (const f of FLAGSHIPS) if (!connectedProviders.has(f.provider)) flagshipModels[f.id] = f.provider;
    appendCloudOptions();
    if (arenaMode) renderArenaModelChips();
    updateTagline();
    updateModelMenuBtn();
  }

  async function connectProvider(provider) {
    const input = document.getElementById(provider + "Key");
    const statusEl = document.getElementById(provider + "Status");
    const btn = document.querySelector('.cloud-connect-btn[data-provider="' + provider + '"]');
    if (btn && btn.textContent === "Disconnect") return disconnectProvider(provider);
    const key = ((input && input.value) || "").trim();
    if (!key) {
      if (statusEl) { statusEl.textContent = "enter a key first"; statusEl.className = "cloud-status error"; }
      return;
    }
    if (statusEl) { statusEl.textContent = "connecting…"; statusEl.className = "cloud-status"; }
    try {
      const res = await fetch("/api/providers/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, key }),
      });
      const data = await res.json();
      if (data.ok) {
        if (input) input.value = ""; // never keep the key sitting in the field
        await loadProviders();
        toast(provider + " connected · " + (data.models || []).length + " models");
      } else if (statusEl) {
        statusEl.textContent = data.error || "failed";
        statusEl.className = "cloud-status error";
      }
    } catch (e) {
      if (statusEl) { statusEl.textContent = "failed: " + e.message; statusEl.className = "cloud-status error"; }
    }
  }

  async function disconnectProvider(provider) {
    try {
      await fetch("/api/providers/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider }),
      });
    } catch (_) {
      /* ignore */
    }
    await loadProviders();
    toast(provider + " disconnected");
  }

  el.modelPicker.addEventListener("change", () => {
    localStorage.setItem(LS_MODEL_KEY, el.modelPicker.value);
    refreshCapBadges();
    refreshContextWindow();
    updateTagline();
    updateModelMenuBtn();
  });
  if (el.modelMenuBtn) el.modelMenuBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleModelMenu(); });
  // Click anywhere outside the picker closes the menu.
  document.addEventListener("click", (e) => {
    if (el.modelMenu && !el.modelMenu.classList.contains("hidden") && !e.target.closest(".model-wrap")) closeModelMenu();
  });

  // Wire the Settings → Cloud models connect/disconnect buttons.
  document.querySelectorAll(".cloud-connect-btn").forEach((b) =>
    b.addEventListener("click", () => connectProvider(b.dataset.provider))
  );

  // ---- Per-model capabilities (full list + context window), cached ----
  async function fetchCaps(model) {
    if (!model) return { thinking: false, window: 0, vision: false, caps: [] };
    if (model in capCache) return capCache[model];
    try {
      const res = await fetch("/api/capabilities?model=" + encodeURIComponent(model));
      const d = await res.json();
      capCache[model] = {
        thinking: !!d.thinking,
        window: d.num_ctx || 0,
        vision: !!d.vision,
        caps: d.capabilities || [],
      };
    } catch (_) {
      capCache[model] = { thinking: false, window: 0, vision: false, caps: [] };
    }
    return capCache[model];
  }

  async function modelSupportsThinking(model) {
    return (await fetchCaps(model)).thinking;
  }

  // Capability badges shown above the composer for the selected model.
  const CAP_LABELS = [
    ["thinking", "💭 Reasoning"],
    ["vision", "👁 Vision"],
    ["audio", "🎧 Audio"],
    ["tools", "🔧 Tools"],
  ];

  async function refreshCapBadges() {
    const model = el.modelPicker.value;
    const c = await fetchCaps(model);
    if (el.modelPicker.value !== model) return; // selection changed mid-await
    el.capBadges.replaceChildren();
    for (const [key, label] of CAP_LABELS) {
      if (c.caps.includes(key)) {
        const badge = document.createElement("span");
        badge.className = "cap-badge";
        badge.textContent = label;
        el.capBadges.appendChild(badge);
      }
    }
  }

  // ---- Context-usage meter ----
  function fmtTokens(n) {
    return n >= 1000
      ? (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, "") + "k"
      : String(n);
  }

  function updateCtxMeter() {
    if (!ctxWindow) {
      el.ctxFill.style.width = "0%";
      el.ctxLabel.textContent = "";
      return;
    }
    const pct = Math.min(100, Math.round((ctxUsed / ctxWindow) * 100));
    el.ctxFill.style.width = pct + "%";
    el.ctxFill.className = "ctx-fill" + (pct >= 90 ? " danger" : pct >= 70 ? " warn" : "");
    el.ctxLabel.textContent = fmtTokens(ctxUsed) + " / " + fmtTokens(ctxWindow);
  }

  // Set the context window for the selected model, then redraw the meter.
  async function refreshContextWindow() {
    const model = el.modelPicker.value;
    const caps = await fetchCaps(model);
    if (el.modelPicker.value !== model) return;
    ctxWindow = caps.window || 0;
    updateCtxMeter();
  }

  // ---- Temperature slider ----
  el.tempSlider.addEventListener("input", () => {
    el.tempValue.textContent = parseFloat(el.tempSlider.value).toFixed(1);
  });

  // ---- Textarea auto-grow + key handling ----
  function autogrow() {
    el.input.style.height = "auto";
    el.input.style.height = Math.min(el.input.scrollHeight, 200) + "px";
  }

  // ---- Slash commands: qwen3-powered shortcuts (NOT the Claude vault skills) ----
  // "{}" marks where the cursor lands so you can type the argument.
  const COMMANDS = [
    { cmd: "/recall", desc: "Answer from your second brain", template: "Search my second brain and answer using my notes: {}" },
    { cmd: "/networth", desc: "Net worth + trend (Monarch)", template: "What's my current net worth? Break it down by account type and chart the trend." },
    { cmd: "/spending", desc: "Spending by category (Monarch)", template: "Summarize my recent spending by category, and chart the top categories." },
    { cmd: "/budget", desc: "Budget status (Monarch)", template: "How am I doing against my budget right now?" },
    { cmd: "/accounts", desc: "Accounts + balances (Monarch)", template: "List my financial accounts with their balances." },
    { cmd: "/transactions", desc: "Recent transactions (Monarch)", template: "Show my most recent transactions." },
    { cmd: "/email", desc: "Search your email (read-only)", template: "Search my email for: {} and summarize what you find." },
    { cmd: "/diagram", desc: "Make a Mermaid diagram", template: "Create a Mermaid diagram of: {}" },
    { cmd: "/chart", desc: "Make a chart", template: "Make a chart of: {}" },
    { cmd: "/file", desc: "Create or edit a file (workspace)", template: "Using the file tools, {}. Create or edit files inside the workspace folder unless I give an explicit absolute path." },
  ];
  let cmdMatches = [];
  let cmdActive = 0;
  let fileMatches = []; // @file autocomplete hits (rel paths)
  let fileActive = 0;

  function paletteOpen() {
    return !el.cmdPalette.classList.contains("hidden");
  }

  function hidePalette() {
    el.cmdPalette.classList.add("hidden");
    el.cmdPalette.replaceChildren();
    cmdMatches = [];
  }

  function renderPalette() {
    el.cmdPalette.replaceChildren();
    cmdMatches.forEach((c, i) => {
      const item = document.createElement("div");
      item.className = "cmd-item" + (i === cmdActive ? " active" : "");
      item.dataset.idx = i;
      const name = document.createElement("span");
      name.className = "cmd-name";
      name.textContent = c.cmd;
      const desc = document.createElement("span");
      desc.className = "cmd-desc";
      desc.textContent = c.desc;
      item.append(name, desc);
      el.cmdPalette.appendChild(item);
    });
  }

  function updatePalette() {
    const m = el.input.value.match(/^\/(\S*)$/); // a leading "/word" with no space yet
    if (!m) return hidePalette();
    const q = m[1].toLowerCase();
    cmdMatches = COMMANDS.filter((c) => c.cmd.slice(1).startsWith(q));
    if (!cmdMatches.length) return hidePalette();
    cmdActive = 0;
    renderPalette();
    el.cmdPalette.classList.remove("hidden");
  }

  function applyCommand(c) {
    hidePalette();
    const i = c.template.indexOf("{}");
    el.input.value = i >= 0 ? c.template.replace("{}", "") : c.template;
    el.input.focus();
    const caret = i >= 0 ? i : el.input.value.length;
    el.input.setSelectionRange(caret, caret);
    autogrow();
  }

  // mousedown (not click) so it fires before the textarea loses focus
  el.cmdPalette.addEventListener("mousedown", (e) => {
    const item = e.target.closest(".cmd-item");
    if (!item) return;
    e.preventDefault();
    applyCommand(cmdMatches[parseInt(item.dataset.idx, 10)]);
  });

  el.input.addEventListener("input", () => {
    autogrow();
    updatePalette();
  });

  el.input.addEventListener("keydown", (e) => {
    if (filePaletteOpen()) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        fileActive = (fileActive + 1) % fileMatches.length;
        renderFilePalette();
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        fileActive = (fileActive - 1 + fileMatches.length) % fileMatches.length;
        renderFilePalette();
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        applyFile(fileMatches[fileActive]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        hideFilePalette();
        return;
      }
    }
    if (paletteOpen()) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        cmdActive = (cmdActive + 1) % cmdMatches.length;
        renderPalette();
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        cmdActive = (cmdActive - 1 + cmdMatches.length) % cmdMatches.length;
        renderPalette();
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        applyCommand(cmdMatches[cmdActive]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        hidePalette();
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!streaming) sendMessage();
    }
  });

  // ---- Sidebar rendering ----
  function renderSidebar() {
    const all = loadConvos().sort((a, b) => b.updatedAt - a.updatedAt);
    const list = convoQuery
      ? all.filter((c) => (c.title || "").toLowerCase().includes(convoQuery))
      : all;
    el.convoList.replaceChildren();
    el.convoEmpty.classList.toggle("hidden", all.length > 0);

    for (const convo of list) {
      const row = document.createElement("div");
      row.className = "convo-row" + (convo.id === activeId ? " active" : "");
      row.dataset.id = convo.id;

      const main = document.createElement("div");
      main.className = "convo-main";
      const title = document.createElement("div");
      title.className = "convo-title";
      title.textContent = (convo.parentId ? "⑂ " : "") + convo.title;
      const time = document.createElement("div");
      time.className = "convo-time";
      time.textContent = relativeTime(convo.updatedAt);
      main.append(title, time);
      if (convo.parentId) {
        const lineage = document.createElement("div");
        lineage.className = "convo-time";
        lineage.textContent = "from: " + (convo.parentTitle || "a conversation");
        lineage.title = "Branched from “" + (convo.parentTitle || "a conversation") + "”";
        main.append(lineage);
      }

      const del = document.createElement("button");
      del.className = "convo-del";
      del.type = "button";
      del.title = "Delete conversation";
      del.textContent = "×";
      del.dataset.id = convo.id;

      row.append(main, del);
      el.convoList.appendChild(row);
    }
  }

  // Load a saved conversation into the transcript and mark it active.
  function openConvo(id) {
    const convo = loadConvos().find((c) => c.id === id);
    if (!convo) return;
    if (streaming && controller) controller.abort();

    activeId = convo.id;
    messages = convo.messages.map((m) => ({ role: m.role, content: m.content }));
    el.tps.textContent = "";

    if (convo.model && [...el.modelPicker.options].some((o) => o.value === convo.model)) {
      el.modelPicker.value = convo.model;
      updateModelMenuBtn();
    }
    ctxUsed = convo.ctxUsed || 0;
    refreshContextWindow(); // size to this convo's model, then redraw the meter

    renderTranscript(); // rebuilds bubbles + re-renders diagrams in a reopened convo
    renderSidebar();
  }

  function deleteConvo(id) {
    const list = loadConvos().filter((c) => c.id !== id);
    saveConvos(list);
    if (id === activeId) startNewChat();
    else renderSidebar();
  }

  // Reset to a fresh, empty conversation without touching saved ones.
  function startNewChat() {
    if (streaming && controller) controller.abort();
    messages = [];
    activeId = null;
    el.tps.textContent = "";
    ctxUsed = 0;
    updateCtxMeter();
    el.transcript.replaceChildren();
    showEmptyState();
    renderSidebar();
    el.input.focus();
  }

  // ---- Rendering ----
  function hideEmptyState() {
    if (el.emptyState) {
      el.emptyState.remove();
      el.emptyState = null;
    }
  }

  // Rebuild the empty state with DOM nodes (no innerHTML).
  function showEmptyState() {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.id = "emptyState";

    const mark = document.createElement("div");
    mark.className = "empty-mark";
    mark.textContent = "◇";

    const h2 = document.createElement("h2");
    h2.textContent = "A private mind, on your machine.";

    const p = document.createElement("p");
    p.textContent =
      "Every token here is generated locally by Ollama. Nothing leaves this computer. Pick a model and begin.";

    empty.append(mark, h2, p);
    el.transcript.appendChild(empty);
    el.emptyState = empty;
  }

  function addBubble(role) {
    const wrap = document.createElement("div");
    wrap.className = "msg " + role;
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    const roleTag = document.createElement("span");
    roleTag.className = "role";
    roleTag.textContent = role === "user" ? "You" : "Assistant";
    const body = document.createElement("div");
    body.className = "body";
    bubble.appendChild(roleTag);
    bubble.appendChild(body);
    bubble.appendChild(makeMsgActions(role));
    wrap.appendChild(bubble);
    el.transcript.appendChild(wrap);
    scrollToBottom();
    return body;
  }

  // Per-message hover toolbar. Buttons vary by role; clicks are handled by the
  // delegated transcript listener, which resolves the message index by position.
  function makeMsgActions(role) {
    const bar = document.createElement("div");
    bar.className = "msg-actions";
    const defs =
      role === "user"
        ? [
            ["copy", "Copy", "⧉"],
            ["edit", "Edit & resend", "✎"],
            ["branch", "Branch from here", "⑂"],
            ["del", "Delete", "🗑"],
          ]
        : [
            ["copy", "Copy", "⧉"],
            ["regen", "Regenerate", "↻"],
            ["branch", "Branch from here", "⑂"],
            ["del", "Delete", "🗑"],
          ];
    for (const [act, label, glyph] of defs) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "msg-action";
      b.dataset.act = act;
      b.title = label;
      b.setAttribute("aria-label", label);
      b.textContent = glyph;
      bar.appendChild(b);
    }
    return bar;
  }

  // Rebuild the whole transcript from `messages` — used after edit/delete/regen.
  function renderTranscript() {
    el.transcript.replaceChildren();
    el.emptyState = null;
    if (!messages.length) {
      showEmptyState();
      return;
    }
    for (const m of messages) {
      const body = addBubble(m.role);
      if (m.role === "assistant") {
        renderInto(body, m.content);
        renderArtifacts(body);
        highlightCodeBlocks(body);
      } else {
        body.textContent = m.content;
      }
    }
    scrollToBottom();
  }

  // Index of a .msg wrapper within the transcript == its index in `messages`,
  // since bubbles are appended 1:1 in order.
  function msgIndexOf(wrap) {
    return [...el.transcript.querySelectorAll(".msg")].indexOf(wrap);
  }

  function copyMessage(idx) {
    const m = messages[idx];
    if (!m) return;
    navigator.clipboard.writeText(String(m.content || "")).then(() => toast("Copied to clipboard."));
  }

  // Remove a message (and persist). If that empties the conversation, drop it
  // from the store and reset to a fresh chat.
  function deleteMessage(idx) {
    if (streaming || idx < 0 || idx >= messages.length) return;
    messages.splice(idx, 1);
    if (!messages.length) {
      if (activeId) {
        saveConvos(loadConvos().filter((c) => c.id !== activeId));
        activeId = null;
      }
      startNewChat();
      return;
    }
    renderTranscript();
    persistCurrent();
  }

  // Pull a user message back into the composer and truncate the conversation
  // from that point, so editing + Send re-runs the turn cleanly.
  function editAndResend(idx) {
    if (streaming) return;
    const m = messages[idx];
    if (!m || m.role !== "user") return;
    el.input.value = String(m.content || "");
    messages = messages.slice(0, idx);
    renderTranscript();
    persistCurrent();
    autogrow();
    el.input.focus();
  }

  // Re-run generation for an assistant reply: drop it (and anything after) so the
  // conversation ends on the preceding user turn, then stream a fresh answer.
  function regenerate(idx) {
    if (streaming) return;
    const model = el.modelPicker.value;
    if (!model) {
      alert("Pick a model first.");
      return;
    }
    messages = messages.slice(0, idx); // ends at the user turn that prompted this
    if (!messages.length || messages[messages.length - 1].role !== "user") {
      toast("Nothing to regenerate from.");
      renderTranscript();
      return;
    }
    renderTranscript();
    persistCurrent();
    runAssistantTurn(model, {});
  }

  // Conversation Canvas primitive: fork a NEW conversation from message `idx`,
  // copying history up to and including it. The original is saved untouched; we
  // switch to the branch so the next turn explores an alternative path. Lineage
  // (parentId + the fork point) is recorded so the sidebar can show the tree.
  function branchFrom(idx) {
    if (streaming) {
      toast("Finish the current response before branching.");
      return;
    }
    if (idx < 0 || idx >= messages.length) return;
    persistCurrent(); // ensure the source conversation is saved in full first
    const parentId = activeId || null;
    const parent = parentId ? loadConvos().find((c) => c.id === parentId) : null;
    const snapshot = messages.slice(0, idx + 1).map((m) => ({ role: m.role, content: m.content }));
    const branch = {
      id: newId(),
      title: deriveTitle(snapshot),
      model: el.modelPicker.value || (parent && parent.model) || "",
      messages: snapshot,
      ctxUsed: 0, // recomputed as the branch takes its own turns
      parentId: parentId,
      parentTitle: parent ? parent.title : null,
      branchedFromIdx: idx,
      updatedAt: Date.now(),
    };
    const list = loadConvos();
    list.push(branch);
    saveConvos(list);

    activeId = branch.id;
    messages = snapshot.map((m) => ({ role: m.role, content: m.content }));
    ctxUsed = 0;
    refreshContextWindow(); // size the meter to this branch's model
    renderTranscript();
    renderSidebar();
    toast("Branched — the original is saved in the sidebar.");
    el.input.focus();
  }

  function scrollToBottom() {
    el.transcript.scrollTop = el.transcript.scrollHeight;
  }

  // renderMarkdown escapes all HTML before re-introducing a fixed safe tag set,
  // so the produced string is safe to assign as markup.
  function renderInto(node, text) {
    node.innerHTML = window.renderMarkdown(text); // eslint-disable-line no-unsanitized/property
  }

  // Apply offline syntax highlighting to any finished code blocks under `root`.
  // Runs once per block (guarded by data-hl) and only on completed messages, so
  // it never re-tokenizes mid-stream.
  function highlightCodeBlocks(root) {
    if (!root || !window.highlightCode) return;
    for (const codeEl of root.querySelectorAll(".code-block code")) {
      if (codeEl.dataset.hl) continue;
      const m = codeEl.className.match(/lang-([\w+#-]+)/);
      window.highlightCode(codeEl, m ? m[1] : "");
      codeEl.dataset.hl = "1";
    }
  }

  // Build a collapsible "reasoning" panel and insert it above the answer body.
  // Created lazily, only when a model actually streams message.thinking. Thinking
  // is rendered as plain text (textContent) — safe, and it's usually plain prose.
  function makeThinkBlock(beforeBody) {
    const block = document.createElement("div");
    block.className = "think-block";
    const head = document.createElement("button");
    head.type = "button";
    head.className = "think-head";
    head.textContent = "Thinking…";
    const content = document.createElement("div");
    content.className = "think-content";
    block.append(head, content);
    beforeBody.parentElement.insertBefore(block, beforeBody);
    return { block, head, content };
  }

  // Delegated copy-button handler for code blocks (works for streamed content),
  // plus expand/collapse for the reasoning panel.
  el.transcript.addEventListener("click", (e) => {
    const head = e.target.closest(".think-head");
    if (head) {
      head.parentElement.classList.toggle("collapsed");
      return;
    }
    const action = e.target.closest(".msg-action");
    if (action) {
      const wrap = action.closest(".msg");
      const idx = msgIndexOf(wrap);
      if (idx < 0) return;
      const act = action.dataset.act;
      if (act === "copy") copyMessage(idx);
      else if (act === "del") deleteMessage(idx);
      else if (act === "edit") editAndResend(idx);
      else if (act === "regen") regenerate(idx);
      else if (act === "branch") branchFrom(idx);
      return;
    }
    const btn = e.target.closest(".copy-btn");
    if (!btn) return;
    const code = btn.parentElement.querySelector("code");
    if (!code) return;
    navigator.clipboard.writeText(code.textContent).then(() => {
      btn.textContent = "Copied";
      btn.classList.add("copied");
      setTimeout(() => {
        btn.textContent = "Copy";
        btn.classList.remove("copied");
      }, 1400);
    });
  });

  // ---- Artifacts: render diagrams the model writes (mermaid / svg / html) ----
  // 'default' theme (dark-on-light) sits on a white card so it's readable in-app
  // AND when printed/downloaded; strict security sanitizes diagram content.
  if (window.mermaid) {
    window.mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "default" });
  }

  // Build a rendered view for one artifact. Returns {el, payload, mime, ext}.
  async function buildArtifactView(type, source) {
    const view = document.createElement("div");
    view.className = "artifact-view";
    if (type === "mermaid") {
      try {
        const id = "mmd-" + Math.random().toString(36).slice(2, 9);
        const out = await window.mermaid.render(id, source);
        view.innerHTML = out.svg; // securityLevel:strict sanitizes the SVG
        return { el: view, payload: out.svg, mime: "image/svg+xml", ext: "svg" };
      } catch (err) {
        view.classList.add("artifact-error");
        view.textContent = "Diagram error: " + (err && err.message ? err.message : String(err));
        return { el: view, payload: source, mime: "text/plain", ext: "txt", error: true };
      }
    }
    if (type === "chart") {
      // A Chart.js config as JSON (parsed, never eval'd). Render on a canvas in a
      // sized wrapper; download grabs the canvas as a PNG.
      let config;
      try {
        config = JSON.parse(source);
      } catch (err) {
        view.classList.add("artifact-error");
        view.textContent = "Chart config isn't valid JSON: " + err.message;
        return { el: view, payload: source, mime: "text/plain", ext: "txt", error: true };
      }
      config.options = Object.assign(
        { responsive: true, maintainAspectRatio: false },
        config.options || {}
      );
      const wrap = document.createElement("div");
      wrap.className = "chart-wrap";
      const canvas = document.createElement("canvas");
      wrap.appendChild(canvas);
      view.appendChild(wrap);
      // Render next frame, once the canvas is laid out in the DOM (and visible).
      requestAnimationFrame(() => {
        try {
          new window.Chart(canvas.getContext("2d"), config);
        } catch (err) {
          view.classList.add("artifact-error");
          view.textContent = "Chart error: " + err.message;
        }
      });
      const onDownload = () =>
        canvas.toBlob((b) => {
          if (b) downloadBlobObject(b, artifactFilename("chart", "png"));
        }, "image/png");
      return { el: view, payload: source, mime: "application/json", ext: "json", onDownload };
    }
    if (type === "embed") {
      // Show a resource: a URL or a local file path. Images/videos render inline;
      // anything else (webpage, PDF) goes in a frame. Local paths are served by /local.
      const src = source.trim().split("\n")[0].trim();
      // http(s) URLs and app-relative routes (/api/media/…, /local) load directly;
      // bare filesystem paths go through /local.
      const isPath = !/^https?:\/\//i.test(src) && !src.startsWith("/");
      const url = isPath ? "/local?path=" + encodeURIComponent(src) : src;
      const low = src.toLowerCase().split("?")[0];
      let node;
      if (/\.(png|jpe?g|gif|webp|bmp|avif|svg)$/.test(low)) {
        node = document.createElement("img");
        node.className = "embed-media";
        node.src = url;
        node.alt = src;
      } else if (/\.(mp4|webm|ogg|mov|m4v)$/.test(low)) {
        node = document.createElement("video");
        node.className = "embed-media";
        node.controls = true;
        node.src = url;
      } else if (/\.(mp3|wav|m4a|aac|oga|opus|flac)$/.test(low)) {
        node = document.createElement("audio");
        node.className = "embed-media";
        node.controls = true;
        node.src = url;
      } else {
        node = document.createElement("iframe");
        node.className = "artifact-frame";
        node.src = url;
        node.setAttribute("sandbox", "allow-scripts allow-same-origin allow-popups allow-forms");
      }
      view.appendChild(node);
      return { el: view, payload: src, mime: "text/plain", ext: "txt", noDownload: true };
    }
    // svg + html render inside a sandboxed iframe so untrusted markup is isolated
    // from the app (no same-origin; svg gets no scripts at all).
    const frame = document.createElement("iframe");
    frame.className = "artifact-frame";
    if (type === "svg") {
      frame.setAttribute("sandbox", "");
      frame.srcdoc =
        '<!doctype html><meta charset="utf-8">' +
        '<body style="margin:0;display:flex;justify-content:center;align-items:flex-start">' +
        source +
        "</body>";
      view.appendChild(frame);
      return { el: view, payload: source, mime: "image/svg+xml", ext: "svg" };
    }
    frame.setAttribute("sandbox", "allow-scripts"); // scripts run in a null origin
    frame.srcdoc = source;
    view.appendChild(frame);
    return { el: view, payload: source, mime: "text/html", ext: "html" };
  }

  function downloadBlobObject(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function downloadBlob(text, mime, filename) {
    downloadBlobObject(new Blob([text], { type: mime }), filename);
  }

  // Export the on-screen conversation as a Markdown transcript. Content is already
  // plain text in `messages`, so this is a pure local serialize — no network.
  function exportConversation() {
    if (!messages.length) {
      toast("Nothing to export yet.");
      return;
    }
    const title = deriveTitle(messages);
    const model = el.modelPicker.value || "unknown model";
    const when = new Date();
    const lines = [
      "# " + title,
      "",
      "- **Model:** " + model,
      "- **Exported:** " + when.toLocaleString(),
      "",
      "---",
      "",
    ];
    for (const m of messages) {
      const who = m.role === "user" ? "You" : m.role === "assistant" ? "Assistant" : m.role;
      lines.push("## " + who, "", String(m.content || "").trim(), "");
    }
    const stamp = when.toISOString().slice(0, 19).replace(/[:T]/g, "-");
    downloadBlob(lines.join("\n"), "text/markdown", "conversation-" + stamp + ".md");
  }

  function artifactFilename(type, ext) {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    return type + "-" + stamp + "." + ext;
  }

  // Print just this artifact via a @media print scope — no new window, no
  // document.write, and the iframe sandbox stays intact.
  function printArtifact(viewEl) {
    viewEl.classList.add("print-target");
    document.body.classList.add("printing");
    const cleanup = () => {
      viewEl.classList.remove("print-target");
      document.body.classList.remove("printing");
      window.removeEventListener("afterprint", cleanup);
    };
    window.addEventListener("afterprint", cleanup);
    window.print();
  }

  async function saveArtifactToDisk(type, source) {
    const title = prompt("Name this diagram:", type.toUpperCase() + " diagram");
    if (title === null) return;
    try {
      const res = await fetch("/api/artifacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, source, title }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || res.statusText);
      }
      toast("Saved to your diagrams");
    } catch (err) {
      alert("Save failed: " + err.message);
    }
  }

  // The Save / Print / Download / source-toggle bar under each artifact.
  function buildArtifactBar(opts) {
    const bar = document.createElement("div");
    bar.className = "artifact-bar";
    const label = document.createElement("span");
    label.className = "artifact-label";
    label.textContent = opts.type;
    const actions = document.createElement("div");
    actions.className = "artifact-actions";

    function addBtn(text, fn) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "artifact-btn";
      b.textContent = text;
      b.addEventListener("click", fn);
      actions.appendChild(b);
    }

    if (opts.allowSave) addBtn("Save", () => saveArtifactToDisk(opts.type, opts.source));
    if (!opts.error) {
      addBtn("Print", () => printArtifact(opts.viewEl));
      if (!opts.noDownload) {
        addBtn(
          "Download",
          opts.onDownload ||
            (() => downloadBlob(opts.payload, opts.mime, artifactFilename(opts.type, opts.ext)))
        );
      }
    }
    if (opts.srcEl) addBtn("</>", () => opts.srcEl.classList.toggle("artifact-src-hidden"));

    bar.append(label, actions);
    return bar;
  }

  // Turn every unrendered .artifact placeholder in `container` into a visual.
  async function renderArtifacts(container) {
    const blocks = container.querySelectorAll('.artifact[data-rendered="0"]');
    for (const block of blocks) {
      block.dataset.rendered = "1";
      const type = block.dataset.type;
      const srcEl = block.querySelector(".artifact-src");
      const source = srcEl ? srcEl.textContent : "";
      if (!source.trim()) continue;
      const built = await buildArtifactView(type, source);
      const bar = buildArtifactBar({
        type,
        source,
        viewEl: built.el,
        payload: built.payload,
        mime: built.mime,
        ext: built.ext,
        error: built.error,
        onDownload: built.onDownload,
        noDownload: built.noDownload,
        srcEl,
        allowSave: true,
      });
      block.insertBefore(built.el, srcEl);
      block.insertBefore(bar, built.el);
      if (srcEl) srcEl.classList.add("artifact-src-hidden");
    }
  }

  // Tiny transient toast.
  function toast(msg) {
    const t = document.createElement("div");
    t.className = "toast";
    t.textContent = msg;
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add("show"));
    setTimeout(() => {
      t.classList.remove("show");
      setTimeout(() => t.remove(), 300);
    }, 1800);
  }

  // Show which second-brain notes grounded an answer, above the assistant text.
  // Lives in the bubble (sibling of .body) so it survives .body's per-chunk rerender.
  function showGroundingChip(bodyEl, notes) {
    const bubble = bodyEl.parentElement;
    if (!bubble || bubble.querySelector(".grounding-chip")) return;
    const chip = document.createElement("div");
    chip.className = "grounding-chip";
    const titles = notes.slice(0, 4).map((n) => n.title).join(" · ");
    chip.textContent =
      "📚 Grounded in your notes: " + titles + (notes.length > 4 ? " …" : "");
    bubble.insertBefore(chip, bodyEl);
  }

  // Show read-only MCP tool calls (e.g. Monarch lookups) as they run, above the
  // answer. "call" adds a pending chip; "result" marks it done.
  function showToolChip(bodyEl, ev) {
    const bubble = bodyEl.parentElement;
    if (!bubble || !ev || !ev.name) return;
    let bar = bubble.querySelector(".tool-chips");
    if (!bar) {
      bar = document.createElement("div");
      bar.className = "tool-chips";
      bubble.insertBefore(bar, bodyEl);
    }
    if (ev.phase === "call") {
      const chip = document.createElement("span");
      chip.className = "tool-chip";
      chip.dataset.tool = ev.name;
      chip.textContent = "🔧 " + ev.name + "…";
      bar.appendChild(chip);
    } else if (ev.phase === "result") {
      const pending = bar.querySelectorAll('.tool-chip[data-tool="' + ev.name + '"]:not(.done)');
      const chip = pending[pending.length - 1];
      if (chip) {
        chip.classList.add("done");
        chip.textContent = "🔧 " + ev.name + " ✓";
      }
    }
  }

  // Render a Send/Cancel card for a model-drafted iMessage. Nothing is sent until
  // the user taps Send, which hits /api/imessage/send (the only send path). All
  // text is set via textContent — never innerHTML.
  function showSendConfirm(bodyEl, draft) {
    const bubble = bodyEl.parentElement;
    if (!bubble || !draft) return;
    const to = String(draft.to || "").trim();
    const text = String(draft.text || "").trim();

    const card = document.createElement("div");
    card.className = "send-card";

    const head = document.createElement("div");
    head.className = "send-card-head";
    head.textContent = "✉️ Send iMessage?";

    const toRow = document.createElement("div");
    toRow.className = "send-card-to";
    toRow.textContent = "To: " + (to || "(no recipient)");

    const msg = document.createElement("div");
    msg.className = "send-card-msg";
    msg.textContent = text || "(empty message)";

    const status = document.createElement("div");
    status.className = "send-card-status hidden";

    const actions = document.createElement("div");
    actions.className = "send-card-actions";
    const sendBtn = document.createElement("button");
    sendBtn.type = "button";
    sendBtn.className = "send-card-send";
    sendBtn.textContent = "Send";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "send-card-cancel";
    cancelBtn.textContent = "Cancel";
    actions.append(sendBtn, cancelBtn);

    const finish = (cls, label) => {
      status.classList.remove("hidden", "ok", "err");
      status.classList.add(cls);
      status.textContent = label;
      sendBtn.disabled = true;
      cancelBtn.disabled = true;
    };

    cancelBtn.addEventListener("click", () => finish("err", "Cancelled — nothing sent."));
    sendBtn.addEventListener("click", async () => {
      if (!to || !text) {
        finish("err", "Missing recipient or text.");
        return;
      }
      sendBtn.disabled = true;
      cancelBtn.disabled = true;
      status.classList.remove("hidden", "ok", "err");
      status.textContent = "Sending…";
      try {
        const res = await fetch("/api/imessage/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ to, text }),
        });
        const data = await res.json();
        if (res.ok && data.ok) finish("ok", "Sent ✓");
        else finish("err", "Failed: " + (data.result || data.error || "unknown error"));
      } catch (err) {
        finish("err", "Failed: " + err.message);
      }
    });

    card.append(head, toRow, msg, actions, status);
    bubble.insertBefore(card, bodyEl);
    scrollToBottom();
  }

  // Render generated media (image / audio / video) below the answer. Attaches to
  // the bubble (the answer node itself gets rewritten by renderInto on each chunk),
  // so it survives streaming. URL is either a /api/media/ path or a remote provider
  // URL; both load directly in the element.
  function renderMedia(answerEl, media) {
    const host = (answerEl && answerEl.parentElement) || answerEl;
    if (!host || !media || !media.url) return;
    const wrap = document.createElement("div");
    wrap.className = "gen-media";
    let node;
    if (media.kind === "image") {
      node = document.createElement("img");
      node.src = media.url;
      node.alt = media.alt || "generated image";
      node.loading = "lazy";
    } else if (media.kind === "audio") {
      node = document.createElement("audio");
      node.src = media.url;
      node.controls = true;
    } else if (media.kind === "video") {
      node = document.createElement("video");
      node.src = media.url;
      node.controls = true;
      node.playsInline = true;
    } else {
      return;
    }
    node.className = "gen-media-el";
    const actions = document.createElement("div");
    actions.className = "gen-media-actions";
    const dl = document.createElement("a");
    dl.href = media.url;
    dl.setAttribute("download", "");
    dl.className = "gen-media-dl";
    dl.textContent = "⬇ download";
    const save = document.createElement("button");
    save.type = "button";
    save.className = "gen-media-save";
    save.textContent = "★ save";
    save.addEventListener("click", () => saveMediaToGallery(media, save));
    actions.append(save, dl);
    wrap.append(node, actions);
    host.appendChild(wrap);
  }

  // Persist a generated image/audio/video into the gallery as an embed artifact.
  async function saveMediaToGallery(media, btn) {
    if (!media || !media.url) return;
    if (btn) { btn.disabled = true; btn.textContent = "saving…"; }
    try {
      const res = await fetch("/api/artifacts/media", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: media.url, kind: media.kind, title: media.alt || ("Generated " + media.kind) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) { toast((data && data.error) || "Save failed."); if (btn) { btn.disabled = false; btn.textContent = "★ save"; } return; }
      if (btn) { btn.textContent = "★ saved"; btn.classList.add("saved"); }
      toast("Saved to gallery.");
    } catch (err) {
      toast("Save error: " + err.message);
      if (btn) { btn.disabled = false; btn.textContent = "★ save"; }
    }
  }

  // ---- Second-Brain / RAG Explorer panel ----
  function openBrainPanel() {
    el.brainPanel.classList.remove("hidden");
    el.brainToggle.classList.add("brain-active");
    if (!graphRendered && graphData) renderKnowledgeGraph();
  }
  function closeBrainPanel() {
    el.brainPanel.classList.add("hidden");
    el.brainToggle.classList.remove("brain-active");
  }
  function toggleBrainPanel() {
    el.brainPanel.classList.contains("hidden") ? openBrainPanel() : closeBrainPanel();
  }

  // ---- Project files panel + @file mentions (Phase 6 slice 2) -------------
  // Attaching a project file reuses the existing "doc" attachment pipeline, so
  // its contents ride into the next request like any other attached document —
  // which means it works for EVERY model, local or cloud.
  let fsTreeLoaded = false;

  async function attachProjectFile(rel) {
    if (!rel) return;
    if (attachments.some((a) => a.kind === "doc" && a.name === rel)) {
      toast(rel + " is already attached.");
      return;
    }
    try {
      const res = await fetch("/api/fs/read?path=" + encodeURIComponent(rel));
      const d = await res.json();
      if (!res.ok || d.error) return toast(d.error || "Could not read file.");
      if (d.binary) return toast("Can't attach a binary file.");
      attachments.push({ kind: "doc", name: rel, text: d.content, truncated: d.truncated });
      renderAttachStrip();
      toast("Attached " + rel);
    } catch (_) {
      toast("Could not read " + rel);
    }
  }

  async function loadFileTree() {
    try {
      const [proj, tree] = await Promise.all([
        fetch("/api/project").then((r) => r.json()),
        fetch("/api/fs/tree").then((r) => r.json()),
      ]);
      if (el.filesRoot) el.filesRoot.textContent = proj.name || "project";
      renderFileTree(tree.entries || [], tree.truncated);
      fsTreeLoaded = true;
    } catch (_) {
      el.filesTree.textContent = "Could not load files.";
    }
  }

  function renderFileTree(entries, truncated) {
    el.filesTree.replaceChildren();
    for (const entry of entries) {
      const row = document.createElement("div");
      row.className = "file-row file-" + entry.type;
      const depth = entry.path.split("/").length - 1;
      row.style.paddingLeft = 8 + depth * 14 + "px";
      const base = entry.path.split("/").pop();
      row.textContent = (entry.type === "dir" ? "📁 " : "📄 ") + base;
      if (entry.type === "file") {
        row.title = "Attach " + entry.path;
        row.dataset.path = entry.path;
      }
      el.filesTree.appendChild(row);
    }
    if (truncated) {
      const more = document.createElement("div");
      more.className = "files-hint";
      more.textContent = "… list truncated (large project).";
      el.filesTree.appendChild(more);
    }
  }

  function openFilesPanel() {
    el.filesPanel.classList.remove("hidden");
    el.filesToggle.classList.add("brain-active");
    if (!fsTreeLoaded) loadFileTree();
    loadAgentState();
    loadChanges();
  }
  function closeFilesPanel() {
    el.filesPanel.classList.add("hidden");
    el.filesToggle.classList.remove("brain-active");
  }
  function toggleFilesPanel() {
    el.filesPanel.classList.contains("hidden") ? openFilesPanel() : closeFilesPanel();
  }

  el.filesToggle?.addEventListener("click", toggleFilesPanel);
  el.filesClose?.addEventListener("click", closeFilesPanel);
  el.filesTree?.addEventListener("click", (e) => {
    const row = e.target.closest(".file-row[data-path]");
    if (row) attachProjectFile(row.dataset.path);
  });
  el.filesChange?.addEventListener("click", async () => {
    const path = prompt("Project folder — absolute path inside your home:");
    if (!path) return;
    try {
      const res = await fetch("/api/project", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      const d = await res.json();
      if (!res.ok || d.error) return toast(d.error || "Could not set folder.");
      fsTreeLoaded = false;
      loadFileTree();
      toast("Project: " + d.name);
    } catch (_) {
      toast("Could not set folder.");
    }
  });

  // -- Agent edits toggle + change journal (CRUD, every change undoable) --
  async function loadAgentState() {
    try {
      const d = await fetch("/api/agent/writes").then((r) => r.json());
      el.agentWritesToggle.checked = !!d.enabled;
      el.agentWritesState.textContent = d.enabled ? "ON — model can edit files" : "off";
      el.agentWritesState.classList.toggle("on", !!d.enabled);
    } catch (_) {}
  }
  el.agentWritesToggle?.addEventListener("change", async () => {
    const enabled = el.agentWritesToggle.checked;
    try {
      const d = await fetch("/api/agent/writes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      }).then((r) => r.json());
      el.agentWritesState.textContent = d.enabled ? "ON — model can edit files" : "off";
      el.agentWritesState.classList.toggle("on", !!d.enabled);
      toast(d.enabled ? "Agent edits enabled — every change is undoable." : "Agent edits disabled.");
    } catch (_) {
      toast("Could not change the setting.");
    }
  });

  async function loadChanges() {
    try {
      const d = await fetch("/api/fs/changes").then((r) => r.json());
      renderChanges(d.changes || []);
    } catch (_) {}
  }
  function renderChanges(changes) {
    el.filesChanges.replaceChildren();
    if (!changes.length) {
      const empty = document.createElement("div");
      empty.className = "files-hint";
      empty.textContent = "No changes yet.";
      el.filesChanges.appendChild(empty);
      return;
    }
    const verbs = { create: "＋", update: "✎", mkdir: "📁＋", move: "→", delete: "🗑" };
    for (const c of changes) {
      const row = document.createElement("div");
      row.className = "change-row" + (c.undone ? " undone" : "");
      const label = document.createElement("span");
      label.className = "change-label";
      label.textContent = (verbs[c.op] || c.op) + " " + c.path + (c.to ? " → " + c.to : "");
      label.title = (c.ts || "") + " · " + c.op;
      row.appendChild(label);
      if (c.undone) {
        const tag = document.createElement("span");
        tag.className = "change-undone-tag";
        tag.textContent = "undone";
        row.appendChild(tag);
      } else {
        const btn = document.createElement("button");
        btn.className = "change-undo";
        btn.type = "button";
        btn.textContent = "Undo";
        btn.dataset.id = c.id;
        row.appendChild(btn);
      }
      el.filesChanges.appendChild(row);
    }
  }
  el.filesChanges?.addEventListener("click", async (e) => {
    const btn = e.target.closest(".change-undo[data-id]");
    if (!btn) return;
    try {
      const d = await fetch("/api/fs/undo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: btn.dataset.id }),
      }).then((r) => r.json());
      toast(d.message || "Undone.");
      loadChanges();
      fsTreeLoaded = false;
      loadFileTree();
    } catch (_) {
      toast("Undo failed.");
    }
  });
  el.changesRefresh?.addEventListener("click", loadChanges);

  // When the model runs a CRUD tool mid-stream, refresh the tree + journal so the
  // user watches changes land live.
  function onAgentToolEvent(name) {
    if (typeof name === "string" && name.indexOf("project_") === 0) {
      if (!el.filesPanel.classList.contains("hidden")) {
        fsTreeLoaded = false;
        loadFileTree();
        loadChanges();
      }
    }
  }
  window.__llsOnAgentToolEvent = onAgentToolEvent;

  // -- @file autocomplete: its own palette; the "/" command palette is untouched --
  function filePaletteOpen() {
    return el.filePalette && !el.filePalette.classList.contains("hidden");
  }
  function hideFilePalette() {
    if (el.filePalette) el.filePalette.classList.add("hidden");
    fileMatches = [];
  }
  function renderFilePalette() {
    el.filePalette.replaceChildren();
    fileMatches.forEach((rel, i) => {
      const item = document.createElement("div");
      item.className = "cmd-item" + (i === fileActive ? " active" : "");
      item.dataset.idx = String(i);
      const nm = document.createElement("span");
      nm.className = "cmd-name";
      nm.textContent = "@" + rel.split("/").pop();
      const ds = document.createElement("span");
      ds.className = "cmd-desc";
      ds.textContent = rel;
      item.append(nm, document.createTextNode(" "), ds);
      el.filePalette.appendChild(item);
    });
  }
  async function updateFilePalette() {
    const before = el.input.value.slice(0, el.input.selectionEnd);
    const m = before.match(/@([^\s@]*)$/);
    if (!m) return hideFilePalette();
    try {
      const res = await fetch("/api/fs/search?q=" + encodeURIComponent(m[1]));
      const d = await res.json();
      fileMatches = d.hits || [];
    } catch (_) {
      fileMatches = [];
    }
    if (!fileMatches.length) return hideFilePalette();
    fileActive = 0;
    renderFilePalette();
    el.filePalette.classList.remove("hidden");
  }
  function applyFile(rel) {
    hideFilePalette();
    el.input.value = el.input.value.replace(/@[^\s@]*$/, ""); // drop the typed @token
    autogrow();
    el.input.focus();
    attachProjectFile(rel);
  }
  el.filePalette?.addEventListener("mousedown", (e) => {
    const item = e.target.closest(".cmd-item");
    if (!item) return;
    e.preventDefault();
    applyFile(fileMatches[parseInt(item.dataset.idx, 10)]);
  });
  el.input.addEventListener("input", updateFilePalette);

  // Index health (embed model, note count, last reindex) — loaded at startup.
  async function loadSecondBrainHealth() {
    try {
      const res = await fetch("/api/secondbrain/health");
      const d = await res.json();
      el.bhStatus.textContent = d.available ? "online" : "offline";
      el.bhStatus.className = "bh-val " + (d.available ? "ok" : "off");
      el.bhModel.textContent = d.model || "—";
      el.bhNotes.textContent = d.available ? String(d.notes) : "—";
      el.bhReindex.textContent = d.reindexed ? relativeTime(new Date(d.reindexed).getTime()) : "—";
    } catch (_) {
      el.bhStatus.textContent = "offline";
      el.bhStatus.className = "bh-val off";
    }
  }

  // Render the source cards that grounded the latest answer (from the stream).
  function renderBrainSources() {
    if (!el.brainSources) return;
    el.brainRagMeta.textContent = latestRagMeta
      ? "k=" + latestRagMeta.k + " · reranked → " + latestRagMeta.returned
      : "";
    el.brainSources.replaceChildren();
    if (!latestGrounding.length) {
      const empty = document.createElement("div");
      empty.className = "brain-empty";
      empty.textContent = "Ask something — the notes that grounded the answer appear here.";
      el.brainSources.appendChild(empty);
      return;
    }
    for (const s of latestGrounding) {
      const card = document.createElement("div");
      card.className = "brain-source";
      const top = document.createElement("div");
      top.className = "brain-source-top";
      const title = document.createElement("span");
      title.className = "brain-source-title";
      title.textContent = s.title || s.stem || "note";
      const score = document.createElement("span");
      score.className = "brain-source-score";
      score.textContent = s.score != null ? Number(s.score).toFixed(2) : "";
      top.append(title, score);
      const snip = document.createElement("div");
      snip.className = "brain-source-snip";
      snip.textContent = s.snippet || "";
      card.append(top, snip);
      el.brainSources.appendChild(card);
    }
  }

  // Import the Graphify knowledge graph at session start (per requirement) and
  // render it. Layout happens in a fixed virtual 600×600 space mapped via the
  // SVG viewBox, so it renders correctly even while the panel is hidden.
  async function loadKnowledgeGraph() {
    try {
      const res = await fetch("/api/graph");
      const data = await res.json();
      graphData = data && data.available && data.nodes && data.nodes.length ? data : null;
      if (graphData) {
        el.brainGraphMeta.textContent =
          graphData.nodes.length + " nodes · " + graphData.links.length + " links";
        renderKnowledgeGraph();
      } else {
        el.brainGraphMeta.textContent = "not built yet";
      }
    } catch (_) {
      el.brainGraphMeta.textContent = "unavailable";
    }
  }

  // Distinct color per community via the golden angle — readable on navy.
  function communityColor(c) {
    const h = ((c || 0) * 137.508) % 360;
    return "hsl(" + h.toFixed(0) + ", 58%, 66%)";
  }

  // Fruchterman–Reingold layout in a virtual 600×600 box (run once).
  function layoutGraph(nodes, links) {
    const W = 600, H = 600;
    const k = Math.sqrt((W * H) / Math.max(nodes.length, 1)) * 0.62;
    for (const n of nodes) {
      n.x = W / 2 + (Math.random() - 0.5) * W * 0.6;
      n.y = H / 2 + (Math.random() - 0.5) * H * 0.6;
    }
    const iters = 320;
    for (let it = 0; it < iters; it++) {
      const temp = k * (1 - it / iters) * 1.2 + 0.5;
      const dx = new Float64Array(nodes.length);
      const dy = new Float64Array(nodes.length);
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          let ax = nodes[i].x - nodes[j].x, ay = nodes[i].y - nodes[j].y;
          let d2 = ax * ax + ay * ay;
          if (d2 < 0.01) { d2 = 0.01; ax = Math.random(); }
          const d = Math.sqrt(d2), f = (k * k) / d, ux = ax / d, uy = ay / d;
          dx[i] += ux * f; dy[i] += uy * f; dx[j] -= ux * f; dy[j] -= uy * f;
        }
      }
      for (const l of links) {
        let ax = nodes[l.s].x - nodes[l.t].x, ay = nodes[l.s].y - nodes[l.t].y;
        const d = Math.sqrt(ax * ax + ay * ay) + 0.01, f = (d * d) / k, ux = ax / d, uy = ay / d;
        dx[l.s] -= ux * f; dy[l.s] -= uy * f; dx[l.t] += ux * f; dy[l.t] += uy * f;
      }
      for (let i = 0; i < nodes.length; i++) {
        const dl = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i]) || 1;
        nodes[i].x += (dx[i] / dl) * Math.min(dl, temp);
        nodes[i].y += (dy[i] / dl) * Math.min(dl, temp);
        nodes[i].x += (W / 2 - nodes[i].x) * 0.006;
        nodes[i].y += (H / 2 - nodes[i].y) * 0.006;
      }
    }
  }

  function showGraphTip(label, e) {
    const tip = el.brainGraphTip;
    if (!tip || !tip.parentElement) return;
    const box = tip.parentElement.getBoundingClientRect();
    tip.textContent = label;
    tip.style.left = e.clientX - box.left + 8 + "px";
    tip.style.top = e.clientY - box.top + 8 + "px";
    tip.style.opacity = "1";
  }
  function hideGraphTip() {
    if (el.brainGraphTip) el.brainGraphTip.style.opacity = "0";
  }

  function renderKnowledgeGraph() {
    const svg = el.brainGraph;
    if (!svg || !graphData || !graphData.nodes.length) return;
    const NS = "http://www.w3.org/2000/svg";
    const nodes = graphData.nodes.map((n) => ({ id: n.id, label: n.label, community: n.community, file: n.file || "" }));
    const idx = new Map(nodes.map((n, i) => [n.id, i]));
    const links = graphData.links
      .map((l) => ({ s: idx.get(l.source), t: idx.get(l.target) }))
      .filter((l) => l.s != null && l.t != null);
    const deg = new Array(nodes.length).fill(0);
    for (const l of links) { deg[l.s]++; deg[l.t]++; }

    layoutGraph(nodes, links);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) {
      if (n.x < minX) minX = n.x; if (n.y < minY) minY = n.y;
      if (n.x > maxX) maxX = n.x; if (n.y > maxY) maxY = n.y;
    }
    const pad = 26, span = Math.max(maxX - minX, maxY - minY, 1), scale = (600 - 2 * pad) / span;
    for (const n of nodes) { n.x = pad + (n.x - minX) * scale; n.y = pad + (n.y - minY) * scale; }

    // Collision pass — push apart any nodes whose circles overlap, so every dot's
    // boundary is respected (no more dots stacked on top of each other).
    const rad = nodes.map((_, i) => 3 + Math.min(deg[i], 10) * 0.8);
    for (let it = 0; it < 70; it++) {
      let moved = false;
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          let ax = nodes[i].x - nodes[j].x, ay = nodes[i].y - nodes[j].y;
          let d = Math.hypot(ax, ay) || 0.01;
          const minD = rad[i] + rad[j] + 5; // 5px gap between boundaries
          if (d < minD) {
            const push = (minD - d) / 2, ux = ax / d, uy = ay / d;
            nodes[i].x += ux * push; nodes[i].y += uy * push;
            nodes[j].x -= ux * push; nodes[j].y -= uy * push;
            moved = true;
          }
        }
      }
      if (!moved) break;
    }
    for (let i = 0; i < nodes.length; i++) {
      nodes[i].x = Math.max(rad[i], Math.min(600 - rad[i], nodes[i].x));
      nodes[i].y = Math.max(rad[i], Math.min(600 - rad[i], nodes[i].y));
    }

    svg.replaceChildren();
    svg.setAttribute("viewBox", "0 0 600 600");
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    const zoom = document.createElementNS(NS, "g"); // user zoom + drag-rotate (JS transform)
    zoom.setAttribute("class", "brain-graph-zoom");
    const spin = document.createElementNS(NS, "g");
    spin.setAttribute("class", "brain-graph-spin"); // slow CSS orbit; pauses on hover
    const gl = document.createElementNS(NS, "g");
    for (const l of links) {
      const ln = document.createElementNS(NS, "line");
      ln.setAttribute("x1", nodes[l.s].x.toFixed(1));
      ln.setAttribute("y1", nodes[l.s].y.toFixed(1));
      ln.setAttribute("x2", nodes[l.t].x.toFixed(1));
      ln.setAttribute("y2", nodes[l.t].y.toFixed(1));
      ln.setAttribute("stroke", "rgba(165,196,241,0.13)");
      ln.setAttribute("stroke-width", "1");
      gl.appendChild(ln);
    }
    spin.appendChild(gl);
    const gn = document.createElementNS(NS, "g");
    nodes.forEach((n, i) => {
      const c = document.createElementNS(NS, "circle");
      c.setAttribute("cx", n.x.toFixed(1));
      c.setAttribute("cy", n.y.toFixed(1));
      c.setAttribute("r", (3 + Math.min(deg[i], 10) * 0.8).toFixed(1));
      c.setAttribute("fill", communityColor(n.community));
      c.setAttribute("stroke", "rgba(10,18,40,0.7)");
      c.setAttribute("stroke-width", "0.6");
      c.setAttribute("class", "brain-graph-node" + (n.file ? " has-note" : ""));
      c.addEventListener("mouseenter", (e) => showGraphTip(n.label + (n.file ? " — click to open" : ""), e));
      c.addEventListener("mouseleave", hideGraphTip);
      if (n.file) {
        // Open the note on a real click (suppress if the gesture was a rotate-drag).
        c.addEventListener("click", () => { if (!graphDragMoved) openNotePreview(n.file, n.label); });
      }
      gn.appendChild(c);
    });
    spin.appendChild(gn);
    zoom.appendChild(spin);
    svg.appendChild(zoom);
    applyGraphTransform();
    wireGraphInteraction();
    graphRendered = true;
  }

  function applyGraphTransform() {
    const g = el.brainGraph && el.brainGraph.querySelector(".brain-graph-zoom");
    if (g) {
      g.setAttribute(
        "transform",
        "translate(300 300) scale(" + graphScale.toFixed(3) + ") rotate(" + graphRot.toFixed(2) + ") translate(-300 -300)"
      );
    }
  }

  // Wheel = zoom; click-drag = rotate around the center. Set up once.
  function wireGraphInteraction() {
    if (graphWired || !el.brainGraph) return;
    graphWired = true;
    const svg = el.brainGraph;
    const angleAt = (e) => {
      const r = svg.getBoundingClientRect();
      return (Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2)) * 180) / Math.PI;
    };
    svg.addEventListener("wheel", (e) => {
      e.preventDefault();
      graphScale = Math.max(0.4, Math.min(6, graphScale * (e.deltaY < 0 ? 1.12 : 0.89)));
      applyGraphTransform();
    }, { passive: false });
    svg.addEventListener("mousedown", (e) => {
      graphDragging = true;
      graphDragMoved = false;
      graphLastAngle = angleAt(e);
      svg.style.cursor = "grabbing";
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!graphDragging) return;
      graphDragMoved = true;
      const a = angleAt(e);
      graphRot += a - graphLastAngle;
      graphLastAngle = a;
      applyGraphTransform();
    });
    window.addEventListener("mouseup", () => {
      graphDragging = false;
      svg.style.cursor = "grab";
    });
  }

  // Click a graph node → fetch its source note and render it in a themed overlay
  // (the app's own markdown renderer, so it matches the theme — nicer than a raw iframe).
  async function openNotePreview(file, label) {
    if (!el.notePreview || !file) return;
    el.noteTitle.textContent = label || "Note";
    el.noteBody.replaceChildren();
    el.noteBody.textContent = "Loading…";
    el.notePreview.classList.remove("hidden");
    try {
      const res = await fetch("/api/note?file=" + encodeURIComponent(file));
      const data = await res.json();
      if (!res.ok || !data.ok) {
        el.noteBody.textContent = (data && data.error) || "Could not load note.";
        return;
      }
      el.noteTitle.textContent = data.name || label || "Note";
      el.noteBody.replaceChildren();
      renderInto(el.noteBody, data.markdown || "");
      highlightCodeBlocks(el.noteBody);
    } catch (err) {
      el.noteBody.textContent = "Failed to load note: " + err.message;
    }
  }
  function closeNotePreview() {
    if (el.notePreview) el.notePreview.classList.add("hidden");
  }

  // ---- Model Arena: race one prompt across multiple models side by side ----
  function enterArena() {
    arenaMode = true;
    el.arenaToggle.classList.add("arena-active");
    el.transcript.classList.add("hidden");
    el.arenaView.classList.remove("hidden");
    if (!arenaCols.length && modelList.length) {
      const names = modelList.map((m) => m.name);
      const cur = el.modelPicker.value;
      const seed = [];
      if (cur && names.includes(cur)) seed.push(cur);
      for (const n of names) { if (seed.length >= 2) break; if (!seed.includes(n)) seed.push(n); }
      seed.forEach((m) => addPane(m));
    }
    renderArenaModelChips();
    if (arenaLayout === "tabs") setArenaLayout("tabs");
  }
  function exitArena() {
    arenaMode = false;
    el.arenaToggle.classList.remove("arena-active");
    el.arenaView.classList.add("hidden");
    el.transcript.classList.remove("hidden");
  }
  function toggleArena() {
    arenaMode ? exitArena() : enterArena();
  }

  function modelSize(name) {
    const m = modelList.find((x) => x.name === name);
    return m ? m.size : "";
  }

  // Collapse/expand the (long) model list so it doesn't dominate the screen.
  function toggleArenaModels() {
    if (!el.arenaModels || !el.arenaModelsToggle) return;
    const collapsed = el.arenaModels.classList.toggle("collapsed");
    el.arenaModelsToggle.setAttribute("aria-expanded", String(!collapsed));
  }
  // Show how many panes are open, next to the "Race models" toggle.
  function updateArenaModelsCount() {
    if (!el.arenaModelsCount) return;
    el.arenaModelsCount.textContent = arenaCols.length ? "· " + arenaCols.length + " open" : "";
  }

  function renderArenaModelChips() {
    if (!el.arenaModels) return;
    updateArenaModelsCount();
    el.arenaModels.replaceChildren();
    // Local models + connected cloud models + flagship placeholders. Clicking a
    // chip ADDS an instance (duplicates allowed); the chip shows the open count.
    const items = modelList.map((m) => ({ name: m.name, size: m.size, disp: m.name }));
    for (const id of Object.keys(cloudModels)) items.push({ name: id, size: "☁ " + cloudModels[id], disp: id });
    for (const f of FLAGSHIPS) {
      if (connectedProviders.has(f.provider)) continue;
      items.push({ name: f.id, size: "☁ connect", disp: f.label });
    }
    if (!items.length) {
      const empty = document.createElement("span");
      empty.className = "alb-empty";
      empty.textContent = "no models installed";
      el.arenaModels.appendChild(empty);
      return;
    }
    const label = (text) => {
      const s = document.createElement("span");
      s.className = "arena-models-label";
      s.textContent = text;
      el.arenaModels.appendChild(s);
    };
    const makeChip = (m) => {
      const count = arenaCols.filter((c) => c.model === m.name).length;
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "arena-model-chip" + (count ? " selected" : "");
      chip.title = "Add " + (m.disp || m.name) + " to the grid";
      const name = document.createElement("span");
      name.textContent = m.disp || m.name;
      const size = document.createElement("span");
      size.className = "amc-size";
      size.textContent = count ? "×" + count : m.size || "";
      const star = document.createElement("span");
      star.className = "amc-star" + (isFavorite(m.name) ? " on" : "");
      star.textContent = isFavorite(m.name) ? "★" : "☆";
      star.title = isFavorite(m.name) ? "Unfavorite" : "Favorite";
      star.addEventListener("click", (e) => { e.stopPropagation(); toggleFavorite(m.name); });
      chip.append(name, size, star);
      chip.addEventListener("click", () => addPane(m.name));
      return chip;
    };
    const favs = items.filter((m) => isFavorite(m.name));
    if (favs.length) {
      label("★ Favorites");
      favs.forEach((m) => el.arenaModels.appendChild(makeChip(m)));
      label("All models");
    }
    items.forEach((m) => el.arenaModels.appendChild(makeChip(m)));
  }

  // Add one pane instance (a column) for `model` — duplicates allowed.
  function addPane(model) {
    if (arenaCols.length >= 6) { toast("Up to 6 panes at a time."); return; }
    const empty = el.arenaGrid.querySelector(".arena-empty");
    if (empty) empty.remove();
    const colObj = buildArenaColumn(model, ARENA_COLORS[arenaCols.length % ARENA_COLORS.length]);
    arenaCols.push(colObj);
    el.arenaGrid.style.gridTemplateColumns = "repeat(" + arenaCols.length + ", minmax(0, 1fr))";
    selectPane(colObj);
    renderArenaModelChips();
    if (arenaLayout === "tabs") setArenaLayout("tabs");
  }

  // Fan the bottom-bar prompt out to EVERY open pane in parallel (no rebuild — the
  // panes persist). Ollama serializes local model loads on 16 GB, so columns fill
  // as it works through them; TTFT reflects real contention.
  function broadcastArena(prompt) {
    if (!arenaCols.length) { toast("Add at least one model above first."); return; }
    // Stream into idle panes; queue for any pane still working (never interrupt).
    arenaCols.forEach((col) => enqueueOrStream(col, prompt));
    el.arenaPromptText.textContent = prompt;
    el.arenaPromptCount.textContent = String(arenaCols.length);
    el.arenaPrompt.classList.remove("hidden");
  }

  function buildArenaColumn(model, color) {
    const col = document.createElement("div");
    col.className = "arena-col";
    col.style.setProperty("--col", color);
    const bar = document.createElement("div");
    bar.className = "arena-col-bar";
    const head = document.createElement("header");
    head.className = "arena-col-head";
    const dot = document.createElement("span");
    dot.className = "arena-dot";
    const name = document.createElement("span");
    name.className = "arena-col-name";
    name.textContent = model;
    const size = document.createElement("span");
    size.className = "arena-col-size";
    size.textContent = "· " + (modelSize(model) || "");
    const spacer = document.createElement("span");
    spacer.className = "arena-spacer";
    const pen = document.createElement("span");
    pen.className = "arena-pen hidden";
    pen.textContent = "✒ pen";
    const fastest = document.createElement("span");
    fastest.className = "arena-fastest hidden";
    fastest.textContent = "★ fastest";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "arena-close";
    close.title = "Close this pane";
    close.textContent = "✕";
    head.append(dot, name, size, spacer, pen, fastest, close);
    const micros = document.createElement("div");
    micros.className = "arena-micros";
    const mk = (label) => {
      const w = document.createElement("div");
      w.className = "arena-micro";
      const l = document.createElement("span");
      l.className = "am-label";
      l.textContent = label;
      const v = document.createElement("span");
      v.className = "am-val";
      v.textContent = "—";
      w.append(l, v);
      micros.appendChild(w);
      return v;
    };
    const tpsV = mk("tok/s"), ttftV = mk("TTFT"), toksV = mk("tokens");
    // Per-pane context meter — this model's own context, independent of the others.
    const ctx = document.createElement("div");
    ctx.className = "arena-ctx";
    const ctxHead = document.createElement("div");
    ctxHead.className = "arena-ctx-head";
    const ctxLbl = document.createElement("span");
    ctxLbl.textContent = "context";
    const ctxText = document.createElement("span");
    ctxText.className = "arena-ctx-text";
    ctxText.textContent = "—";
    ctxHead.append(ctxLbl, ctxText);
    const ctxBar = document.createElement("div");
    ctxBar.className = "arena-ctx-bar";
    const ctxFill = document.createElement("div");
    ctxFill.className = "arena-ctx-fill";
    ctxBar.appendChild(ctxFill);
    ctx.append(ctxHead, ctxBar);
    const body = document.createElement("div");
    body.className = "arena-col-body";
    // Per-pane prompt — talk to THIS model alone (the bottom bar broadcasts to all).
    const promptRow = document.createElement("div");
    promptRow.className = "arena-pane-prompt";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "arena-pane-input";
    input.placeholder = "Ask " + model + " only…";
    const send = document.createElement("button");
    send.type = "button";
    send.className = "arena-pane-send";
    send.textContent = "→";
    // Queued prompts (shown with a cancel ✕ while the model is busy).
    const queueEl = document.createElement("div");
    queueEl.className = "arena-queue";
    promptRow.append(input, send);
    col.append(bar, head, micros, ctx, body, queueEl, promptRow);
    el.arenaGrid.appendChild(col);
    // The pane object IS the identity (duplicates of the same model are distinct).
    const colObj = { model, color, body, tpsV, ttftV, toksV, ctxFill, ctxText, fastest, pen, col, queueEl, busy: false, queue: [], tokps: 0, done: false, messages: [] };
    // Per-pane prompt → talk to THIS pane only (queues if the model is busy).
    const fire = () => { const v = input.value.trim(); if (!v) return; input.value = ""; enqueueOrStream(colObj, v); };
    send.addEventListener("click", (e) => { e.stopPropagation(); fire(); });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); fire(); } });
    input.addEventListener("click", (e) => e.stopPropagation());
    close.addEventListener("click", (e) => { e.stopPropagation(); removePane(colObj); });
    col.addEventListener("click", () => selectPane(colObj));
    return colObj;
  }

  // Close one pane instance (the ✕).
  function removePane(colObj) {
    const i = arenaCols.indexOf(colObj);
    if (i < 0) return;
    arenaCols.splice(i, 1);
    if (colObj.col) colObj.col.remove();
    el.arenaGrid.style.gridTemplateColumns = "repeat(" + Math.max(arenaCols.length, 1) + ", minmax(0, 1fr))";
    if (selectedCol === colObj) selectPane(arenaCols[0] || null);
    renderArenaModelChips();
    if (arenaLayout === "tabs") setArenaLayout("tabs");
    if (!arenaCols.length) {
      const empty = document.createElement("div");
      empty.className = "arena-empty";
      empty.textContent = "Add a model above to start.";
      el.arenaGrid.appendChild(empty);
    }
  }

  // Select a pane: rainbow edge, ✒ pen badge, and hand that model the pen for the
  // live doc (#53 reads penHolder). In tabs layout, also switch the visible pane.
  function selectPane(colObj) {
    selectedCol = colObj;
    penHolder = colObj ? colObj.model : null;
    for (const c of arenaCols) {
      const on = c === colObj;
      if (c.col) c.col.classList.toggle("selected", on);
      if (c.pen) c.pen.classList.toggle("hidden", !on);
    }
    if (arenaLayout === "tabs") renderArenaTabs();
    onPenHolderChange(); // #53 hook — selecting hands this model the pen
  }

  // Tab strip (tabs layout) — one tab per open pane; active = selected pane.
  function renderArenaTabs() {
    if (!el.arenaTabs) return;
    el.arenaTabs.replaceChildren();
    for (const c of arenaCols) {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "arena-tab" + (c === selectedCol ? " active" : "");
      tab.textContent = c.model;
      tab.addEventListener("click", () => selectPane(c));
      el.arenaTabs.appendChild(tab);
    }
  }

  function setArenaLayout(layout) {
    arenaLayout = layout === "tabs" ? "tabs" : "grid";
    el.arenaGrid.classList.toggle("tabs-layout", arenaLayout === "tabs");
    el.arenaTabs.classList.toggle("hidden", arenaLayout !== "tabs");
    document.querySelectorAll(".arena-layout-btn").forEach((b) =>
      b.classList.toggle("active", b.dataset.layout === arenaLayout)
    );
    if (arenaLayout === "tabs") renderArenaTabs();
  }

  // ---- Shared live document (the pen) ----
  // Selecting a pane hands that model the pen (and takes it from the user).
  function onPenHolderChange() {
    userHasPen = false;
    updatePenIndicator();
  }

  function currentPen() {
    return userHasPen ? "you" : penHolder || "—";
  }

  function updatePenIndicator() {
    if (el.docPen) el.docPen.textContent = docOpen ? "✒ " + currentPen() : "";
  }

  async function loadDoc() {
    try {
      const res = await fetch("/api/doc");
      const d = await res.json();
      docOpen = !!d.open;
      docName = d.name || "";
      docContent = d.content || "";
      docKind = d.kind || "";
      docEditable = !!d.editable;
    } catch (_) {
      docOpen = false;
    }
    renderDoc();
  }

  function renderDoc() {
    if (!el.docPanel) return;
    el.docTitle.textContent = docOpen ? docName : "No document open";
    el.docOpenRow.classList.toggle("hidden", docOpen);
    // Edit controls only for editable (text) docs.
    el.docActions.classList.toggle("hidden", !(docOpen && docEditable));
    if (!docOpen) {
      userHasPen = false;
      el.docEdit.classList.add("hidden");
      el.docSave.classList.add("hidden");
      el.docView.classList.remove("hidden");
      const p = document.createElement("p");
      p.className = "doc-hint";
      p.textContent =
        "Browse to open any file. Text files can be read by every model and edited by the pen-holder; images, PDFs, and video preview inline.";
      el.docView.replaceChildren(p);
      updatePenIndicator();
      return;
    }
    if (userHasPen && docEditable) {
      el.docView.classList.add("hidden");
      el.docEdit.classList.remove("hidden");
      el.docSave.classList.remove("hidden");
      el.docTakePen.textContent = "Cancel";
      el.docEdit.value = docContent;
      updatePenIndicator();
      return;
    }
    el.docEdit.classList.add("hidden");
    el.docSave.classList.add("hidden");
    el.docView.classList.remove("hidden");
    if (el.docTakePen) el.docTakePen.textContent = "✒ Take the pen";
    const raw = "/api/doc/raw?ts=" + Date.now(); // cache-bust per open
    if (docKind === "markdown") {
      renderInto(el.docView, docContent);
      highlightCodeBlocks(el.docView);
    } else if (docKind === "image") {
      const img = document.createElement("img");
      img.className = "doc-media";
      img.src = raw;
      el.docView.replaceChildren(img);
    } else if (docKind === "pdf") {
      const f = document.createElement("iframe");
      f.className = "doc-frame";
      f.src = raw;
      el.docView.replaceChildren(f);
    } else if (docKind === "video") {
      const v = document.createElement("video");
      v.className = "doc-media";
      v.controls = true;
      v.src = raw;
      el.docView.replaceChildren(v);
    } else if (docKind === "binary") {
      const p = document.createElement("p");
      p.className = "doc-hint";
      p.textContent = "Binary file — no text preview available. (" + docName + ")";
      el.docView.replaceChildren(p);
    } else {
      // plain text / code — textContent so nothing is parsed as HTML
      const pre = document.createElement("pre");
      pre.className = "doc-plain";
      pre.textContent = docContent;
      el.docView.replaceChildren(pre);
    }
    updatePenIndicator();
  }

  // Open the native file picker (any file type), then load whatever was chosen.
  async function browseDoc() {
    try {
      const res = await fetch("/api/doc/browse", { method: "POST" });
      const d = await res.json();
      if (d.cancelled) return;
      if (!d.ok) { toast(d.error || "Could not open file."); return; }
      docOpen = true;
      docName = d.name || "";
      docContent = d.content || "";
      docKind = d.kind || "";
      docEditable = !!d.editable;
      userHasPen = false;
      renderDoc();
    } catch (e) {
      toast("Open failed: " + e.message);
    }
  }

  async function closeDoc() {
    try {
      await fetch("/api/doc/close", { method: "POST" });
    } catch (_) {
      /* ignore */
    }
    docOpen = false;
    docName = "";
    docContent = "";
    renderDoc();
  }

  // User takes the pen to edit by hand (toggles edit mode); Cancel returns to view.
  function toggleUserPen() {
    if (!docOpen || !docEditable) return; // only text docs are editable
    userHasPen = !userHasPen;
    renderDoc();
  }

  async function saveDoc() {
    const content = el.docEdit.value;
    try {
      const res = await fetch("/api/doc/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      const d = await res.json();
      if (!d.ok) { toast(d.error || "Save failed."); return; }
      docContent = content;
      userHasPen = false;
      renderDoc();
      toast("Document saved.");
    } catch (e) {
      toast("Save failed: " + e.message);
    }
  }

  function toggleDocPanel() {
    if (!el.docPanel) return;
    const show = el.docPanel.classList.contains("hidden");
    el.docPanel.classList.toggle("hidden", !show);
    el.arenaDocToggle.classList.toggle("active", show);
    if (show) loadDoc();
  }

  // ---- Telemetry HUD ----
  function buildHudLayers() {
    if (!el.hudLayers || el.hudLayers.childElementCount) return;
    for (let i = 0; i < 32; i++) {
      const cell = document.createElement("div");
      cell.className = "hud-layer";
      el.hudLayers.appendChild(cell);
    }
  }

  // Record a finished turn's real tok/s + context fill into the HUD.
  function recordTelemetry(tps, ctxUsed, ctxTotal) {
    if (tps && tps > 0) {
      tpsSeries.push(tps);
      if (tpsSeries.length > 40) tpsSeries.shift();
      if (el.hudTps) el.hudTps.innerHTML = tps.toFixed(1) + "<span>t/s</span>"; // eslint-disable-line no-unsanitized/property
      renderHudSpark();
    }
    if (ctxTotal && el.hudCtxFill) {
      const pct = Math.min(100, Math.round((100 * ctxUsed) / ctxTotal));
      el.hudCtxFill.style.width = pct + "%";
      el.hudCtxText.textContent = ctxUsed.toLocaleString() + " / " + ctxTotal.toLocaleString();
    }
  }

  function renderHudSpark() {
    if (!el.hudSpark) return;
    const vals = tpsSeries;
    if (vals.length < 2) { el.hudSpark.replaceChildren(); return; }
    const max = Math.max(...vals), min = Math.min(...vals);
    const span = max - min || 1;
    const pts = vals
      .map((v, i) => {
        const x = (i / (vals.length - 1)) * 200;
        const y = 38 - ((v - min) / span) * 36;
        return x.toFixed(1) + "," + y.toFixed(1);
      })
      .join(" ");
    const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    line.setAttribute("points", pts);
    el.hudSpark.replaceChildren(line);
  }

  async function pollHudPs() {
    try {
      const res = await fetch("/api/ps");
      const data = await res.json();
      const models = (data && data.models) || [];
      buildHudLayers();
      const cells = el.hudLayers ? el.hudLayers.children : [];
      const palette = ["#4dd6e6", "#7fe0c2", "#b9e84a", "#ffcc4d", "#ff9b3b", "#ff7a59", "#ff6a8e", "#e25ad0"];
      if (!models.length) {
        if (el.hudGpuText) el.hudGpuText.textContent = "idle";
        if (el.hudModel) el.hudModel.textContent = "no model loaded";
        for (const c of cells) c.style.background = "rgba(165,196,241,0.10)";
        return;
      }
      const m = models[0];
      if (el.hudGpuText) el.hudGpuText.textContent = m.gpu_pct + "% GPU · " + m.vram_h;
      if (el.hudModel) el.hudModel.textContent = m.name + " · " + m.size_h;
      const lit = Math.round((m.gpu_pct / 100) * cells.length);
      for (let i = 0; i < cells.length; i++) {
        if (i < lit) {
          const p = palette[Math.min(palette.length - 1, Math.floor((i / cells.length) * palette.length))];
          cells[i].style.background = p;
          cells[i].style.boxShadow = "0 0 6px " + p + "55";
        } else {
          cells[i].style.background = "rgba(165,196,241,0.10)";
          cells[i].style.boxShadow = "none";
        }
      }
    } catch (_) {
      /* Ollama down — leave the HUD as-is */
    }
  }

  function setHud(show) {
    if (!el.hudPanel) return;
    el.hudPanel.classList.toggle("hidden", !show);
    if (el.hudToggle) el.hudToggle.classList.toggle("active", show);
    if (show) {
      buildHudLayers();
      pollHudPs();
      hudPsTimer = setInterval(pollHudPs, 3000);
    } else if (hudPsTimer) {
      clearInterval(hudPsTimer);
      hudPsTimer = null;
    }
  }
  function toggleHud() {
    if (!el.hudPanel) return;
    setHud(el.hudPanel.classList.contains("hidden"));
  }

  // Stream now if the pane is idle, else queue the prompt (with a cancel ✕).
  function enqueueOrStream(colObj, prompt, label) {
    if (colObj.busy) {
      colObj.queue.push({ prompt, label });
      renderQueue(colObj);
    } else {
      streamArenaColumn(colObj, prompt, label);
    }
  }

  // Render this pane's pending (queued) prompts, each with a cancel ✕.
  function renderQueue(colObj) {
    if (!colObj.queueEl) return;
    colObj.queueEl.replaceChildren();
    colObj.queue.forEach((item, i) => {
      const chip = document.createElement("div");
      chip.className = "arena-queued";
      const txt = document.createElement("span");
      txt.className = "arena-queued-txt";
      txt.textContent = "⏳ " + (item.label || item.prompt);
      const x = document.createElement("button");
      x.type = "button";
      x.className = "arena-queued-x";
      x.title = "Remove from queue";
      x.textContent = "✕";
      x.addEventListener("click", (e) => {
        e.stopPropagation();
        colObj.queue.splice(i, 1);
        renderQueue(colObj);
      });
      chip.append(txt, x);
      colObj.queueEl.appendChild(chip);
    });
  }

  async function streamArenaColumn(colObj, prompt, label) {
    const model = colObj.model;
    const controller = new AbortController();
    arenaControllers.push(controller);
    colObj.busy = true;
    const started = performance.now();
    let ttftMs = 0, acc = "", evalCount = 0, evalDuration = 0, promptCount = 0, ctxWindow = 8192;
    // Append a new turn to this pane's own transcript; stream into its answer block.
    colObj.messages.push({ role: "user", content: prompt });
    const turn = document.createElement("div");
    turn.className = "arena-turn";
    const uEl = document.createElement("div");
    uEl.className = "arena-turn-user";
    uEl.textContent = label || prompt;
    const ansEl = document.createElement("div");
    ansEl.className = "arena-turn-ans cursor";
    turn.append(uEl, ansEl);
    colObj.body.appendChild(turn);
    colObj.body.scrollTop = colObj.body.scrollHeight;
    try {
      const provider = providerOf(model);
      const caps = provider ? { thinking: false } : await fetchCaps(model);
      ctxWindow = (caps && caps.window) || 8192;
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          provider,
          messages: colObj.messages, // full per-pane history → multi-turn context
          options: { temperature: parseFloat(el.tempSlider.value) },
          think: caps.thinking,
          // The pen: only the selected pane (and not while the user holds it) may edit.
          can_edit_doc: docOpen && docEditable && !userHasPen && colObj === selectedCol,
        }),
        signal: controller.signal,
      });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          let obj;
          try { obj = JSON.parse(line); } catch (_) { continue; }
          if (obj.grounding || obj.rag_meta) continue;
          if (obj.ctx_window) { ctxWindow = obj.ctx_window; continue; } // real cloud window for the meter
          // Tool activity + iMessage draft cards render into THIS pane's turn
          // (ansEl's parent is the bubble the helpers insert into).
          if (obj.tool_event) { showToolChip(ansEl, obj.tool_event); colObj.body.scrollTop = colObj.body.scrollHeight; continue; }
          if (obj.confirm_send) { showSendConfirm(ansEl, obj.confirm_send); colObj.body.scrollTop = colObj.body.scrollHeight; continue; }
          if (obj.media) { renderMedia(ansEl, obj.media); colObj.body.scrollTop = colObj.body.scrollHeight; continue; }
          if (obj.doc_event) { if (obj.doc_event.updated && !userHasPen) loadDoc(); continue; }
          if (obj.message && obj.message.content) {
            if (!ttftMs) {
              ttftMs = performance.now() - started;
              colObj.ttftV.textContent = (ttftMs / 1000).toFixed(2) + "s";
            }
            acc += obj.message.content;
            renderInto(ansEl, acc);
            colObj.body.scrollTop = colObj.body.scrollHeight;
          }
          if (obj.error) acc += "\n\n_warning: " + obj.error + "_";
          if (obj.eval_count) evalCount = obj.eval_count;
          if (obj.eval_duration) evalDuration = obj.eval_duration;
          if (obj.prompt_eval_count) promptCount = obj.prompt_eval_count;
        }
      }
    } catch (err) {
      acc += err.name === "AbortError" ? "\n\n_stopped_" : "\n\n_warning: " + err.message + "_";
    } finally {
      renderInto(ansEl, acc);
      highlightCodeBlocks(ansEl);
      ansEl.classList.remove("cursor");
      colObj.body.scrollTop = colObj.body.scrollHeight;
      colObj.messages.push({ role: "assistant", content: acc });
      colObj.lastResponse = acc; // kept so Cross-pollinate can share it with the others
      let tps = 0;
      if (evalCount && evalDuration) tps = evalCount / (evalDuration / 1e9);
      else if (evalCount) tps = evalCount / ((performance.now() - started) / 1000);
      colObj.tokps = tps;
      colObj.tpsV.textContent = tps ? tps.toFixed(1) : "—";
      colObj.toksV.textContent = evalCount ? String(evalCount) : "—";
      if (!ttftMs) colObj.ttftV.textContent = "—";
      // Per-pane context meter (this model's own context).
      const used = promptCount + evalCount;
      const total = ctxWindow;
      if (used && colObj.ctxText) {
        colObj.ctxText.textContent = used.toLocaleString() + " / " + total.toLocaleString();
        colObj.ctxFill.style.width = Math.min(100, Math.round((100 * used) / total)) + "%";
      }
      colObj.done = true;
      colObj.busy = false;
      markArenaFastest();
      // Drain the next queued prompt for this pane, if any.
      if (colObj.queue.length) {
        const next = colObj.queue.shift();
        renderQueue(colObj);
        streamArenaColumn(colObj, next.prompt, next.label);
      }
    }
  }

  function markArenaFastest() {
    let best = null;
    for (const c of arenaCols) if (c.tokps > 0 && (!best || c.tokps > best.tokps)) best = c;
    for (const c of arenaCols) c.fastest.classList.toggle("hidden", c !== best);
  }

  // Cross-pollinate: hand each model the OTHER models' latest answers (labeled),
  // with a framing preamble + reflection questions, and let each reconsider.
  function crossPollinate() {
    if (arenaCols.length < 2) { toast("Open at least 2 models first."); return; }
    const resp = arenaCols.map((c) => ({ model: c.model, text: (c.lastResponse || "").trim() }));
    if (resp.some((r) => !r.text)) { toast("Let each model answer once before cross-pollinating."); return; }
    const intro =
      "The following are responses from OTHER AI models to the same request I gave you. " +
      "I'm sharing them so you can compare notes. Read them, then answer: do they change " +
      "your mind about how you responded? Do they give you additional ideas, or a better " +
      "way to approach my request? Reconsider and give your best updated answer — note " +
      "explicitly anything you'd change and why.\n\n";
    arenaCols.forEach((colObj, i) => {
      const others = resp.filter((_, j) => j !== i);
      const shared = others
        .map((o) => "### Response from " + o.model + ":\n" + o.text)
        .join("\n\n");
      enqueueOrStream(colObj, intro + shared, "🔁 Reconsidering with the other models' answers");
    });
  }

  // ---- Saved-diagrams gallery ----
  async function openGallery() {
    el.galleryPreview.classList.add("hidden");
    el.galleryPreview.replaceChildren();
    el.galleryList.classList.remove("hidden");
    el.galleryList.textContent = "Loading…";
    el.galleryModal.classList.remove("hidden");
    try {
      const res = await fetch("/api/artifacts");
      const data = await res.json();
      renderGalleryList(data.artifacts || []);
    } catch (_) {
      el.galleryList.textContent = "Could not load saved diagrams.";
    }
  }

  function closeGallery() {
    el.galleryModal.classList.add("hidden");
  }

  function renderGalleryList(items) {
    el.galleryList.replaceChildren();
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "gallery-empty";
      empty.textContent = "No saved diagrams yet — click Save under any diagram in a chat.";
      el.galleryList.appendChild(empty);
      return;
    }
    for (const it of items) {
      const row = document.createElement("div");
      row.className = "gallery-row";

      const main = document.createElement("button");
      main.type = "button";
      main.className = "gallery-row-main";
      main.addEventListener("click", () => openSavedArtifact(it.id));
      const badge = document.createElement("span");
      badge.className = "gallery-badge";
      badge.textContent = it.type;
      const title = document.createElement("span");
      title.className = "gallery-row-title";
      title.textContent = it.title;
      const date = document.createElement("span");
      date.className = "gallery-row-date";
      date.textContent = new Date(it.created).toLocaleDateString();
      main.append(badge, title, date);

      const del = document.createElement("button");
      del.type = "button";
      del.className = "gallery-del";
      del.title = "Delete";
      del.textContent = "×";
      del.addEventListener("click", () => deleteSavedArtifact(it.id, it.title));

      row.append(main, del);
      el.galleryList.appendChild(row);
    }
  }

  async function openSavedArtifact(id) {
    try {
      const res = await fetch("/api/artifacts/" + encodeURIComponent(id));
      if (!res.ok) throw new Error("not found");
      const rec = await res.json();
      const built = await buildArtifactView(rec.type, rec.source);

      el.galleryPreview.replaceChildren();
      const head = document.createElement("div");
      head.className = "gallery-preview-head";
      const back = document.createElement("button");
      back.type = "button";
      back.className = "artifact-btn";
      back.textContent = "‹ Back";
      back.addEventListener("click", () => {
        el.galleryPreview.classList.add("hidden");
        el.galleryList.classList.remove("hidden");
      });
      const ttl = document.createElement("span");
      ttl.className = "gallery-preview-title";
      ttl.textContent = rec.title;
      head.append(back, ttl);

      const bar = buildArtifactBar({
        type: rec.type,
        source: rec.source,
        viewEl: built.el,
        payload: built.payload,
        mime: built.mime,
        ext: built.ext,
        error: built.error,
        onDownload: built.onDownload,
        noDownload: built.noDownload,
        allowSave: false,
      });

      el.galleryPreview.append(head, bar, built.el);
      el.galleryList.classList.add("hidden");
      el.galleryPreview.classList.remove("hidden");
    } catch (_) {
      toast("Could not open that diagram.");
    }
  }

  async function deleteSavedArtifact(id, title) {
    if (!confirm('Delete "' + title + '"? This removes the saved file.')) return;
    try {
      await fetch("/api/artifacts/" + encodeURIComponent(id), { method: "DELETE" });
      openGallery(); // refresh the list
    } catch (_) {
      toast("Delete failed.");
    }
  }

  el.gallery.addEventListener("click", openGallery);
  if (el.brainToggle) el.brainToggle.addEventListener("click", toggleBrainPanel);
  if (el.arenaToggle) el.arenaToggle.addEventListener("click", toggleArena);
  if (el.arenaModelsToggle) el.arenaModelsToggle.addEventListener("click", toggleArenaModels);
  document.querySelectorAll(".arena-layout-btn").forEach((b) =>
    b.addEventListener("click", () => setArenaLayout(b.dataset.layout))
  );
  if (el.arenaDocToggle) el.arenaDocToggle.addEventListener("click", toggleDocPanel);
  {
    const x = document.getElementById("arenaCrossBtn");
    if (x) x.addEventListener("click", crossPollinate);
  }
  if (el.docBrowseBtn) el.docBrowseBtn.addEventListener("click", browseDoc);
  if (el.docClose) el.docClose.addEventListener("click", closeDoc);
  if (el.docTakePen) el.docTakePen.addEventListener("click", toggleUserPen);
  if (el.docSave) el.docSave.addEventListener("click", saveDoc);
  if (el.hudToggle) el.hudToggle.addEventListener("click", toggleHud);
  if (el.hudClose) el.hudClose.addEventListener("click", () => setHud(false));
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === "t" || e.key === "T")) {
      e.preventDefault();
      toggleHud();
    }
  });
  if (el.brainClose) el.brainClose.addEventListener("click", closeBrainPanel);
  if (el.noteClose) el.noteClose.addEventListener("click", closeNotePreview);
  if (el.notePreview) el.notePreview.addEventListener("click", (e) => {
    if (e.target === el.notePreview) closeNotePreview();
  });
  // Escape closes whichever overlay is open (note preview, HUD, or Second-Brain panel).
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (el.notePreview && !el.notePreview.classList.contains("hidden")) closeNotePreview();
    if (el.hudPanel && !el.hudPanel.classList.contains("hidden")) setHud(false);
    if (el.brainPanel && !el.brainPanel.classList.contains("hidden")) closeBrainPanel();
  });
  el.galleryClose.addEventListener("click", closeGallery);
  el.galleryModal.addEventListener("click", (e) => {
    if (e.target === el.galleryModal) closeGallery();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !el.galleryModal.classList.contains("hidden")) closeGallery();
  });

  // ---- Attachments (images → a vision model; documents → extracted text) ----
  async function addFiles(fileList) {
    for (const file of fileList) {
      if (file.type.startsWith("image/")) {
        const dataUrl = await new Promise((resolve) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result);
          r.onerror = () => resolve(null);
          r.readAsDataURL(file);
        });
        if (!dataUrl) continue;
        const b64 = String(dataUrl).split(",")[1] || "";
        attachments.push({ kind: "image", name: file.name, dataUrl, b64 });
      } else {
        const fd = new FormData();
        fd.append("file", file);
        try {
          const res = await fetch("/api/extract", { method: "POST", body: fd });
          const d = await res.json();
          if (!res.ok) {
            toast(d.error || "Could not read " + file.name);
            continue;
          }
          attachments.push({
            kind: "doc", name: d.filename, text: d.text, chars: d.chars, truncated: d.truncated,
          });
        } catch (_) {
          toast("Could not read " + file.name);
        }
      }
      renderAttachStrip();
    }
  }

  function renderAttachStrip() {
    el.attachStrip.replaceChildren();
    el.attachStrip.classList.toggle("hidden", attachments.length === 0);
    attachments.forEach((a, i) => {
      const chip = document.createElement("div");
      chip.className = "attach-chip";
      if (a.kind === "image") {
        const img = document.createElement("img");
        img.className = "attach-thumb";
        img.src = a.dataUrl;
        img.alt = a.name;
        chip.appendChild(img);
      } else {
        const icon = document.createElement("span");
        icon.className = "attach-icon";
        icon.textContent = "📄";
        chip.appendChild(icon);
      }
      const label = document.createElement("span");
      label.className = "attach-name";
      label.textContent = a.name + (a.truncated ? " · truncated" : "");
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "attach-remove";
      rm.textContent = "×";
      rm.title = "Remove";
      rm.addEventListener("click", () => {
        attachments.splice(i, 1);
        renderAttachStrip();
      });
      chip.append(label, rm);
      el.attachStrip.appendChild(chip);
    });
  }

  el.attach.addEventListener("click", () => el.fileInput.click());
  el.fileInput.addEventListener("change", () => {
    if (el.fileInput.files.length) addFiles(el.fileInput.files);
    el.fileInput.value = ""; // allow re-selecting the same file
  });

  // Drag-and-drop onto the composer.
  const composerEl = document.querySelector(".composer");
  if (composerEl) {
    composerEl.addEventListener("dragover", (e) => {
      e.preventDefault();
      composerEl.classList.add("drag-over");
    });
    composerEl.addEventListener("dragleave", (e) => {
      if (e.target === composerEl) composerEl.classList.remove("drag-over");
    });
    composerEl.addEventListener("drop", (e) => {
      e.preventDefault();
      composerEl.classList.remove("drag-over");
      if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
    });
  }

  // ---- Send / stream ----
  async function sendMessage() {
    const text = el.input.value.trim();
    // Arena mode: broadcast the prompt to every open pane instead of chatting.
    if (arenaMode) {
      if (!text) return;
      el.input.value = "";
      autogrow();
      broadcastArena(text);
      return;
    }
    const model = el.modelPicker.value;
    if ((!text && attachments.length === 0) || streaming) return;
    if (!model) {
      alert("Pick a model first (none installed? run: ollama pull llama3.2).");
      return;
    }

    // Snapshot attachments for this turn and clear the tray.
    const atts = attachments.slice();
    attachments = [];
    renderAttachStrip();
    const docs = atts.filter((a) => a.kind === "doc");
    const imgs = atts.filter((a) => a.kind === "image");
    const marker = atts.length ? "\n\n📎 " + atts.map((a) => a.name).join(", ") : "";

    hideEmptyState();
    // Stored/displayed content stays clean (just a filename marker — no doc text or
    // base64); the full doc text + images ride only in the outgoing request below.
    const storedContent = (text || "(see attachments)") + marker;
    messages.push({ role: "user", content: storedContent });
    addBubble("user").textContent = storedContent;
    persistCurrent(); // surface the conversation in the sidebar right away

    el.input.value = "";
    autogrow();

    await runAssistantTurn(model, { text, docs, imgs });
  }

  // Stream one assistant reply for the current `messages` array. Split out of
  // sendMessage so regenerate() can re-run a turn without re-reading the composer.
  async function runAssistantTurn(model, { text = "", docs = [], imgs = [] } = {}) {
    const assistantBody = addBubble("assistant");
    assistantBody.classList.add("cursor");

    setStreaming(true);
    controller = new AbortController();

    let acc = "";
    let thinkAcc = "";
    let thinkContent = null; // the panel's content node, created on first thought
    let thinkCollapsed = false; // collapse once the real answer starts
    let evalCount = 0;
    let evalDuration = 0; // nanoseconds (from Ollama's final message)
    let promptCount = 0; // prompt tokens Ollama evaluated (the full context size)
    const started = performance.now();

    // Capabilities: reasoning + whether the model can see images. Cloud models
    // route to a provider API (no Ollama /api/show), so skip the cap probe.
    const provider = providerOf(model);
    const caps = provider ? { thinking: false, vision: false } : await fetchCaps(model);
    const think = caps.thinking;

    // Outgoing messages: fold attached document text into the last user message,
    // and attach base64 images only if the model can actually see them.
    const outgoing = messages.map((m) => ({ role: m.role, content: m.content }));
    const lastMsg = outgoing[outgoing.length - 1];
    if (docs.length) {
      const docBlock =
        "The user attached document(s):\n\n" +
        docs
          .map((d) => `--- ${d.name}${d.truncated ? " (truncated)" : ""} ---\n${d.text}`)
          .join("\n\n") +
        "\n\n---\n\n";
      lastMsg.content = docBlock + (text || "Please read the attached document(s).");
    }
    if (imgs.length) {
      if (caps.vision) {
        lastMsg.images = imgs.map((a) => a.b64);
      } else {
        toast("This model can't see images — switch to a vision model (e.g. Gemma 4).");
      }
    }

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          provider,
          messages: outgoing,
          options: { temperature: parseFloat(el.tempSlider.value) },
          think,
        }),
        signal: controller.signal,
      });

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // NDJSON: one JSON object per line.
        const lines = buffer.split("\n");
        buffer = lines.pop(); // keep the trailing partial line

        for (const line of lines) {
          if (!line.trim()) continue;
          let obj;
          try {
            obj = JSON.parse(line);
          } catch (_) {
            continue;
          }
          if (obj.ctx_window) {
            ctxWindow = obj.ctx_window; // real cloud context window → meter max
            updateCtxMeter();
            continue;
          }
          if (obj.grounding) {
            showGroundingChip(assistantBody, obj.grounding);
            latestGrounding = obj.grounding;
            renderBrainSources();
            continue; // metadata line, no message payload
          }
          if (obj.rag_meta) {
            latestRagMeta = obj.rag_meta;
            renderBrainSources();
            continue; // retrieval stats, no message payload
          }
          if (obj.confirm_send) {
            showSendConfirm(assistantBody, obj.confirm_send);
            continue; // a Send/Cancel card, no message payload
          }
          if (obj.tool_event) {
            showToolChip(assistantBody, obj.tool_event);
            onAgentToolEvent(obj.tool_event.name); // refresh tree/journal on a project_* edit
            continue; // tool-call metadata, no message payload
          }
          if (obj.media) {
            renderMedia(assistantBody, obj.media);
            scrollToBottom();
            continue; // generated image/audio/video, no message payload
          }
          if (obj.error) {
            acc += "\n\n_warning: " + obj.error + "_";
          }
          // Reasoning stream (only when a thinking model + toggle on).
          if (obj.message && obj.message.thinking) {
            if (!thinkContent) {
              thinkContent = makeThinkBlock(assistantBody).content;
            }
            thinkAcc += obj.message.thinking;
            thinkContent.textContent = thinkAcc;
          }
          if (obj.message && obj.message.content) {
            // First real answer token: collapse the reasoning panel.
            if (thinkContent && !thinkCollapsed) {
              const block = thinkContent.parentElement;
              block.classList.add("collapsed");
              block.querySelector(".think-head").textContent = "💭 Thinking";
              thinkCollapsed = true;
            }
            acc += obj.message.content;
          }
          if (obj.eval_count) evalCount = obj.eval_count;
          if (obj.eval_duration) evalDuration = obj.eval_duration;
          if (obj.prompt_eval_count) promptCount = obj.prompt_eval_count;

          renderInto(assistantBody, acc);
          scrollToBottom();
        }
      }
    } catch (err) {
      if (err.name === "AbortError") {
        acc += "\n\n_stopped_";
      } else {
        acc += "\n\n_warning: " + err.message + "_";
      }
    } finally {
      assistantBody.classList.remove("cursor");
      renderInto(assistantBody, acc);
      renderArtifacts(assistantBody); // render any mermaid/svg/html once complete
      highlightCodeBlocks(assistantBody); // colour code blocks now the text is final
      messages.push({ role: "assistant", content: acc });

      // tokens/sec readout — prefer Ollama's own timing, else wall clock.
      let tps = 0;
      if (evalCount && evalDuration) {
        tps = evalCount / (evalDuration / 1e9);
      } else if (evalCount) {
        tps = evalCount / ((performance.now() - started) / 1000);
      }
      el.tps.textContent = tps ? `${tps.toFixed(1)} tok/s` : "";

      // Context meter — Ollama reports the exact prompt + response token counts,
      // which include the system prompt, tools, and grounding.
      if (promptCount || evalCount) {
        ctxUsed = promptCount + evalCount;
        updateCtxMeter();
      }
      recordTelemetry(tps, ctxUsed, ctxWindow); // feed the live HUD

      setStreaming(false);
      controller = null;
      scrollToBottom();
      persistCurrent(); // save the full turn (and streaming result) to localStorage

      // Voice mode: speak the reply, then auto-listen for the next turn. Skip if the
      // user stopped the turn (no point reading a half/aborted answer aloud).
      if (voiceAmbient && acc.trim() && !acc.endsWith("_stopped_")) speakReply(acc);
    }
  }

  function setStreaming(on) {
    streaming = on;
    el.send.disabled = on;
    el.send.classList.toggle("hidden", on);
    el.stop.classList.toggle("hidden", !on);
  }

  // ---- Voice mode (#49): cloud Whisper STT + OpenAI TTS ----
  // Mic button = push-to-talk dictation (record → transcribe → send). The 🎧 Voice
  // toggle adds hands-free: spoken replies + auto-listen after each reply finishes.
  let voiceAmbient = false, voiceRecording = false;
  let voiceRecorder = null, voiceStream = null, voiceChunks = [];
  let voiceAudioCtx = null, voiceRaf = 0, voiceAudio = null;

  function setMicUI(on) {
    voiceRecording = on;
    if (el.micBtn) el.micBtn.classList.toggle("recording", on);
  }

  async function startVoiceRecording() {
    if (voiceRecording || streaming) return;
    if (!navigator.mediaDevices || !window.MediaRecorder) { toast("This browser can't record audio."); return; }
    try {
      voiceStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (_) { toast("Microphone access was denied."); if (voiceAmbient) toggleVoiceMode(); return; }
    voiceChunks = [];
    voiceRecorder = new MediaRecorder(voiceStream);
    voiceRecorder.ondataavailable = (e) => { if (e.data && e.data.size) voiceChunks.push(e.data); };
    voiceRecorder.onstop = () => {
      stopSilenceWatch();
      if (voiceStream) { voiceStream.getTracks().forEach((t) => t.stop()); voiceStream = null; }
      const blob = new Blob(voiceChunks, { type: (voiceRecorder && voiceRecorder.mimeType) || "audio/webm" });
      setMicUI(false);
      if (blob.size > 1200) transcribeAndSend(blob);
      else if (voiceAmbient) scheduleAmbientListen(); // too short — listen again
    };
    voiceRecorder.start();
    setMicUI(true);
    startSilenceWatch();
  }

  function stopVoiceRecording() {
    if (voiceRecorder && voiceRecording) { try { voiceRecorder.stop(); } catch (_) {} }
  }
  function toggleMic() { voiceRecording ? stopVoiceRecording() : startVoiceRecording(); }

  // Auto-stop after a beat of trailing silence, so one tap captures one utterance.
  function startSilenceWatch() {
    try {
      voiceAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const analyser = voiceAudioCtx.createAnalyser();
      analyser.fftSize = 512;
      voiceAudioCtx.createMediaStreamSource(voiceStream).connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      const startedAt = performance.now();
      let lastLoud = startedAt;
      const tick = () => {
        if (!voiceRecording) return;
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
        const rms = Math.sqrt(sum / buf.length);
        const now = performance.now();
        if (rms > 0.025) lastLoud = now;
        if (now - startedAt > 900 && now - lastLoud > 1600) { stopVoiceRecording(); return; }
        voiceRaf = requestAnimationFrame(tick);
      };
      voiceRaf = requestAnimationFrame(tick);
    } catch (_) { /* no analyser available → manual tap-to-stop only */ }
  }
  function stopSilenceWatch() {
    if (voiceRaf) { cancelAnimationFrame(voiceRaf); voiceRaf = 0; }
    if (voiceAudioCtx) { try { voiceAudioCtx.close(); } catch (_) {} voiceAudioCtx = null; }
  }

  async function transcribeAndSend(blob) {
    if (el.micBtn) el.micBtn.classList.add("transcribing");
    try {
      const fd = new FormData();
      const ext = /mp4|mpeg|m4a/.test(blob.type) ? "mp4" : "webm";
      fd.append("audio", blob, "speech." + ext);
      const res = await fetch("/api/transcribe", { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) { toast(data.error || "Transcription failed."); if (voiceAmbient) scheduleAmbientListen(); return; }
      const text = (data.text || "").trim();
      if (!text) { if (voiceAmbient) scheduleAmbientListen(); return; }
      el.input.value = text;
      autogrow();
      sendMessage(); // fires the turn; reply is spoken if voice mode is on
    } catch (err) {
      toast("Transcription error: " + err.message);
      if (voiceAmbient) scheduleAmbientListen();
    } finally {
      if (el.micBtn) el.micBtn.classList.remove("transcribing");
    }
  }

  // Strip code/markup so TTS reads the prose, not symbols.
  function speakableText(md) {
    return (md || "")
      .replace(/```[\s\S]*?```/g, " . ")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\[(.*?)\]\([^)]*\)/g, "$1")
      .replace(/[*_#>|~]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 3500);
  }

  async function speakReply(md) {
    const text = speakableText(md);
    if (!text) { if (voiceAmbient) scheduleAmbientListen(); return; }
    try {
      const res = await fetch("/api/speak", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        toast(e.error || "Speech failed.");
        if (voiceAmbient) scheduleAmbientListen();
        return;
      }
      const url = URL.createObjectURL(await res.blob());
      stopSpeaking();
      voiceAudio = new Audio(url);
      const after = () => { URL.revokeObjectURL(url); voiceAudio = null; if (voiceAmbient) scheduleAmbientListen(); };
      voiceAudio.onended = after;
      voiceAudio.onerror = after;
      voiceAudio.play().catch(after);
    } catch (_) {
      if (voiceAmbient) scheduleAmbientListen();
    }
  }
  function stopSpeaking() {
    if (voiceAudio) { try { voiceAudio.pause(); } catch (_) {} voiceAudio = null; }
  }
  function scheduleAmbientListen() {
    if (!voiceAmbient) return;
    setTimeout(() => { if (voiceAmbient && !streaming && !voiceRecording) startVoiceRecording(); }, 350);
  }

  function toggleVoiceMode() {
    voiceAmbient = !voiceAmbient;
    if (el.voiceToggle) {
      el.voiceToggle.classList.toggle("active", voiceAmbient);
      el.voiceToggle.setAttribute("aria-pressed", String(voiceAmbient));
    }
    if (voiceAmbient) { toast("Voice mode on — start speaking."); startVoiceRecording(); }
    else { stopVoiceRecording(); stopSpeaking(); toast("Voice mode off."); }
  }

  el.send.addEventListener("click", sendMessage);
  if (el.micBtn) el.micBtn.addEventListener("click", toggleMic);
  if (el.voiceToggle) el.voiceToggle.addEventListener("click", toggleVoiceMode);

  el.stop.addEventListener("click", () => {
    if (controller) controller.abort();
  });

  el.newChat.addEventListener("click", startNewChat);
  el.newChatSidebar.addEventListener("click", startNewChat);

  if (el.convoSearch) {
    el.convoSearch.addEventListener("input", () => {
      convoQuery = el.convoSearch.value.trim().toLowerCase();
      renderSidebar();
    });
  }
  if (el.exportChat) el.exportChat.addEventListener("click", exportConversation);

  // ---- Server lifecycle (handled by the supervisor) ----
  // Top-level form POST to the supervisor's control port. A navigation, not a
  // fetch, so there's no cross-origin restriction and we land on its page.
  function postNavigate(action, fields) {
    const form = document.createElement("form");
    form.method = "POST";
    form.action = action;
    for (const [name, value] of Object.entries(fields || {})) {
      const hidden = document.createElement("input");
      hidden.type = "hidden";
      hidden.name = name;
      hidden.value = value;
      form.appendChild(hidden);
    }
    document.body.appendChild(form);
    form.submit();
  }

  function noControls() {
    alert(
      "Server controls need the desktop launcher.\n\n" +
        "Launch Local LLM Studio from the Desktop icon to Start, Stop, or " +
        "change the port."
    );
  }

  // End → full quit: the supervisor stops the server, frees the model's RAM, and
  // closes the launching Terminal window before exiting.
  el.quit.addEventListener("click", () => {
    if (!CONTROL_URL) return noControls();
    if (!confirm("Quit Local LLM Studio? This stops the server and closes its Terminal window.")) return;
    if (streaming && controller) controller.abort();
    if (healthTimer) clearInterval(healthTimer);
    postNavigate(CONTROL_URL + "/quit");
  });

  // ---- Settings modal (port) ----
  function openSettings() {
    el.portInput.value = window.location.port || "5000";
    el.themeSelect.value = localStorage.getItem(LS_THEME_KEY) || "dark-luxury";
    const fs = parseInt(localStorage.getItem(LS_FONT_KEY) || "100", 10);
    el.fontSizeRange.value = String(fs);
    el.fontSizeValue.textContent = fs + "%";
    el.settingsModal.classList.remove("hidden");
  }

  // Appearance — theme + UI scale, applied live and persisted.
  function applyTheme(name) {
    document.documentElement.setAttribute("data-theme", name);
    try {
      localStorage.setItem(LS_THEME_KEY, name);
    } catch (_) {}
  }

  function applyFontScale(pct) {
    document.documentElement.style.setProperty("--app-zoom", String(pct / 100));
    if (el.fontSizeValue) el.fontSizeValue.textContent = pct + "%";
    try {
      localStorage.setItem(LS_FONT_KEY, String(pct));
    } catch (_) {}
  }

  function closeSettings() {
    el.settingsModal.classList.add("hidden");
  }

  function applySettings() {
    if (!CONTROL_URL) return noControls();
    const port = parseInt(el.portInput.value, 10);
    if (!(port >= 1024 && port <= 65535)) {
      alert("Pick a port between 1024 and 65535.");
      return;
    }
    if (String(port) === (window.location.port || "5000")) {
      closeSettings(); // no change — nothing to restart
      return;
    }
    if (streaming && controller) controller.abort();
    if (healthTimer) clearInterval(healthTimer);
    postNavigate(CONTROL_URL + "/restart", { port: String(port) });
  }

  el.settings.addEventListener("click", openSettings);
  el.settingsCancel.addEventListener("click", closeSettings);
  el.settingsApply.addEventListener("click", applySettings);
  el.themeSelect.addEventListener("change", () => applyTheme(el.themeSelect.value));
  el.fontSizeRange.addEventListener("input", () =>
    applyFontScale(parseInt(el.fontSizeRange.value, 10))
  );
  el.settingsModal.addEventListener("click", (e) => {
    if (e.target === el.settingsModal) closeSettings(); // click backdrop to close
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !el.settingsModal.classList.contains("hidden")) {
      closeSettings();
    }
  });

  // Sidebar collapse — persisted so it stays how the user left it.
  function setSidebarCollapsed(collapsed) {
    el.app.classList.toggle("sidebar-collapsed", collapsed);
    try {
      localStorage.setItem(LS_SIDEBAR_KEY, collapsed ? "1" : "0");
    } catch (_) {
      /* ignore storage errors */
    }
  }

  el.sidebarToggle.addEventListener("click", () => {
    setSidebarCollapsed(!el.app.classList.contains("sidebar-collapsed"));
  });

  // Delegated clicks on the conversation list: row opens, "×" deletes.
  el.convoList.addEventListener("click", (e) => {
    const del = e.target.closest(".convo-del");
    if (del) {
      e.stopPropagation();
      if (confirm("Delete this conversation?")) deleteConvo(del.dataset.id);
      return;
    }
    const row = e.target.closest(".convo-row");
    if (row) openConvo(row.dataset.id);
  });

  // ---- Init ----
  if (localStorage.getItem(LS_SIDEBAR_KEY) === "1") {
    el.app.classList.add("sidebar-collapsed");
  }
  // Restore appearance (theme + UI scale) before anything renders.
  applyTheme(localStorage.getItem(LS_THEME_KEY) || "dark-luxury");
  applyFontScale(parseInt(localStorage.getItem(LS_FONT_KEY) || "100", 10));

  // Second brain: import the knowledge graph + index health at session start.
  loadSecondBrainHealth();
  loadKnowledgeGraph();
  loadModels();
  loadProviders(); // cloud-model connection status + merge any connected models
  refreshHealth();
  healthTimer = setInterval(refreshHealth, 8000);

  // Reopen the most-recent conversation, or start an empty chat if none exist.
  renderSidebar();
  const existing = loadConvos().sort((a, b) => b.updatedAt - a.updatedAt);
  if (existing.length > 0) openConvo(existing[0].id);
  else startNewChat();
})();
