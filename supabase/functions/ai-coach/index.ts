// Þjálfarinn — AI edge function (Supabase Edge Functions / Deno)
// Talar við Claude API. API-lykillinn er geymdur sem secret í Supabase
// (ANTHROPIC_API_KEY) og fer aldrei í vafrann.

import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const EXERCISE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "sets", "reps", "weight_kg", "rest_sec", "notes"],
  properties: {
    name: { type: "string" },
    sets: { type: "integer" },
    reps: { type: "string", description: "T.d. '8-10' eða '12'" },
    weight_kg: { anyOf: [{ type: "number" }, { type: "null" }], description: "null = líkamsþyngd/óákveðið" },
    rest_sec: { type: "integer" },
    notes: { type: "string", description: "Stutt leiðbeining, má vera tómur strengur" },
  },
};

const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "days_per_week", "workouts", "notes"],
  properties: {
    name: { type: "string" },
    days_per_week: { type: "integer" },
    notes: { type: "string" },
    workouts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
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
  additionalProperties: false,
  required: ["message", "plan"],
  properties: {
    message: { type: "string", description: "Skilaboð til notandans á íslensku" },
    plan: {
      anyOf: [{ type: "null" }, PLAN_SCHEMA],
      description: "Nýtt/uppfært plan, eða null ef planið á að haldast óbreytt",
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
- Öryggi fyrst: engin óraunhæf stökk í þyngdum, minntu á upphitun og tækni þegar við á.

Gögn um notandann:
PRÓFÍLL: ${JSON.stringify(profile ?? {})}
VIRKT PLAN: ${JSON.stringify(plan ?? null)}
SÍÐUSTU ÆFINGAR (nýjast fyrst): ${JSON.stringify(recentLogs ?? [])}
LÍKAMSÞYNGD (nýjast fyrst): ${JSON.stringify(weights ?? [])}`;
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

    const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY")! });

    const messages: { role: "user" | "assistant"; content: string }[] = [];
    if (mode === "chat") {
      for (const m of chatHistory) {
        messages.push({ role: m.role as "user" | "assistant", content: m.content });
      }
    }
    messages.push({ role: "user", content: userMessage });

    const response = await anthropic.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      system: systemPrompt(profile, activePlan, logsRes.data, weightsRes.data),
      messages,
      output_config: { format: { type: "json_schema", schema: RESPONSE_SCHEMA } },
    });

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error("Ekkert svar frá AI");
    }
    const result = JSON.parse(textBlock.text) as {
      message: string;
      plan: Record<string, unknown> | null;
    };

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
      JSON.stringify({ message: result.message, plan: savedPlan?.plan ?? null }),
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
