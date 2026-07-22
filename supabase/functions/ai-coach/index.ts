// Þjálfarinn — AI edge function (Supabase Edge Functions / Deno)
// Talar við Google Gemini API (ókeypis þrep dugar vel fyrir einn notanda).
// API-lykillinn er geymdur sem secret í Supabase (GEMINI_API_KEY)
// og fer aldrei í vafrann.

import { createClient } from "npm:@supabase/supabase-js@2";

// Reynt í þessari röð — ef módel hverfur (404) er næsta prófað sjálfkrafa
const GEMINI_MODELS = ["gemini-flash-latest", "gemini-3.1-flash", "gemini-3.1-flash-lite"];

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Svarskema (OpenAPI-snið sem Gemini structured output notar)
const EXERCISE_SCHEMA = {
  type: "object",
  required: ["name", "sets", "reps", "weight_kg", "rest_sec", "notes", "video_query"],
  properties: {
    name: { type: "string" },
    sets: { type: "integer" },
    reps: { type: "string", description: "T.d. '8-10' eða '12'" },
    weight_kg: { type: "number", nullable: true, description: "null = líkamsþyngd/óákveðið" },
    rest_sec: { type: "integer" },
    notes: { type: "string", description: "Stutt leiðbeining, má vera tómur strengur" },
    video_query: { type: "string", description: "Enskt heiti æfingarinnar fyrir myndbandsleit, t.d. 'Seated Machine Chest Press'" },
  },
};

const PLAN_SCHEMA = {
  type: "object",
  nullable: true,
  required: ["name", "days_per_week", "workouts", "notes"],
  properties: {
    name: { type: "string" },
    days_per_week: { type: "integer" },
    notes: { type: "string" },
    workouts: {
      type: "array",
      items: {
        type: "object",
        required: ["key", "name", "exercises"],
        properties: {
          key: { type: "string", description: "Stutt auðkenni, t.d. 'a', 'b', 'c'" },
          name: { type: "string", description: "T.d. 'Dagur A – Ýtingar'" },
          exercises: { type: "array", items: EXERCISE_SCHEMA },
        },
      },
    },
  },
};

const RESPONSE_SCHEMA = {
  type: "object",
  required: ["message", "plan", "alternatives"],
  properties: {
    message: { type: "string", description: "Skilaboð til notandans á íslensku" },
    plan: PLAN_SCHEMA,
    alternatives: {
      type: "array",
      nullable: true,
      description: "Aðeins í swap-ham: 4-6 æfingar sem þjálfa sömu vöðva. Annars null.",
      items: EXERCISE_SCHEMA,
    },
  },
};

function systemPrompt(profile: unknown, plan: unknown, recentLogs: unknown, weights: unknown): string {
  return `Þú ert "Þjálfarinn", persónulegur AI-einkaþjálfari í íslensku æfingaappi (svipað MyFitCoach).

Hlutverk þitt:
- Búa til og viðhalda persónulegu æfingaplani út frá markmiðum, reynslu, búnaði og tíma notandans.
- Eftir hverja æfingu færðu endurgjöf (hversu erfitt, athugasemdir) og skráð sett/þyngdir. Notaðu það til að stilla þyngdir, sett og endurtekningar í planinu — auka álag þegar æfing var of létt, minnka eða halda þegar hún var of erfið (progressive overload, litlar skynsamlegar breytingar, t.d. +2,5 kg).
- Svara spurningum um þjálfun, tækni, mataræði og endurheimt, stutt og hagnýtt.

Reglur:
- Svaraðu ALLTAF á íslensku, hlýlega en hnitmiðað.
- Skilaðu "plan" AÐEINS þegar á að breyta planinu (nýtt plan, breyttar þyngdir/æfingar). Annars plan = null.
- Þegar þú skilar plani skaltu skila ÖLLU planinu (allir dagar, allar æfingar), ekki bara breytingunum.
- Notaðu æfingar sem passa við búnað notandans. Reps sem bil, t.d. "8-10". Hvíld í sekúndum.
- Fyrir hverja æfingu: settu nákvæmt enskt heiti hennar í video_query (t.d. "Lat Pulldown", "Dumbbell Lateral Raise") svo hægt sé að finna sýnikennslumyndband.
- Öryggi fyrst: engin óraunhæf stökk í þyngdum, minntu á upphitun og tækni þegar við á.

Gögn um notandann:
PRÓFÍLL: ${JSON.stringify(profile ?? {})}
VIRKT PLAN: ${JSON.stringify(plan ?? null)}
SÍÐUSTU ÆFINGAR (nýjast fyrst): ${JSON.stringify(recentLogs ?? [])}
LÍKAMSÞYNGD (nýjast fyrst): ${JSON.stringify(weights ?? [])}`;
}

async function callGemini(
  system: string,
  history: { role: string; content: string }[],
  userMessage: string,
): Promise<{ message: string; plan: Record<string, unknown> | null }> {
  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) throw new Error("GEMINI_API_KEY vantar í Edge Function secrets");

  const contents = [
    ...history.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    })),
    { role: "user", parts: [{ text: userMessage }] },
  ];

  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: system }] },
    contents,
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
      maxOutputTokens: 16384,
    },
  });

  let res: Response | null = null;
  for (const model of GEMINI_MODELS) {
    res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body,
      },
    );
    if (res.status !== 404) break; // 404 = módel ekki til, prófa næsta
    console.error(`Gemini módel '${model}' fannst ekki (404), prófa næsta...`);
  }

  if (!res || !res.ok) {
    const errText = res ? await res.text() : "ekkert svar";
    console.error("Gemini villa:", res?.status, errText);
    if (res?.status === 429) {
      throw new Error("AI-þjálfarinn er upptekinn (dagskvóti eða hraðatakmörk hjá Gemini) — reyndu aftur eftir smá stund");
    }
    if (res?.status === 404) {
      throw new Error("Ekkert Gemini-módel fannst — láttu Markús/Claude vita svo hægt sé að uppfæra módellistann");
    }
    throw new Error(`Gemini API villa (${res?.status})`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("");
  if (!text) {
    console.error("Tómt svar frá Gemini:", JSON.stringify(data).slice(0, 500));
    throw new Error("Ekkert svar frá AI");
  }
  const parsed = JSON.parse(text);
  return {
    message: String(parsed.message ?? ""),
    plan: parsed.plan ?? null,
    alternatives: Array.isArray(parsed.alternatives) ? parsed.alternatives : null,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );

    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError || !userData?.user) {
      return new Response(JSON.stringify({ error: "Óheimill aðgangur" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userId = userData.user.id;

    const body = await req.json();
    const mode: string = body.mode; // "plan" | "checkin" | "chat"

    // Sækja samhengi (RLS tryggir að notandi sér bara sín gögn)
    const [profileRes, planRes, logsRes, weightsRes, chatRes] = await Promise.all([
      supabase.from("profiles").select("data").eq("user_id", userId).maybeSingle(),
      supabase.from("plans").select("id, plan").eq("user_id", userId).eq("active", true)
        .order("created_at", { ascending: false }).limit(1).maybeSingle(),
      supabase.from("workout_logs").select("workout_key, log, feedback, created_at")
        .eq("user_id", userId).order("created_at", { ascending: false }).limit(6),
      supabase.from("weight_logs").select("weight_kg, created_at")
        .eq("user_id", userId).order("created_at", { ascending: false }).limit(10),
      supabase.from("chat_messages").select("role, content")
        .eq("user_id", userId).order("created_at", { ascending: false }).limit(12),
    ]);

    const profile = body.profile ?? profileRes.data?.data;
    const activePlan = planRes.data?.plan ?? null;
    const chatHistory = (chatRes.data ?? []).reverse();

    let userMessage: string;
    if (mode === "plan") {
      userMessage =
        "Búðu til nýtt æfingaplan fyrir mig út frá prófílnum mínum. Útskýrðu planið stuttlega í message og skilaðu því í plan.";
      if (body.message) userMessage += `\nAthugasemd frá mér: ${body.message}`;
    } else if (mode === "swap") {
      userMessage = `Ég er í ræktinni og æfingin/tækið "${String(body.exerciseName ?? "")}" er ekki í boði núna.
Komdu með 4-6 aðrar æfingar sem þjálfa SÖMU vöðva, með áherslu á það sem líklegast er til í venjulegri (jafnvel lítilli) líkamsræktarstöð — og taktu tillit til búnaðarins í prófílnum mínum og meiðsla ef einhver eru.
Skilaðu þeim í "alternatives" með sets/reps/þyngd/hvíld/video_query eins og vanalega (svipað álag og upprunalega æfingin). plan á að vera null. Hafðu message mjög stutt.`;
    } else if (mode === "checkin") {
      userMessage = `Ég var að klára æfingu. Hér er það sem ég skráði:
ÆFING: ${JSON.stringify(body.workoutLog ?? {})}
ENDURGJÖF: ${JSON.stringify(body.feedback ?? {})}
Farðu yfir þetta, gefðu mér stutta endurgjöf og uppfærðu planið (þyngdir/sett/reps) ef tilefni er til.`;
    } else {
      userMessage = String(body.message ?? "");
    }
    if (!userMessage) {
      return new Response(JSON.stringify({ error: "Vantar skilaboð" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const result = await callGemini(
      systemPrompt(profile, activePlan, logsRes.data, weightsRes.data),
      mode === "chat" ? chatHistory : [],
      userMessage,
    );

    // Vista uppfært plan ef AI skilaði því
    let savedPlan = null;
    if (result.plan) {
      await supabase.from("plans").update({ active: false })
        .eq("user_id", userId).eq("active", true);
      const { data: inserted, error: insertError } = await supabase
        .from("plans")
        .insert({ user_id: userId, plan: result.plan, active: true })
        .select("id, plan")
        .single();
      if (insertError) throw insertError;
      savedPlan = inserted;
    }

    // Vista spjallsögu (chat og checkin birtast í spjallinu)
    if (mode === "chat" || mode === "checkin") {
      const userContent = mode === "chat"
        ? String(body.message)
        : "(Kláraði æfingu og sendi endurgjöf)";
      await supabase.from("chat_messages").insert([
        { user_id: userId, role: "user", content: userContent },
        { user_id: userId, role: "assistant", content: result.message },
      ]);
    }

    return new Response(
      JSON.stringify({
        message: result.message,
        plan: savedPlan?.plan ?? null,
        alternatives: result.alternatives ?? null,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("ai-coach villa:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Óþekkt villa" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
