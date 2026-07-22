/* Þjálfarinn — persónulegur AI-æfingaþjálfari (PWA)
   Vanilla JS + Supabase (auth + gögn) + Claude AI í gegnum Edge Function. */

(function () {
  "use strict";

  const CFG = window.THJALFARINN_CONFIG || {};
  const app = document.getElementById("app");

  // ---------- Hjálparföll ----------
  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }
  function el(html) {
    const t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }
  function fmtDate(d) {
    return new Date(d).toLocaleDateString("is-IS", { day: "numeric", month: "short" });
  }
  // Íslensk æfingaheiti -> ensk (varaleið þegar AI-ið skilaði ekki video_query)
  const IS_EN = [
    ["bringupressa", "chest press"], ["bekkpressa", "bench press"],
    ["axlapressa", "shoulder press"], ["fótapressa", "leg press"],
    ["niðurtog á brjóst", "lat pulldown"], ["niðurtog", "pulldown"],
    ["róður", "row"], ["réttstöðulyfta", "deadlift"], ["hnébeygja", "squat"],
    ["framstig", "lunge"], ["lærispark", "leg extension"], ["læriskrull", "leg curl"],
    ["tvíhöfðakröll", "bicep curl"], ["tvíhöfða", "bicep"],
    ["þríhöfðaniðurtog", "tricep pushdown"], ["þríhöfða", "tricep"],
    ["hliðarlyftingar", "lateral raise"], ["framlyftingar", "front raise"],
    ["mjaðmalyfta", "glute bridge"], ["mjaðmapressa", "hip thrust"],
    ["kviðkreppingar", "crunch"], ["kviðæfing", "ab exercise"],
    ["upphífingar", "pull up"], ["armbeygjur", "push up"], ["dýfur", "dips"],
    ["planki", "plank"], ["kálfalyftur", "calf raise"], ["yppingar", "shrug"],
    ["flugur", "fly"], ["yfirtog", "pullover"], ["bakfetta", "back extension"],
    ["í tæki", "machine"], ["í kaðli", "cable"], ["með handlóðum", "dumbbell"],
    ["með handlóði", "dumbbell"], ["með stöng", "barbell"], ["með ketilbjöllu", "kettlebell"],
    ["sitjandi", "seated"], ["standandi", "standing"], ["liggjandi", "lying"],
    ["sléttur", "flat"], ["slétt", "flat"], ["hallandi", "incline"],
    ["víður", "wide grip"], ["þröngur", "close grip"], ["á gólfi", ""],
  ];
  // Enskt heiti æfingar: video_query frá AI, annars enska heitið í sviga,
  // annars þýðing á íslenska nafninu, annars nafnið sjálft (nýrri plön eru
  // með ensk nöfn beint).
  function englishName(ex) {
    if (ex.video_query) return ex.video_query;
    const m = /\(([^)]+)\)/.exec(ex.name || "");
    if (m) return m[1];
    let q = String(ex.name || "").toLowerCase();
    for (const [is, en] of IS_EN) q = q.split(is).join(en);
    return q.replace(/\s+/g, " ").trim() || String(ex.name || "");
  }

  function videoUrl(ex) {
    return "https://www.youtube.com/results?search_query=" +
      encodeURIComponent(englishName(ex) + " exercise form");
  }

  // ---------- Æfingamyndir (free-exercise-db, public domain) ----------
  const EXDB_JSON = "https://cdn.jsdelivr.net/gh/yuhonas/free-exercise-db@main/dist/exercises.json";
  const EXDB_IMG = "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/";

  function normTokens(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  }

  async function loadExdb() {
    if (state.exdb) return;
    try {
      const cached = localStorage.getItem("exdb_v1");
      if (cached) { state.exdb = JSON.parse(cached); return; }
    } catch (_) { /* ekkert */ }
    try {
      const res = await fetch(EXDB_JSON);
      const all = await res.json();
      state.exdb = all
        .filter((e) => e.images && e.images.length)
        .map((e) => ({ t: normTokens(e.name), a: e.images[0], b: e.images[1] || e.images[0] }));
      try { localStorage.setItem("exdb_v1", JSON.stringify(state.exdb)); } catch (_) { /* of stórt - í lagi */ }
    } catch (_) {
      state.exdb = []; // myndir bara sleppast ef safnið næst ekki
    }
  }

  // Finna mynd sem passar best við enska heitið (token-skörun)
  function findExercisePhoto(ex) {
    if (!state.exdb || !state.exdb.length) return null;
    const tokens = new Set(normTokens(englishName(ex)));
    if (!tokens.size) return null;
    let best = null, bestScore = 0;
    for (const e of state.exdb) {
      let inter = 0;
      for (const tok of e.t) if (tokens.has(tok)) inter++;
      const score = inter / Math.max(tokens.size, e.t.length);
      if (score > bestScore) { bestScore = score; best = e; }
    }
    return bestScore >= 0.5 ? best : null;
  }

  // ---------- Stillingar ekki komnar ----------
  if (!CFG.SUPABASE_URL || CFG.SUPABASE_URL.startsWith("SETTU_INN")) {
    app.innerHTML = `
      <div class="screen no-tabs">
        <h1>Þjálfarinn 🏋️</h1>
        <p class="subtitle">Uppsetningu ekki lokið</p>
        <div class="card">
          <p style="line-height:1.6">Það vantar Supabase-stillingar. Opnaðu skrána
          <b>js/config.js</b> og settu inn <b>SUPABASE_URL</b> og
          <b>SUPABASE_ANON_KEY</b> úr Supabase-verkefninu þínu.
          Sjá leiðbeiningar í README.md.</p>
        </div>
      </div>`;
    return;
  }

  const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);

  // ---------- Ástand ----------
  const state = {
    user: null,
    profile: null,     // jsonb data
    planRow: null,     // { id, plan }
    tab: "home",
    workoutSession: null, // virk æfing
    chat: [],
    chatLoaded: false,
  };

  // ---------- AI kall ----------
  async function aiCall(payload) {
    const { data, error } = await sb.functions.invoke("ai-coach", { body: payload });
    if (error) {
      let msg = error.message || "Villa í AI-kalli";
      try {
        const ctx = await error.context?.json?.();
        if (ctx?.error) msg = ctx.error;
      } catch (_) { /* ekkert */ }
      throw new Error(msg);
    }
    if (data?.error) throw new Error(data.error);
    return data; // { message, plan|null }
  }

  // ---------- Gagnasókn ----------
  async function loadUserData() {
    const [profileRes, planRes] = await Promise.all([
      sb.from("profiles").select("data").eq("user_id", state.user.id).maybeSingle(),
      sb.from("plans").select("id, plan").eq("user_id", state.user.id)
        .eq("active", true).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    ]);
    state.profile = profileRes.data?.data || null;
    state.planRow = planRes.data || null;
  }

  // ---------- Innskráning ----------
  // Nýskráning er lokuð — aðgangar eru stofnaðir handvirkt í Supabase
  // (Authentication -> Users -> Add user).
  function renderAuth() {
    app.innerHTML = `
      <div class="screen no-tabs" style="padding-top: 12vh">
        <h1>Þjálfarinn 🏋️</h1>
        <p class="subtitle">Persónulegur AI-æfingaþjálfari</p>
        <div class="card">
          <label>Netfang</label>
          <input id="email" type="email" autocomplete="email" placeholder="netfang@daemi.is">
          <label>Lykilorð</label>
          <input id="password" type="password" autocomplete="current-password" placeholder="••••••••">
          <button class="btn" id="authBtn">Skrá inn</button>
          <div class="error-msg" id="authError"></div>
        </div>
      </div>`;

    document.getElementById("authBtn").onclick = async () => {
      const email = document.getElementById("email").value.trim();
      const password = document.getElementById("password").value;
      const errEl = document.getElementById("authError");
      const btn = document.getElementById("authBtn");
      if (!email || !password) { errEl.textContent = "Fylltu út netfang og lykilorð"; return; }
      btn.disabled = true;
      errEl.textContent = "";
      try {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
      } catch (e) {
        errEl.textContent = e.message === "Invalid login credentials"
          ? "Rangt netfang eða lykilorð" : (e.message || "Villa");
        btn.disabled = false;
      }
    };
  }

  // ---------- Spurningalisti (onboarding) ----------
  function renderOnboarding() {
    const p = state.profile || {};
    const chipGroup = (name, options, selected) => `
      <div class="chip-row" data-group="${name}">
        ${options.map((o) => `<button type="button" class="chip ${o === selected ? "selected" : ""}" data-val="${esc(o)}">${esc(o)}</button>`).join("")}
      </div>`;

    app.innerHTML = `
      <div class="screen no-tabs">
        <h1>Segðu mér frá þér 💪</h1>
        <p class="subtitle">Þjálfarinn notar þetta til að búa til æfingaplanið þitt</p>

        <label>Markmið</label>
        ${chipGroup("goal", ["Byggja vöðva", "Léttast", "Auka styrk", "Almennt form"], p.goal || "Byggja vöðva")}

        <label>Reynsla af lyftingum</label>
        ${chipGroup("experience", ["Byrjandi", "Miðlungs", "Vanur"], p.experience || "Byrjandi")}

        <label>Hvar æfir þú?</label>
        ${chipGroup("location", ["Líkamsræktarstöð", "Heima með búnað", "Heima án búnaðar"], p.location || "Líkamsræktarstöð")}

        <label>Æfingadagar í viku</label>
        ${chipGroup("days", ["2", "3", "4", "5", "6"], String(p.days || "3"))}

        <label>Lengd æfingar</label>
        ${chipGroup("duration", ["30 mín", "45 mín", "60 mín", "75+ mín"], p.duration || "60 mín")}

        <label>Aldur</label>
        <input id="age" type="number" inputmode="numeric" value="${esc(p.age || "")}" placeholder="t.d. 35">
        <label>Hæð (cm)</label>
        <input id="height" type="number" inputmode="numeric" value="${esc(p.height || "")}" placeholder="t.d. 180">
        <label>Þyngd (kg)</label>
        <input id="weight" type="number" inputmode="decimal" step="0.1" value="${esc(p.weight || "")}" placeholder="t.d. 85">

        <label>Meiðsli, takmarkanir eða annað sem þjálfarinn ætti að vita (valfrjálst)</label>
        <textarea id="notes" rows="3" placeholder="t.d. slæmt hné, vil leggja áherslu á axlir...">${esc(p.notes || "")}</textarea>

        <button class="btn" id="createPlanBtn">Búa til æfingaplan ✨</button>
        <div class="error-msg" id="obError"></div>
      </div>`;

    app.querySelectorAll(".chip-row").forEach((row) => {
      row.addEventListener("click", (e) => {
        const chip = e.target.closest(".chip");
        if (!chip) return;
        row.querySelectorAll(".chip").forEach((c) => c.classList.remove("selected"));
        chip.classList.add("selected");
      });
    });

    document.getElementById("createPlanBtn").onclick = async () => {
      const getChip = (name) => app.querySelector(`[data-group="${name}"] .chip.selected`)?.dataset.val;
      const profile = {
        goal: getChip("goal"),
        experience: getChip("experience"),
        location: getChip("location"),
        days: Number(getChip("days")),
        duration: getChip("duration"),
        age: document.getElementById("age").value || null,
        height: document.getElementById("height").value || null,
        weight: document.getElementById("weight").value || null,
        notes: document.getElementById("notes").value.trim(),
      };
      const errEl = document.getElementById("obError");
      const btn = document.getElementById("createPlanBtn");
      btn.disabled = true;
      errEl.textContent = "";
      try {
        await sb.from("profiles").upsert({
          user_id: state.user.id, data: profile, updated_at: new Date().toISOString(),
        });
        if (profile.weight) {
          await sb.from("weight_logs").insert({ user_id: state.user.id, weight_kg: Number(profile.weight) });
        }
        state.profile = profile;
        renderGenerating("Þjálfarinn er að setja saman æfingaplanið þitt…");
        const res = await aiCall({ mode: "plan", profile });
        await loadUserData();
        showAiModal(res.message, () => renderMain("home"));
      } catch (e) {
        renderOnboarding();
        document.getElementById("obError").textContent = e.message || "Villa við að búa til plan";
      }
    };
  }

  function renderGenerating(text) {
    app.innerHTML = `
      <div class="screen no-tabs" style="padding-top: 30vh; text-align:center">
        <div class="spinner" style="margin: 0 auto 20px"></div>
        <p style="color: var(--text-dim)">${esc(text)}</p>
        <p style="color: var(--text-dim); font-size: 0.85rem; margin-top: 8px">Þetta getur tekið allt að mínútu</p>
      </div>`;
  }

  // ---------- Aðalskjár með flipum ----------
  function renderMain(tab) {
    state.tab = tab || state.tab;
    const tabs = [
      { id: "home", icon: "🏠", label: "Heim" },
      { id: "workout", icon: "🏋️", label: "Æfing" },
      { id: "progress", icon: "📈", label: "Framvinda" },
      { id: "chat", icon: "💬", label: "Spjall" },
    ];
    app.innerHTML = `
      <div class="screen" id="tabContent"></div>
      <nav class="tabbar">
        ${tabs.map((t) => `
          <button data-tab="${t.id}" class="${state.tab === t.id ? "active" : ""}">
            <span class="tab-icon">${t.icon}</span>${t.label}
          </button>`).join("")}
      </nav>`;
    app.querySelectorAll(".tabbar button").forEach((b) => {
      b.onclick = () => renderMain(b.dataset.tab);
    });
    const content = document.getElementById("tabContent");
    if (state.tab === "home") renderHome(content);
    else if (state.tab === "workout") renderWorkoutTab(content);
    else if (state.tab === "progress") renderProgress(content);
    else if (state.tab === "chat") renderChat(content);
  }

  // Næsta æfing: sú sem lengst er síðan var gerð (eða fyrsta ógerða)
  async function suggestNextWorkout() {
    const plan = state.planRow?.plan;
    if (!plan?.workouts?.length) return null;
    const { data: logs } = await sb.from("workout_logs")
      .select("workout_key, created_at")
      .eq("user_id", state.user.id)
      .order("created_at", { ascending: false }).limit(30);
    const lastDone = {};
    (logs || []).forEach((l) => {
      if (!(l.workout_key in lastDone)) lastDone[l.workout_key] = l.created_at;
    });
    let best = plan.workouts[0];
    let bestTime = Infinity;
    for (const w of plan.workouts) {
      const t = lastDone[w.key] ? new Date(lastDone[w.key]).getTime() : 0;
      if (t < bestTime) { bestTime = t; best = w; }
    }
    return best;
  }

  async function renderHome(root) {
    const plan = state.planRow?.plan;
    root.innerHTML = `
      <div class="top-row">
        <h1>Halló! 👋</h1>
        <button class="icon-btn" id="settingsBtn">⚙️</button>
      </div>
      <p class="subtitle">${esc(plan?.name || "Ekkert virkt plan")}</p>
      <div id="homeBody"><div class="ai-thinking"><div class="spinner"></div>Hleð…</div></div>`;
    document.getElementById("settingsBtn").onclick = showSettings;

    const body = document.getElementById("homeBody");
    if (!plan) {
      body.innerHTML = `<div class="card"><p>Ekkert æfingaplan til. Búðu til nýtt plan.</p>
        <button class="btn" id="newPlanBtn">Búa til plan</button></div>`;
      document.getElementById("newPlanBtn").onclick = renderOnboarding;
      return;
    }
    const next = await suggestNextWorkout();
    body.innerHTML = `
      <div class="card">
        <span class="today-badge">NÆSTA ÆFING</span>
        <div class="exercise-title" style="font-size:1.15rem">${esc(next.name)}</div>
        <div class="workout-meta">${next.exercises.length} æfingar · ~${esc(state.profile?.duration || "60 mín")}</div>
        <button class="btn" id="startBtn">Byrja æfingu ▶</button>
      </div>
      ${plan.notes ? `<div class="card"><b>Frá þjálfaranum:</b><p class="ai-message" style="margin-top:6px">${esc(plan.notes)}</p></div>` : ""}
      <h2>Vikuplanið</h2>
      ${plan.workouts.map((w) => `
        <div class="card clickable" data-key="${esc(w.key)}">
          <div class="exercise-title">${esc(w.name)}</div>
          <div class="workout-meta">${w.exercises.map((e2) => esc(e2.name)).join(" · ")}</div>
        </div>`).join("")}`;
    document.getElementById("startBtn").onclick = () => startWorkout(next.key);
    body.querySelectorAll(".card.clickable").forEach((c) => {
      c.onclick = () => startWorkout(c.dataset.key);
    });
  }

  function renderWorkoutTab(root) {
    if (state.workoutSession) { renderActiveWorkout(root); return; }
    const plan = state.planRow?.plan;
    root.innerHTML = `<h1>Æfingar</h1>
      <p class="subtitle">Veldu æfingu til að byrja</p>
      ${!plan ? `<div class="card">Ekkert virkt plan.</div>` : plan.workouts.map((w) => `
        <div class="card clickable" data-key="${esc(w.key)}">
          <div class="exercise-title">${esc(w.name)}</div>
          <div class="workout-meta">${w.exercises.length} æfingar</div>
        </div>`).join("")}`;
    root.querySelectorAll(".card.clickable").forEach((c) => {
      c.onclick = () => startWorkout(c.dataset.key);
    });
  }

  // ---------- Virk æfing ----------
  // Efri mörk reps-bils: "8-10" -> 10, "12" -> 12
  function topReps(repsStr) {
    const m = /(\d+)\s*[-–]\s*(\d+)/.exec(String(repsStr || ""));
    if (m) return Number(m[2]);
    const n = parseInt(repsStr, 10);
    return Number.isFinite(n) ? n : null;
  }

  async function startWorkout(key) {
    const plan = state.planRow?.plan;
    const workout = plan?.workouts?.find((w) => w.key === key);
    if (!workout) return;

    loadExdb(); // sækja myndasafnið samhliða (myndir birtast ef það er klárt)

    // Sjálfvirk þyngdaraukning: náðir þú efri reps-mörkum í öllum settum
    // síðast? Þá er stungið upp á +2,5 kg.
    let lastLog = null;
    try {
      const { data } = await sb.from("workout_logs").select("log")
        .eq("user_id", state.user.id).eq("workout_key", key)
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      lastLog = data?.log || null;
    } catch (_) { /* engin saga - ekkert mál */ }

    state.workoutSession = {
      workoutKey: key,
      workoutName: workout.name,
      startedAt: Date.now(),
      exercises: workout.exercises.map((ex) => {
        let weight = ex.weight_kg ?? "";
        let bumped = false;
        const prev = lastLog?.exercises?.find((p) => p.name === ex.name);
        if (prev?.sets?.length) {
          const prevW = Math.max(...prev.sets.map((s) => Number(s.weight_kg) || 0));
          if (prevW > (Number(weight) || 0)) weight = prevW;
          const top = topReps(ex.reps);
          const hitTopOnAll = top !== null &&
            prev.sets.every((s) => (Number(s.reps) || 0) >= top);
          if (hitTopOnAll && prevW > 0) {
            weight = prevW + 2.5;
            bumped = true;
          }
        }
        return {
          name: ex.name,
          notes: ex.notes || "",
          video_query: ex.video_query || "",
          restSec: ex.rest_sec || 90,
          targetReps: ex.reps,
          bumped,
          sets: Array.from({ length: ex.sets }, () => ({
            weight,
            reps: "",
            done: false,
          })),
        };
      }),
    };
    state.tab = "workout";
    renderMain("workout");
  }

  function renderActiveWorkout(root) {
    const s = state.workoutSession;
    root.innerHTML = `
      <h1>${esc(s.workoutName)}</h1>
      <p class="subtitle">Skráðu þyngd og endurtekningar, hakaðu við hvert sett</p>
      ${s.exercises.map((ex, ei) => {
        const ph = findExercisePhoto(ex);
        return `
        <div class="card exercise-block">
          <div class="exercise-title">${esc(ex.name)}</div>
          ${ph ? `<img class="exercise-photo" loading="lazy" alt=""
                    src="${EXDB_IMG}${esc(ph.a)}"
                    data-a="${EXDB_IMG}${esc(ph.a)}" data-b="${EXDB_IMG}${esc(ph.b)}">` : ""}
          <div class="exercise-actions">
            <a class="video-link" href="${videoUrl(ex)}" target="_blank" rel="noopener">🎥 Sýnikennsla</a>
            <button type="button" class="video-link swap-btn" data-ei="${ei}">⇄ Skipta út</button>
          </div>
          ${ex.notes ? `<div class="exercise-note">${esc(ex.notes)}</div>` : ""}
          <div class="exercise-note">Markmið: ${ex.sets.length} sett × ${esc(ex.targetReps)} reps · hvíld ${ex.restSec}s
            ${ex.bumped ? `<span class="bump-chip">↑ +2,5 kg — þú náðir öllum reps síðast!</span>` : ""}</div>
          <div class="set-header"><span>#</span><span>KG</span><span>REPS</span><span></span></div>
          ${ex.sets.map((set, si) => `
            <div class="set-row">
              <span class="set-num">${si + 1}</span>
              <input type="number" inputmode="decimal" step="0.5" value="${esc(set.weight)}"
                     data-ei="${ei}" data-si="${si}" data-field="weight" placeholder="kg">
              <input type="number" inputmode="numeric" value="${esc(set.reps)}"
                     data-ei="${ei}" data-si="${si}" data-field="reps" placeholder="${esc(ex.targetReps)}">
              <button class="set-check ${set.done ? "done" : ""}" data-ei="${ei}" data-si="${si}">✓</button>
            </div>`).join("")}
        </div>`;
      }).join("")}
      <button class="btn" id="finishBtn">Klára æfingu 🏁</button>
      <button class="btn danger" id="cancelBtn">Hætta við</button>`;

    root.querySelectorAll("input[data-field]").forEach((inp) => {
      inp.addEventListener("input", () => {
        const ex = s.exercises[Number(inp.dataset.ei)];
        ex.sets[Number(inp.dataset.si)][inp.dataset.field] = inp.value;
      });
    });
    root.querySelectorAll(".set-check").forEach((btn) => {
      btn.onclick = () => {
        const ei = Number(btn.dataset.ei), si = Number(btn.dataset.si);
        const ex = s.exercises[ei];
        const set = ex.sets[si];
        set.done = !set.done;
        btn.classList.toggle("done", set.done);
        if (set.done) {
          if (!set.reps) {
            set.reps = String(parseInt(ex.targetReps, 10) || "");
            const repsInput = root.querySelector(`input[data-ei="${ei}"][data-si="${si}"][data-field="reps"]`);
            if (repsInput) repsInput.value = set.reps;
          }
          const isLastSetOfAll = ei === s.exercises.length - 1 && si === ex.sets.length - 1;
          if (!isLastSetOfAll) showRestTimer(ex.restSec);
        }
      };
    });
    root.querySelectorAll(".swap-btn").forEach((btn) => {
      btn.onclick = () => showSwapModal(Number(btn.dataset.ei));
    });
    // Smellur á mynd víxlar milli upphafs- og lokastöðu
    root.querySelectorAll(".exercise-photo").forEach((img) => {
      img.onclick = () => {
        img.src = img.src === img.dataset.a ? img.dataset.b : img.dataset.a;
      };
      img.onerror = () => img.remove();
    });
    document.getElementById("cancelBtn").onclick = () => {
      if (confirm("Hætta við æfinguna? Ekkert verður vistað.")) {
        state.workoutSession = null;
        renderMain("home");
      }
    };
    document.getElementById("finishBtn").onclick = () => {
      const anyDone = s.exercises.some((ex) => ex.sets.some((x) => x.done));
      if (!anyDone && !confirm("Engin sett merkt kláruð — klára samt?")) return;
      showFeedbackModal();
    };
  }

  function showRestTimer(seconds) {
    let remaining = seconds;
    const overlay = el(`
      <div class="rest-overlay">
        <div class="rest-label">Hvíld</div>
        <div class="rest-time" id="restTime">${remaining}</div>
        <button class="btn secondary" id="skipRest">Sleppa hvíld</button>
      </div>`);
    document.body.appendChild(overlay);
    const timeEl = overlay.querySelector("#restTime");
    const interval = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        clearInterval(interval);
        overlay.remove();
        if (navigator.vibrate) navigator.vibrate(300);
      } else {
        timeEl.textContent = remaining;
      }
    }, 1000);
    overlay.querySelector("#skipRest").onclick = () => {
      clearInterval(interval);
      overlay.remove();
    };
  }

  // ---------- Skipta út æfingu ----------
  async function showSwapModal(ei) {
    const s = state.workoutSession;
    const ex = s.exercises[ei];
    const overlay = el(`
      <div class="modal-overlay">
        <div class="modal">
          <h2>Skipta út: ${esc(ex.name)}</h2>
          <div id="swapBody">
            <div class="ai-thinking"><div class="spinner"></div>Þjálfarinn finnur svipaðar æfingar…</div>
          </div>
          <button class="link-btn" id="swapClose">Hætta við</button>
        </div>
      </div>`);
    document.body.appendChild(overlay);
    overlay.querySelector("#swapClose").onclick = () => overlay.remove();
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });

    try {
      const res = await aiCall({ mode: "swap", exerciseName: ex.name, workoutKey: s.workoutKey });
      const alts = res.alternatives || [];
      const body = overlay.querySelector("#swapBody");
      if (!alts.length) {
        body.innerHTML = `<p class="ai-message">${esc(res.message || "Engar tillögur fundust — prófaðu aftur.")}</p>`;
        return;
      }
      body.innerHTML = `
        ${res.message ? `<p class="workout-meta" style="margin-bottom:10px">${esc(res.message)}</p>` : ""}
        ${alts.map((a, i) => `
          <div class="card clickable swap-alt" data-i="${i}">
            <div class="exercise-title">${esc(a.name)}</div>
            <div class="workout-meta">${a.sets} sett × ${esc(a.reps)}${a.weight_kg != null ? ` · ${a.weight_kg} kg` : ""} · hvíld ${a.rest_sec}s</div>
            ${a.notes ? `<div class="exercise-note" style="margin:4px 0 0">${esc(a.notes)}</div>` : ""}
          </div>`).join("")}`;
      body.querySelectorAll(".swap-alt").forEach((cardEl) => {
        cardEl.onclick = async () => {
          const alt = alts[Number(cardEl.dataset.i)];
          overlay.remove();
          await applySwap(ei, alt);
        };
      });
    } catch (e) {
      const body = overlay.querySelector("#swapBody");
      if (body) body.innerHTML = `<p class="error-msg" style="text-align:left">${esc(e.message || "Villa")}</p>`;
    }
  }

  async function applySwap(ei, alt) {
    const s = state.workoutSession;
    // 1) Uppfæra planið sjálft og vista í gagnagrunn
    try {
      const workout = state.planRow?.plan?.workouts?.find((w) => w.key === s.workoutKey);
      if (workout && workout.exercises[ei]) {
        workout.exercises[ei] = alt;
        await sb.from("plans").update({ plan: state.planRow.plan }).eq("id", state.planRow.id);
      }
    } catch (_) { /* planið uppfærist þá bara ekki — æfingin heldur samt áfram */ }
    // 2) Skipta út í yfirstandandi æfingu
    s.exercises[ei] = {
      name: alt.name,
      notes: alt.notes || "",
      video_query: alt.video_query || "",
      restSec: alt.rest_sec || 90,
      targetReps: alt.reps,
      sets: Array.from({ length: alt.sets }, () => ({
        weight: alt.weight_kg ?? "",
        reps: "",
        done: false,
      })),
    };
    renderMain("workout");
  }

  // ---------- Endurgjöf eftir æfingu ----------
  function showFeedbackModal() {
    const overlay = el(`
      <div class="modal-overlay">
        <div class="modal">
          <h2>Hvernig gekk? 💬</h2>
          <label>Hversu erfið var æfingin?</label>
          <div class="chip-row" id="rpeRow">
            ${["Mjög létt", "Frekar létt", "Passleg", "Erfið", "Of erfið"]
              .map((o, i) => `<button type="button" class="chip ${i === 2 ? "selected" : ""}" data-val="${o}">${o}</button>`).join("")}
          </div>
          <label>Athugasemdir til þjálfarans (valfrjálst)</label>
          <textarea id="fbComment" rows="3" placeholder="t.d. bekkpressan var of létt, verkur í öxl..."></textarea>
          <button class="btn" id="sendFeedback">Senda til þjálfarans ✨</button>
          <button class="link-btn" id="skipFeedback">Vista án endurgjafar</button>
        </div>
      </div>`);
    document.body.appendChild(overlay);
    const rpeRow = overlay.querySelector("#rpeRow");
    rpeRow.addEventListener("click", (e) => {
      const chip = e.target.closest(".chip");
      if (!chip) return;
      rpeRow.querySelectorAll(".chip").forEach((c) => c.classList.remove("selected"));
      chip.classList.add("selected");
    });

    const buildLog = () => {
      const s = state.workoutSession;
      return {
        workout_name: s.workoutName,
        duration_min: Math.round((Date.now() - s.startedAt) / 60000),
        exercises: s.exercises.map((ex) => ({
          name: ex.name,
          target_reps: ex.targetReps,
          sets: ex.sets.filter((x) => x.done).map((x) => ({
            weight_kg: x.weight === "" ? null : Number(x.weight),
            reps: x.reps === "" ? null : Number(x.reps),
          })),
        })),
      };
    };

    const saveLog = async (feedback) => {
      const s = state.workoutSession;
      const log = buildLog();
      await sb.from("workout_logs").insert({
        user_id: state.user.id,
        plan_id: state.planRow?.id || null,
        workout_key: s.workoutKey,
        log, feedback,
      });
      return log;
    };

    overlay.querySelector("#skipFeedback").onclick = async () => {
      overlay.remove();
      try { await saveLog(null); } catch (_) { /* ekkert */ }
      state.workoutSession = null;
      renderMain("home");
    };

    overlay.querySelector("#sendFeedback").onclick = async () => {
      const feedback = {
        difficulty: rpeRow.querySelector(".chip.selected")?.dataset.val,
        comment: overlay.querySelector("#fbComment").value.trim(),
      };
      overlay.remove();
      renderGenerating("Þjálfarinn fer yfir æfinguna þína…");
      try {
        const log = await saveLog(feedback);
        const res = await aiCall({ mode: "checkin", workoutLog: log, feedback });
        state.workoutSession = null;
        await loadUserData();
        showAiModal(res.message + (res.plan ? "\n\n📋 Planið þitt var uppfært!" : ""), () => renderMain("home"));
      } catch (e) {
        state.workoutSession = null;
        showAiModal("Æfingin var vistuð en ekki náðist í þjálfarann: " + (e.message || "villa"), () => renderMain("home"));
      }
    };
  }

  // ---------- AI svar-modal ----------
  function showAiModal(message, onClose) {
    const overlay = el(`
      <div class="modal-overlay">
        <div class="modal">
          <h2>Þjálfarinn 🤖</h2>
          <p class="ai-message">${esc(message)}</p>
          <button class="btn" id="aiOk">Loka</button>
        </div>
      </div>`);
    document.body.appendChild(overlay);
    overlay.querySelector("#aiOk").onclick = () => {
      overlay.remove();
      if (onClose) onClose();
    };
  }

  // ---------- Framvinda ----------
  // Einfalt línurit sem SVG (engin utanaðkomandi söfn)
  function lineChart(points) {
    if (points.length < 2) {
      return `<p class="workout-meta">Þarf a.m.k. 2 skráningar til að teikna graf</p>`;
    }
    const W = 320, H = 150, P = 26;
    const vals = points.map((p) => p.v);
    const min = Math.min(...vals), max = Math.max(...vals);
    const span = max - min || 1;
    const x = (i) => P + (i * (W - 2 * P)) / (points.length - 1);
    const y = (v) => H - P - ((v - min) * (H - 2 * P)) / span;
    const line = points.map((p, i) => `${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
    const dots = points.map((p, i) =>
      `<circle cx="${x(i).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="3.5" fill="#34d399"/>`).join("");
    const last = points[points.length - 1];
    return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto" xmlns="http://www.w3.org/2000/svg">
      <line x1="${P}" y1="${H - P}" x2="${W - P}" y2="${H - P}" stroke="#2c313c"/>
      <polyline points="${line}" fill="none" stroke="#34d399" stroke-width="2.5" stroke-linejoin="round"/>
      ${dots}
      <text x="${P}" y="${y(points[0].v) - 8}" fill="#9aa3b2" font-size="11">${points[0].v} kg</text>
      <text x="${x(points.length - 1)}" y="${y(last.v) - 8}" fill="#f2f4f8" font-size="12" font-weight="700" text-anchor="end">${last.v} kg</text>
      <text x="${P}" y="${H - 8}" fill="#9aa3b2" font-size="10">${esc(fmtDate(points[0].d))}</text>
      <text x="${W - P}" y="${H - 8}" fill="#9aa3b2" font-size="10" text-anchor="end">${esc(fmtDate(last.d))}</text>
    </svg>`;
  }

  async function renderProgress(root) {
    root.innerHTML = `<h1>Framvinda 📈</h1>
      <div class="card">
        <button class="btn" id="weeklyBtn" style="margin-top:0">📋 Vikuyfirlit frá þjálfaranum</button>
        <div id="weeklyStatus"></div>
      </div>
      <h2>Líkamsþyngd</h2>
      <div class="card">
        <div class="weight-input-row">
          <input id="newWeight" type="number" inputmode="decimal" step="0.1" placeholder="Þyngd (kg)">
          <button class="btn" id="logWeight">Skrá</button>
        </div>
        <div id="weightList" style="margin-top:10px"></div>
      </div>
      <h2>Þyngdarsaga æfinga</h2>
      <div class="card" id="exHistoryCard"><div class="ai-thinking"><div class="spinner"></div>Hleð…</div></div>
      <h2>Síðustu æfingar</h2>
      <div id="logList"><div class="ai-thinking"><div class="spinner"></div>Hleð…</div></div>`;

    document.getElementById("weeklyBtn").onclick = async () => {
      const btn = document.getElementById("weeklyBtn");
      const status = document.getElementById("weeklyStatus");
      btn.disabled = true;
      status.innerHTML = `<div class="ai-thinking"><div class="spinner"></div>Þjálfarinn tekur saman vikuna…</div>`;
      try {
        const res = await aiCall({ mode: "weekly" });
        status.innerHTML = "";
        state.chatLoaded = false; // yfirlitið vistast líka í spjallinu
        showAiModal(res.message);
      } catch (e) {
        status.innerHTML = `<div class="error-msg">${esc(e.message || "Villa")}</div>`;
      }
      btn.disabled = false;
    };

    const loadWeights = async () => {
      const { data } = await sb.from("weight_logs").select("weight_kg, created_at")
        .eq("user_id", state.user.id).order("created_at", { ascending: false }).limit(10);
      const listEl = document.getElementById("weightList");
      if (!data?.length) { listEl.innerHTML = `<p class="workout-meta">Engin skráning enn</p>`; return; }
      listEl.innerHTML = data.map((w, i) => {
        const diff = i < data.length - 1 ? (w.weight_kg - data[i + 1].weight_kg) : null;
        const diffStr = diff === null || diff === 0 ? "" :
          ` <span style="color:${diff < 0 ? "var(--accent)" : "var(--warn)"}">(${diff > 0 ? "+" : ""}${diff.toFixed(1)})</span>`;
        return `<div class="stat-row"><span class="dim">${fmtDate(w.created_at)}</span><span><b>${Number(w.weight_kg).toFixed(1)} kg</b>${diffStr}</span></div>`;
      }).join("");
    };
    loadWeights();

    document.getElementById("logWeight").onclick = async () => {
      const v = document.getElementById("newWeight").value;
      if (!v) return;
      await sb.from("weight_logs").insert({ user_id: state.user.id, weight_kg: Number(v) });
      document.getElementById("newWeight").value = "";
      loadWeights();
    };

    const { data: logs } = await sb.from("workout_logs").select("workout_key, log, feedback, created_at")
      .eq("user_id", state.user.id).order("created_at", { ascending: false }).limit(60);

    // Þyngdarsaga æfinga: mesta þyngd í hverri æfingu yfir tíma
    const exHistory = {};
    for (const l of [...(logs || [])].reverse()) {
      for (const ex of l.log?.exercises || []) {
        const maxW = Math.max(0, ...(ex.sets || []).map((s) => Number(s.weight_kg) || 0));
        if (maxW > 0) {
          (exHistory[ex.name] = exHistory[ex.name] || []).push({ d: l.created_at, v: maxW });
        }
      }
    }
    const exNames = Object.keys(exHistory)
      .sort((a, b) => exHistory[b].length - exHistory[a].length);
    const histCard = document.getElementById("exHistoryCard");
    if (!exNames.length) {
      histCard.innerHTML = `<p class="workout-meta">Kláraðu æfingar með skráðum þyngdum til að sjá graf</p>`;
    } else {
      histCard.innerHTML = `
        <select id="exSelect">${exNames.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join("")}</select>
        <div id="exChart" style="margin-top:12px"></div>`;
      const drawChart = () => {
        const name = document.getElementById("exSelect").value;
        const pts = exHistory[name];
        const best = Math.max(...pts.map((p) => p.v));
        document.getElementById("exChart").innerHTML =
          lineChart(pts) +
          `<div class="stat-row"><span class="dim">Besta þyngd</span><span><b>${best} kg</b></span></div>
           <div class="stat-row"><span class="dim">Skipti skráð</span><span>${pts.length}</span></div>`;
      };
      document.getElementById("exSelect").onchange = drawChart;
      drawChart();
    }

    const logList = document.getElementById("logList");
    if (!logs?.length) {
      logList.innerHTML = `<div class="card"><p class="workout-meta">Engar æfingar skráðar enn — drífðu þig af stað! 💪</p></div>`;
      return;
    }
    logList.innerHTML = logs.slice(0, 15).map((l) => {
      const setCount = (l.log?.exercises || []).reduce((acc, ex) => acc + (ex.sets?.length || 0), 0);
      return `<div class="card">
        <div class="exercise-title">${esc(l.log?.workout_name || l.workout_key)}</div>
        <div class="workout-meta">${fmtDate(l.created_at)} · ${setCount} sett${l.log?.duration_min ? ` · ${l.log.duration_min} mín` : ""}${l.feedback?.difficulty ? ` · ${esc(l.feedback.difficulty)}` : ""}</div>
      </div>`;
    }).join("");
  }

  // ---------- Spjall ----------
  async function renderChat(root) {
    root.innerHTML = `<h1>Spjall við þjálfarann 💬</h1>
      <div class="chat-list" id="chatList"><div class="ai-thinking"><div class="spinner"></div>Hleð…</div></div>
      <div class="chat-input-row">
        <textarea id="chatInput" placeholder="Spurðu um æfingar, mataræði, planið..."></textarea>
        <button id="chatSend">➤</button>
      </div>`;

    if (!state.chatLoaded) {
      const { data } = await sb.from("chat_messages").select("role, content, created_at")
        .eq("user_id", state.user.id).order("created_at", { ascending: true }).limit(50);
      state.chat = data || [];
      state.chatLoaded = true;
    }
    const listEl = document.getElementById("chatList");
    const draw = () => {
      listEl.innerHTML = state.chat.length
        ? state.chat.map((m) => `<div class="chat-msg ${m.role}">${esc(m.content)}</div>`).join("")
        : `<div class="chat-msg assistant">Halló! Ég er þjálfarinn þinn. Spurðu mig um hvað sem er — æfingar, tækni, mataræði eða breytingar á planinu þínu. 💪</div>`;
      window.scrollTo(0, document.body.scrollHeight);
    };
    draw();

    const send = async () => {
      const input = document.getElementById("chatInput");
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      state.chat.push({ role: "user", content: text });
      draw();
      listEl.insertAdjacentHTML("beforeend",
        `<div class="ai-thinking" id="thinking"><div class="spinner"></div>Þjálfarinn hugsar…</div>`);
      window.scrollTo(0, document.body.scrollHeight);
      try {
        const res = await aiCall({ mode: "chat", message: text });
        document.getElementById("thinking")?.remove();
        state.chat.push({ role: "assistant", content: res.message });
        if (res.plan) {
          await loadUserData();
          state.chat.push({ role: "assistant", content: "📋 Planið þitt var uppfært!" });
        }
        draw();
      } catch (e) {
        document.getElementById("thinking")?.remove();
        state.chat.push({ role: "assistant", content: "Villa: " + (e.message || "náði ekki sambandi") });
        draw();
      }
    };
    document.getElementById("chatSend").onclick = send;
    document.getElementById("chatInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
    });
  }

  // ---------- Stillingar ----------
  function showSettings() {
    const overlay = el(`
      <div class="modal-overlay">
        <div class="modal">
          <h2>Stillingar ⚙️</h2>
          <p class="workout-meta" style="margin-bottom:14px">${esc(state.user?.email || "")}</p>
          <button class="btn secondary" id="editProfile">Breyta prófíl / nýtt plan</button>
          <button class="btn danger" id="logout">Skrá út</button>
          <button class="link-btn" id="closeSettings">Loka</button>
        </div>
      </div>`);
    document.body.appendChild(overlay);
    overlay.querySelector("#closeSettings").onclick = () => overlay.remove();
    overlay.querySelector("#editProfile").onclick = () => { overlay.remove(); renderOnboarding(); };
    overlay.querySelector("#logout").onclick = async () => {
      overlay.remove();
      await sb.auth.signOut();
    };
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  }

  // ---------- Ræsing ----------
  async function onAuthed(user) {
    state.user = user;
    await loadUserData();
    if (!state.planRow) renderOnboarding();
    else renderMain("home");
  }

  sb.auth.onAuthStateChange((event, session) => {
    if (event === "SIGNED_OUT") {
      state.user = null; state.profile = null; state.planRow = null;
      state.chat = []; state.chatLoaded = false; state.workoutSession = null;
      renderAuth();
    }
  });

  (async () => {
    const { data } = await sb.auth.getSession();
    if (data?.session?.user) await onAuthed(data.session.user);
    else renderAuth();

    // Hlusta á innskráningu (eftir renderAuth)
    sb.auth.onAuthStateChange(async (event, session) => {
      if (event === "SIGNED_IN" && session?.user && !state.user) {
        await onAuthed(session.user);
      }
    });
  })();

  // Service worker
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
