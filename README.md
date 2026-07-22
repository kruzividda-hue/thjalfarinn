# Þjálfarinn 🏋️

Persónulegur AI-æfingaþjálfari — vefapp (PWA) fyrir iPhone, innblásið af MyFitCoach.

- **AI-þjálfari (Claude)** býr til æfingaplan út frá markmiðum þínum, reynslu og búnaði
- Eftir hverja æfingu svarar þú hvernig gekk og AI-ið **uppfærir þyngdir og planið**
- **Innskráning** og öll gögn geymd í **Supabase** (aðeins þú sérð þín gögn)
- Æfingaskráning með settum, þyngdum og **hvíldartíma**
- Framvinda: líkamsþyngd og æfingasaga
- Spjall við þjálfarann um æfingar, tækni og mataræði

## Tækni

| Hluti | Lausn |
|---|---|
| Framendi | Vanilla JS PWA, hýst á GitHub Pages |
| Innskráning + gagnagrunnur | Supabase (Auth + Postgres með Row Level Security) |
| AI | Google Gemini API (gemini-2.5-flash, ókeypis þrep) í gegnum Supabase Edge Function — API-lykillinn fer aldrei í vafrann |

## Uppsetning (gerist einu sinni)

### 1. Stofna Supabase-verkefni

1. Farðu á [supabase.com](https://supabase.com) og skráðu þig inn / stofnaðu aðgang (frítt).
2. **New project** → veldu nafn (t.d. `thjalfarinn`) og lykilorð fyrir gagnagrunninn.
3. Þegar verkefnið er tilbúið: **SQL Editor** → **New query** → límdu inn allt innihald [`supabase/schema.sql`](supabase/schema.sql) → **Run**.
4. (Valfrjálst en þægilegt) **Authentication → Sign In / Up → Email** → slökktu á **Confirm email** svo þú þurfir ekki að staðfesta netfangið.

### 2. Setja stillingar í appið

1. Í Supabase: **Project Settings → API** (eða "Data API").
2. Afritaðu **Project URL** og **anon public** lykilinn.
3. Settu bæði inn í [`js/config.js`](js/config.js) og ýttu breytingunni á GitHub.

### 3. Setja upp AI-fallið (Edge Function)

1. Náðu í ókeypis Gemini API-lykil á [aistudio.google.com/apikey](https://aistudio.google.com/apikey) (innskráning með Google-aðgangi → **Create API key**).
2. Í Supabase: **Edge Functions → Secrets** → bættu við secret með nafninu `GEMINI_API_KEY` og límdu lykilinn inn.
3. **Edge Functions → Deploy a new function** (í vafranum, "Via Editor"):
   - Nafn: `ai-coach`
   - Límdu inn allt innihald [`supabase/functions/ai-coach/index.ts`](supabase/functions/ai-coach/index.ts)
   - **Deploy**

   *Eða með Supabase CLI:*
   ```bash
   supabase functions deploy ai-coach --project-ref <PROJECT_REF>
   ```

### 4. Opna appið á iPhone

1. Opnaðu vefslóðina (GitHub Pages) í **Safari**.
2. **Deila-hnappurinn → Add to Home Screen** — þá hegðar appið sér eins og venjulegt app.

## Notkun

1. Skráðu þig inn. (Nýskráning er lokuð — nýir notendur eru stofnaðir handvirkt í Supabase: **Authentication → Users → Add user → Create new user**, með haki í "Auto Confirm User". Lokaðu líka á opnar nýskráningar undir **Project Settings → Authentication → Allow new users to sign up = off**.)
2. Svaraðu spurningalistanum (markmið, reynsla, búnaður, dagar í viku...).
3. AI-þjálfarinn býr til planið þitt.
4. Byrjaðu æfingu, skráðu þyngdir og reps, hakaðu við sett (hvíldartími fer sjálfkrafa í gang).
5. Í lok æfingar: segðu hvernig gekk — þjálfarinn aðlagar planið fyrir næstu æfingu.
6. Notaðu **Spjall** til að biðja um breytingar ("bættu við meiri axlaæfingum") eða spyrja spurninga.

## Skráaryfirlit

```
index.html                          Skel appsins
css/style.css                       Útlit
js/app.js                           Öll virkni (auth, plan, æfingar, spjall)
js/config.js                        Supabase-stillingar (fylla út!)
sw.js, manifest.webmanifest, icons/ PWA-hlutir
supabase/schema.sql                 Gagnagrunnsskema + RLS
supabase/functions/ai-coach/        Edge Function sem talar við Claude API
```

## Kostnaður

- Supabase: frítt (free tier dugar vel fyrir einn notanda)
- GitHub Pages: frítt
- Gemini API: ókeypis þrepið dugar vel fyrir persónulega notkun (nokkur hundruð köll á dag á gemini-2.5-flash). Athugið: á ókeypis þrepinu má Google nota gögnin til að bæta sín módel.
