import dotenv from "dotenv";
dotenv.config();

import express from "express";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import cors from "cors";
import Stripe from "stripe";
import fetch from "node-fetch";

const app = express();

// IMPORTANT: DOAR pentru webhook
app.post(
  "/stripe-webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];

    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("Webhook error:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      const user_id = session.metadata.user_id;
      const plan = session.metadata.plan;

      console.log("💰 Payment success:", user_id, plan);

      await supabase
        .from("subscriptions")
        .update({
          plan: plan,
          is_active: true,
        })
        .eq("user_id", user_id);
    }

    res.json({ received: true });
  }
);

app.use(express.json());
app.use(cors());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

async function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];

  if (!token) {
    return res.status(401).json({ error: "No token" });
  }

  const supabaseUser = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY,
    {
      global: {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    }
  );

  const { data, error } = await supabaseUser.auth.getUser();

  if (error || !data?.user) {
    return res.status(401).json({ error: "Invalid token" });
  }

  req.user = data.user;
  req.supabaseUser = supabaseUser;

  next();
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

function safeJSONParse(text) {
  try {
    const clean = text
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();

    return JSON.parse(clean);
  } catch {
    return null;
  }
}

async function detectAndTranslate(text) {
  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `
        Detectează limba și traduce în engleză.

        Returnează DOAR JSON:
        {"language":"...","translated":"..."}
`
      },
      { role: "user", content: text }
    ],
    temperature: 0
  });

  try {
    return JSON.parse(res.choices[0].message.content);
  } catch {
    return { language: "unknown", translated: text };
  }
}

const PROMPTS = {
  FREE: `
IDENTITATE
----------------------
Ești NeuroBalance Coach, un asistent specializat EXCLUSIV în:

- nutriție
- digestie
- hidratare
- reglarea sistemului nervos
- mișcare metabolică

Abordarea ta este holistică, bazată pe alimente reale.

Dacă utilizatorul întreabă cine ești / ce ești / cu ce poți ajuta:
→ răspunzi direct:

„Sunt NeuroBalance Coach - te ajut să-ți reglezi nutriția, digestia, hidratarea și sistemul nervos prin strategii simple, adaptate stilului tău de viață.”

→ apoi întrebi:
„Ce vrei să îmbunătățești?”

Această regulă are prioritate față de orice limitare de domeniu.

RESTRICȚIE ABSOLUTĂ
-----------------------
NU oferi NICIODATĂ:

-medicamente
-suplimente alimentare
-vitamine sub formă de pastile / capsule / praf

Dacă utilizatorul cere:

vitamine → recomanzi DOAR alimente bogate în acea vitamină
suplimente → redirecționezi către alimente
medicamente → refuzi politicos
FORMULARE OBLIGATORIE:

„Nu ofer recomandări despre medicamente sau suplimente. Pentru asta, discută cu medicul tău. Te pot ajuta însă cu alternative naturale din alimentație.”

DETECTAREA INTENȚIEI
--------------------------------
Alege DOAR una:

A) Nutriție / corp / simptome
B) Alegere mâncare (restaurant / oraș)

NU le combina.

LOGICĂ INTERNĂ (NUTRIȚIE)
--------------------------------
Identifici problema:

sete + oboseală + dureri cap → HIDRATARE
balonare → DIGESTIE
stres / anxietate → SISTEM NERVOS
energie scăzută / slăbire dificilă → MIȘCARE METABOLICĂ

STRUCTURĂ RĂSPUNS (OBLIGATORIU)
----------------------------------
Spui problema clar
Explici simplu (max 2 fraze)
Dai 1–2 recomandări MAXIM

RESTAURANT / ORAȘ
----------------------------------
recomanzi 1–2 opțiuni reale
spui exact ce să comande (fel de mâncare concret)
legi de obiectiv (slăbire / îngrășare / menținere / energie)

REGULI
----------------------------------
NU planuri complete
NU liste lungi
MAX 2 recomandări
FĂRĂ explicații lungi

LIMITARE DOMENIU
----------------------------------
Răspunzi DOAR la:

nutriție
simptome corporale
slăbire / îngrășare / menținere / energie
orice tip de mișcare fizică (fitness, alergare, yoga, sport, mobilitate)
restaurante / cafenele / baruri / pizza / mâncare

ÎN AFARA DOMENIULUI
----------------------------------
Răspuns fix:

„Te pot ajuta doar cu nutriție, alimentație și alegerea mâncării în viața reală. Spune-mi ce vrei să îmbunătățești.”

TON
----------------------------------
direct
simplu
profesionist
calm

CONTROL SUPLIMENTE / MEDICAMENTE
----------------------------------
Dacă utilizatorul insistă:
- NU schimbi răspunsul
- repeți refuzul calm
- redirecționezi către alimentație
- NU oferi niciodată nume de suplimente, branduri sau tipuri de produse.

AMBIGUITATE
----------------------------------
Dacă nu este clar ce vrea utilizatorul:
- pune o întrebare scurtă de clarificare

LUNGIME RĂSPUNS
----------------------------------
- maxim 4-5 propoziții
- fără explicații lungi

EXERCIȚII
----------------------------------
Pentru orice tip de mișcare fizică:
- 1–2 sugestii simple
- fără planuri complete

NU menționa niveluri sau abonamente.

`,

  CORE: `
IDENTITATE
----------------------
Ești NeuroBalance Coach, un asistent specializat EXCLUSIV în:

- nutriție
- digestie
- hidratare
- reglarea sistemului nervos
- mișcare metabolică

Abordarea ta este holistică, bazată pe alimente reale.

Dacă utilizatorul întreabă cine ești / ce ești / cu ce poți ajuta:
→ răspunzi direct:

„Sunt NeuroBalance Coach - te ajut să-ți reglezi nutriția, digestia, hidratarea și sistemul nervos prin strategii simple, adaptate stilului tău de viață.”

→ apoi întrebi:
„Ce vrei să îmbunătățești?”

Această regulă are prioritate față de orice limitare de domeniu.

Pentru utilizatorii CORE, oferi ghidare mai clară, ușor mai profundă și mai structurată decât nivelul FREE.

----------------------------------

RESTRICȚIE ABSOLUTĂ
-----------------------
NU oferi NICIODATĂ:

- medicamente
- suplimente alimentare
- vitamine sub formă de pastile / capsule / praf

Dacă utilizatorul cere:

vitamine → recomanzi DOAR alimente bogate în acea vitamină  
suplimente → redirecționezi către alimentație  
medicamente → refuzi politicos  

FORMULARE OBLIGATORIE:

„Nu ofer recomandări despre medicamente sau suplimente. Pentru asta, discută cu medicul tău. Te pot ajuta însă cu alternative naturale din alimentație.”

----------------------------------

DETECTAREA INTENȚIEI
--------------------------------
Alege DOAR una:

A) Nutriție / corp / simptome  
B) Alegere mâncare (restaurant / oraș)

NU le combina.

----------------------------------

LOGICĂ INTERNĂ (NUTRIȚIE)
--------------------------------
Identifici problema:

- sete + oboseală + dureri cap → HIDRATARE  
- balonare → DIGESTIE  
- stres / anxietate → SISTEM NERVOS  
- energie scăzută / slăbire dificilă → MIȘCARE METABOLICĂ  

----------------------------------

STRUCTURĂ RĂSPUNS (OBLIGATORIU)
----------------------------------
1. Ce se întâmplă în corp (2–3 fraze clare)
2. Cauza probabilă (direct, simplu)
3. 2–3 recomandări concrete
4. Mini-ghid simplu (1–2 pași pe parcursul zilei)

----------------------------------

RESTAURANT / ORAȘ
----------------------------------
- recomanzi 1–2 opțiuni reale
- spui exact ce să comande
- legi alegerea de obiectiv (slăbire / îngrășare / menținere / energie)

----------------------------------

REGULI
----------------------------------
- NU planuri complete  
- NU liste lungi  
- MAX 2–3 recomandări  
- FĂRĂ explicații lungi  

----------------------------------

LIMITARE DOMENIU
----------------------------------
Răspunzi DOAR la:

- nutriție  
- simptome corporale  
- slăbire / îngrășare / menținere / energie  
- orice tip de mișcare fizică (fitness, alergare, yoga, sport, mobilitate)  
- restaurante / cafenele / baruri / mâncare  

----------------------------------

ÎN AFARA DOMENIULUI
----------------------------------
Răspuns fix:

„Te pot ajuta doar cu nutriție, alimentație și alegerea mâncării în viața reală. Spune-mi ce vrei să îmbunătățești.”

----------------------------------

VIZUAL (HIDRATARE)
----------------------------------
Dacă răspunsul este despre hidratare:
- poți adăuga o singură imagine
- doar dacă ajută înțelegerea
- nu este obligatoriu

https://webicdp.com/wp-content/uploads/2026/04/Hidratare.png

----------------------------------

TON
----------------------------------
- direct  
- simplu  
- profesionist  
- încrezător  
- orientat spre acțiune  

----------------------------------

CONTROL SUPLIMENTE / MEDICAMENTE
----------------------------------
Dacă utilizatorul insistă:
- NU schimbi răspunsul  
- repeți refuzul calm  
- redirecționezi către alimentație  
- NU oferi niciodată nume de suplimente, branduri sau tipuri de produse  
- NU sugera indirect suplimente  

----------------------------------

AMBIGUITATE
----------------------------------
Dacă nu este clar ce vrea utilizatorul:
- pune o întrebare scurtă de clarificare  

----------------------------------

LUNGIME RĂSPUNS
----------------------------------
- maxim 4–6 propoziții  
- fără explicații lungi  

----------------------------------

EXERCIȚII
----------------------------------
Pentru orice tip de mișcare fizică:
- 1–2 sugestii simple  
- fără planuri complete  

----------------------------------

SCOP
----------------------------------
Ajută utilizatorul să înțeleagă și să aplice rapid, oferind mai multă claritate decât FREE, fără a deveni complex.

NU menționa niveluri sau abonamente.
`,

  EXPERT: `
IDENTITATE
----------------------
Ești NeuroBalance Coach, un asistent specializat EXCLUSIV în:

- nutriție
- digestie
- hidratare
- reglarea sistemului nervos
- mișcare metabolică

Abordarea ta este holistică, bazată pe alimente reale.

Dacă utilizatorul întreabă cine ești / ce ești / cu ce poți ajuta:
→ răspunzi direct:

„Sunt NeuroBalance Coach - te ajut să-ți reglezi nutriția, digestia, hidratarea și sistemul nervos prin strategii simple, adaptate stilului tău de viață.”

→ apoi întrebi:
„Ce vrei să îmbunătățești?”

Această regulă are prioritate față de orice limitare de domeniu.

Oferi analiză mai profundă, direcție clară și strategie practică, fără a intra în zona medicală.

RESTRICȚIE ABSOLUTĂ
-----------------------
NU oferi NICIODATĂ:

- medicamente
- suplimente alimentare
- vitamine sub formă de pastile / capsule / praf

Dacă utilizatorul cere:

vitamine → recomanzi DOAR alimente bogate în acea vitamină
suplimente → redirecționezi către alimentație
medicamente → refuzi politicos

FORMULARE OBLIGATORIE:

„Nu ofer recomandări despre medicamente sau suplimente. Pentru asta, discută cu medicul tău. Te pot ajuta însă cu alternative naturale din alimentație.”

DETECTAREA INTENȚIEI
--------------------------------
Alege DOAR una:

A) Nutriție / corp / simptome
B) Alegere mâncare (restaurant / oraș)

NU le combina.

ANALIZĂ EXPERT
--------------------------------
Pentru nutriție / corp / simptome:

- identifici simptomele principale
- conectezi 2–3 sisteme dacă este relevant
- explici ce se întâmplă în corp clar și logic
- cauți cauza probabilă, nu doar simptomul
- adaptezi răspunsul la obiectiv: slăbire / îngrășare / menținere / energie

STRUCTURĂ RĂSPUNS (OBLIGATORIU)
----------------------------------
1. Analiză clară: ce se întâmplă în corp
2. Conexiuni între sisteme: digestie / hidratare / sistem nervos / mișcare
3. Cauza probabilă
4. 4–6 recomandări concrete
5. Mini-plan structurat: dimineață / prânz / seară
6. Ajustare după obiectiv: slăbire / îngrășare / menținere / energie

STRATEGIE
----------------------------------
- recomandările trebuie să fie integrate, nu separate
- combină nutriție + hidratare + comportament + ritm zilnic
- oferă acțiuni clare, aplicabile imediat
- poți include timing, combinații alimentare și ritm al meselor
- NU oferi planuri pe zile sau săptămâni

RESTAURANT / ORAȘ
----------------------------------
- recomanzi 1–2 opțiuni reale
- spui exact ce să comande
- explici de ce se potrivește cu obiectivul
- poți da o variantă mai bună și una acceptabilă

REGULI
----------------------------------
- NU răspunsuri superficiale
- NU liste foarte lungi
- NU planuri complete pe zile / săptămâni
- NU strategii medicale
- NU diagnostic
- NU promisiuni de vindecare
- NU recomandări extreme

LIMITARE DOMENIU
----------------------------------
Răspunzi DOAR la:

- nutriție
- simptome corporale
- slăbire / îngrășare / menținere / energie
- digestie
- hidratare
- reglarea sistemului nervos
- orice tip de mișcare fizică
- restaurante / cafenele / baruri / pizza / mâncare

ÎN AFARA DOMENIULUI
----------------------------------
Răspuns fix:

„Te pot ajuta doar cu nutriție, alimentație și alegerea mâncării în viața reală. Spune-mi ce vrei să îmbunătățești.”

VIZUAL (HIDRATARE)
----------------------------------
Dacă răspunsul este despre hidratare:
- poți adăuga o singură imagine
- doar dacă ajută înțelegerea
- nu este obligatoriu

https://webicdp.com/wp-content/uploads/2026/04/Hidratare.png

TON
----------------------------------
- sigur pe sine
- profesionist
- clar
- explicativ
- orientat pe soluții
- calm

CONTROL SUPLIMENTE / MEDICAMENTE
----------------------------------
Dacă utilizatorul insistă:
- NU schimbi răspunsul
- repeți refuzul calm
- redirecționezi către alimentație
- NU oferi niciodată nume de suplimente, branduri sau tipuri de produse
- NU sugera indirect suplimente

AMBIGUITATE
----------------------------------
Dacă nu este clar ce vrea utilizatorul:
- pune 1–2 întrebări scurte de clarificare

LUNGIME RĂSPUNS
----------------------------------
- răspuns structurat
- suficient de detaliat pentru analiză
- fără explicații inutile
- evită blocurile lungi de text

EXERCIȚII
----------------------------------
Pentru orice tip de mișcare fizică:
- oferă 2–3 sugestii clare
- adaptează la obiectiv
- fără planuri complete pe săptămâni

SCOP
----------------------------------
Utilizatorul trebuie să simtă că:
- a primit o analiză reală
- înțelege ce se întâmplă în corp
- are o direcție clară
- poate aplica imediat pașii recomandați

NU menționa niveluri sau abonamente.
`
};

app.post("/chat", authMiddleware, async (req, res) => {
  try {
    const user_id = req.user.id;
    const supabaseUser = req.supabaseUser;
  const { message, image_url, type } = req.body;

const finalImageUrl = image_url || (type === "image" ? message : null);

// ================= CONVERSATION INIT =================
let { data: conv, error: convError } = await supabaseUser
  .from("conversations")
  .select("id")
  .eq("user_id", user_id)
  .order("created_at", { ascending: false })
  .limit(1);

if (convError) {
  return res.status(500).json({ error: "Eroare conversații", details: convError });
}

let conversation_id;

if (!conv || conv.length === 0) {
  const { data: newConv, error: newConvError } = await supabaseUser
    .from("conversations")
    .insert([{ user_id }])
    .select("id")
    .single();

  if (newConvError || !newConv) {
    return res.status(500).json({ error: "Nu s-a putut crea conversația" });
  }

  conversation_id = newConv.id;
} else {
  conversation_id = conv[0].id;
}

  // ================= IMAGE CHECK =================
if (finalImageUrl) {
  console.log("📸 IMAGE DETECTED");

  // ================= IMAGE CHECK =================
  let imageCheck = { category: "other", confidence: 0 };

  try {
    const checkRes = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `
Clasifică imaginea.

Returnează DOAR JSON:
{
  "category": "food | hydration | fitness | body | supplement | education | other",
  "confidence": 0-100
}
`
        },
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: finalImageUrl }
            }
          ]
        }
      ],
      temperature: 0
    });

    imageCheck =
      safeJSONParse(checkRes.choices[0].message.content) || imageCheck;

  } catch (err) {
    console.error("Image check error:", err);
  }

  console.log("IMAGE CHECK:", imageCheck);

const allowed = ["food", "hydration", "fitness", "body", "education", "supplement"];

  if (!allowed.includes(imageCheck.category) && imageCheck.confidence < 50) {
    return res.json({
      reply: "Imaginea nu este relevantă pentru nutriție sau fitness."
    });
  }

  // ================= IMAGE ANALYSIS =================
  const imageAnalysisRes = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `
Ești nutriționist.

Analizează imaginea și spune:
- ce este
- estimare calorii
- protein / carbs / fat
- dacă este sănătos sau nu

Răspunde simplu.
`
      },
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: finalImageUrl }
          }
        ]
      }
    ]
  });

  const result = imageAnalysisRes.choices[0].message.content;

  // ================= SAVE =================
  await supabaseUser.from("messages").insert([
    {
      user_id,
      conversation_id,
      role: "user",
      content: finalImageUrl,
      type: "image"
    },
    {
      user_id,
      conversation_id,
      role: "assistant",
      content: result,
      type: "text"
    }
  ]);

  // 🔴 FOARTE IMPORTANT
  return res.json({ reply: result });
}

    let language = "ro";
let translated = message || "";

if (message && type !== "image") {
  const result = await detectAndTranslate(message);
  language = result.language;
  translated = result.translated;
}

    console.log("LANG:", language);
    console.log("TRANSLATED:", translated);

const analysisRes = await openai.chat.completions.create({
  model: "gpt-4o-mini",
  messages: [
    {
      role: "system",
      content: `
Analizează mesajul utilizatorului.

Returnează DOAR JSON valid:

{
  "language": "ro/en/de/...",
  "intent": "body_goal | food_choice | general",
  "eat_out": true,
  "goal": "slabire | ingrasare | mentinere | energie | null",
  "main_issue": "balonare | stres | oboseala | digestie | null",
  "last_mood": "anxietate | obosit | ok | stresat | null"
}
`
    },
    { role: "user", content: translated }
  ],
  temperature: 0
});

// ================= PARSARE =================
const parsed =
  safeJSONParse(analysisRes.choices[0].message.content) || {};
  const normalize = (v) =>
  v === undefined || v === null || v === "null" || v === ""
    ? null
    : v;

const intent = parsed.intent || "general";
const eat_out = parsed.eat_out || false;

const goal = normalize(parsed.goal);
const main_issue = normalize(parsed.main_issue);
const last_mood = normalize(parsed.last_mood);

console.log("ANALYSIS:", parsed);

// ================= SAVE USER STATE (SAFE) =================
const { data: existingState } = await supabaseUser
  .from("user_state")
  .select("*")
  .eq("user_id", user_id)
  .maybeSingle();

await supabaseUser
  .from("user_state")
  .upsert({
    user_id,
    goal: goal ?? existingState?.goal ?? null,
    main_issue: main_issue ?? existingState?.main_issue ?? null,
    last_mood: last_mood ?? existingState?.last_mood ?? null
  });

  if (!message && !finalImageUrl){
  return res.status(400).json({ error: "Lipsește mesaj sau imagine" });
}
    

    console.log("MESSAGE:", message);
    console.log("INTENT:", intent);
    console.log("EAT OUT:", eat_out);
    console.log("LOCATION:", req.body.location);

  const { data: sub, error: subError } = await supabase
  .from("subscriptions")
  .select("plan")
  .eq("user_id", user_id)
  .eq("is_active", true)
  .maybeSingle();

if (subError) {
  console.error("Subscription error:", subError);
}

const plan = sub?.plan || "FREE";

   const normalizedPlan = String(plan || "FREE").toUpperCase();
    let systemPrompt = PROMPTS[normalizedPlan] || PROMPTS.FREE;
    // ================= LOAD USER STATE =================
      const { data: userState } = await supabaseUser
        .from("user_state")
        .select("*")
        .eq("user_id", user_id)
       .maybeSingle();

       if (userState) {
            systemPrompt += `
            
          USER CONTEXT (OBLIGATORIU):
          - goal: ${userState.goal || "necunoscut"}
          - main_issue: ${userState.main_issue || "necunoscut"}
          - last_mood: ${userState.last_mood || "necunoscut"}

          Trebuie să adaptezi răspunsul la acest context.
          Nu ignora aceste informații.
          `;
          }
          

   // Google places
if (req.body.location) {
  console.log("ENTER GOOGLE BLOCK");

  const { lat, lng } = req.body.location;

  // Detectare locație reală (reverse geocoding)
let userLocationText = "";

try {
  const geoUrl = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${process.env.GOOGLE_PLACES_KEY}`;
  
  const geoRes = await fetch(geoUrl);
  const geoData = await geoRes.json();

  if (geoData.status === "OK") {
    const components = geoData.results[0].address_components;

    const street = components.find(c => c.types.includes("route"))?.long_name;
    const number = components.find(c => c.types.includes("street_number"))?.long_name;
    const city = components.find(c => c.types.includes("locality"))?.long_name;
    const country = components.find(c => c.types.includes("country"))?.long_name;

    const parts = [
      street && number ? `${street} ${number}` : street,
      city,
      country
    ].filter(Boolean);

    userLocationText = parts.join(", ");

    console.log("USER LOCATION:", userLocationText);
  }
} catch (err) {
  console.error("Geocode error:", err);
}

const types = [
  "restaurant",
  "cafe",
  "bar",
  "bakery",
  "meal_takeaway"
];

  let allPlaces = [];

  for (const type of types) {
   const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=5000&type=${type}&key=${process.env.GOOGLE_PLACES_KEY}`;

    try {
      const response = await fetch(url);
      const data = await response.json();

     console.log("TYPE:", type);
      console.log("STATUS:", data.status);
      console.log("RESULTS:", data.results?.length || 0);

      if (data.status === "OK" && Array.isArray(data.results)) {
        allPlaces.push(...data.results);
      } else {
        console.warn("Google Places non-OK:", data.status);
      }
    } catch (err) {
      console.error("Google fetch error:", err);
    }
  }

  // fallback dacă nu avem rezultate
  if (allPlaces.length === 0) {
    console.warn("Fallback restaurant");

    const fallbackUrl = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=5000&type=restaurant&key=${process.env.GOOGLE_PLACES_KEY}`;

    try {
      const response = await fetch(fallbackUrl);
      const data = await response.json();

      if (data.status === "OK") {
        allPlaces.push(...data.results);
      }
    } catch (err) {
      console.error("Fallback error:", err);
    }
  }

  // deduplicate
  const uniquePlaces = Array.from(
    new Map(allPlaces.map(p => [p.place_id, p])).values()
  );

  const categorized = {
  restaurants: [],
  cafes: [],
  bars: [],
  bakeries: [],
};

for (const p of uniquePlaces) {
  if (p.types.includes("restaurant")) categorized.restaurants.push(p);
  if (p.types.includes("cafe")) categorized.cafes.push(p);
  if (p.types.includes("bar")) categorized.bars.push(p);
  if (p.types.includes("bakery")) categorized.bakeries.push(p);
}


console.log("FINAL CATEGORIZED:", categorized);

// verificăm dacă avem orice rezultat
const hasPlaces =
  categorized.restaurants.length > 0 ||
  categorized.cafes.length > 0 ||
  categorized.bars.length > 0 ||
  categorized.bakeries.length > 0;

const clean = (arr) =>
  arr
    .filter(p => p.name && p.vicinity) // elimină junk
    .sort((a, b) => (b.rating || 0) - (a.rating || 0)) // TOP rating
    .slice(0, 5)
    .map(p => ({
      name: p.name,
      rating: p.rating || "N/A",
      address: p.vicinity
    }));

const cleanedCategorized = {
  restaurants: clean(categorized.restaurants),
  cafes: clean(categorized.cafes),
  bars: clean(categorized.bars),
  bakeries: clean(categorized.bakeries),
};

if (hasPlaces) {
   systemPrompt += `
Ești un ghid local foarte precis.

Utilizatorul se află la:
${userLocationText}

Ai următoarele locații reale din apropiere:

${JSON.stringify(cleanedCategorized)}

Sarcina ta:
- afișează între 5 și 20 locații totale
- distribuie-le pe categorii
- NU te limita la 1-2 exemple
- grupează clar pe categorii:
  - Restaurante
  - Cafenele
  - Baruri
  - Bakery / Desert
- pentru fiecare locație:
  - nume
  - rating (dacă există)
  - adresă
  - ce merită să comande

IMPORTANT:
- NU inventa locații
- folosește DOAR lista primită
- NU limita răspunsul
- răspunsul trebuie să fie util și realist

Răspunde în limba: ${language}
`;
  }
  else {
  systemPrompt += `
Utilizatorul se află la:
${userLocationText || "locație necunoscută"}

Nu s-au găsit locații reale în apropiere.

Explică situația și oferă alternative:
- ce tipuri de restaurante să caute
- ce zone sunt de obicei bune (centru, mall, etc)

Răspunde în limba: ${language}
`;
}
}
  
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const { count, error: countError } = await supabaseUser
      .from("messages")
      .select("*", { count: "exact", head: true })
      .eq("user_id", user_id)
      .eq("role", "user")
      .gte("created_at", today.toISOString());

    if (countError) {
      return res.status(500).json({ error: "Eroare limită mesaje", details: countError });
    }

    let limit = 7;
    if (plan === "CORE") limit = 12;
    if (plan === "EXPERT") limit = 17;

   if ((count || 0) >= limit) {
  return res.status(403).json({
    error: "Ai atins limita zilnică",
    limit_reached: true,
    plan,
    daily_limit: limit,
    daily_used: count || 0,
    daily_remaining: 0,
  });
}

    const { data: history, error: historyError } = await supabaseUser
      .from("messages")
      .select("role, content")
      .eq("conversation_id", conversation_id)
      .eq("user_id", user_id)
      .order("created_at", { ascending: true })
      .limit(10);

    if (historyError) {
      return res.status(500).json({ error: "Eroare istoric", details: historyError });
    }

   const stream = await openai.chat.completions.create({
  model: "gpt-4o-mini",
  messages: [
    { role: "system", content: systemPrompt },
    ...(history || []),
   { role: "user", content: message || finalImageUrl || "Analizează contextul." }
  ],
  stream: true,
});

res.setHeader("Content-Type", "text/plain");

let fullReply = "";

for await (const chunk of stream) {
  const content = chunk.choices[0]?.delta?.content || "";
  fullReply += content;
  res.write(content);
}
res.end();

const userContent = finalImageUrl || message;
await supabaseUser.from("messages").insert([
  {
    user_id,
    conversation_id,
    role: "user",
    content: userContent,
    type: finalImageUrl ? "image" : "text"
  },
  {
    user_id,
    conversation_id,
    role: "assistant",
    content: fullReply,
    type: "text"
  }
]);

  } catch (err) {
    console.error("EROARE:", err);
    res.status(500).json({ error: "Eroare server" });
  }
});

// ================== STRIPE CHECKOUT ==================
app.post("/create-checkout-session", authMiddleware, async (req, res) => {
  try {
    const { plan } = req.body;

    let priceId;

    if (plan === "CORE") {
      priceId = process.env.STRIPE_CORE_PRICE_ID;
    } else if (plan === "EXPERT") {
      priceId = process.env.STRIPE_EXPERT_PRICE_ID;
    } else {
      return res.status(400).json({ error: "Plan invalid" });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      success_url: `${process.env.FRONTEND_URL}/success?plan=${plan}`,
      cancel_url: `${process.env.FRONTEND_URL}/cancel`,
      metadata: {
        user_id: req.user.id,
        plan: plan,
      },
    });

    res.json({ url: session.url });
  } 
catch (err) {
  console.error("STRIPE REAL ERROR:", err);
  res.status(500).json({ error: err.message });
}
});

// ================== HISTORY ==================
app.get("/history", authMiddleware, async (req, res) => {
  try {
    const user_id = req.user.id;
    const supabaseUser = req.supabaseUser;

    const { data: conversations, error: conversationsError } = await supabaseUser
      .from("conversations")
      .select("id, created_at")
      .eq("user_id", user_id)
      .order("created_at", { ascending: false });

    if (conversationsError) {
      return res.status(500).json({
        error: "Eroare conversații",
        details: conversationsError,
      });
    }

   const { data: sub, error: subError } = await supabase
  .from("subscriptions")
  .select("plan")
  .eq("user_id", user_id)
  .eq("is_active", true)
  .maybeSingle();

if (subError) {
  console.error("History subscription error:", subError);
}

const plan = String(sub?.plan || "FREE").toUpperCase();

    let dailyLimit = 7;

    if (plan === "CORE") {
      dailyLimit = 12;
    }

    if (plan === "EXPERT") {
      dailyLimit = 17;
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const { count, error: countError } = await supabaseUser
      .from("messages")
      .select("*", { count: "exact", head: true })
      .eq("user_id", user_id)
      .eq("role", "user")
      .gte("created_at", today.toISOString());

    if (countError) {
      return res.status(500).json({
        error: "Eroare limită mesaje",
        details: countError,
      });
    }

    const dailyUsed = count || 0;
    const dailyRemaining = Math.max(dailyLimit - dailyUsed, 0);
    const limitReached = dailyUsed >= dailyLimit;

    return res.json({
      conversations: conversations || [],
      plan,
      daily_used: dailyUsed,
      daily_limit: dailyLimit,
      daily_remaining: dailyRemaining,
      limit_reached: limitReached,
      email: req.user.email,
    });
  } catch (err) {
    console.error("History error:", err);

    return res.status(500).json({
      error: "Eroare server history",
    });
  }
});

// ================== MESSAGES ==================
app.get("/messages/:id", authMiddleware, async (req, res) => {
  const { id } = req.params;
  const user_id = req.user.id;
  const supabaseUser = req.supabaseUser;

  // verifică dacă conversația aparține userului
  const { data: conv, error: convError } = await supabaseUser
    .from("conversations")
    .select("id")
    .eq("id", id)
    .eq("user_id", user_id)
    .single();

  if (convError || !conv) {
    return res.status(403).json({ error: "Acces interzis" });
  }

  // doar dacă e owner
  const { data, error } = await supabaseUser
    .from("messages")
    .select("role, content, type")
    .eq("conversation_id", id)
    .eq("user_id", user_id) //  EXTRA SAFE
    .order("created_at", { ascending: true });

  if (error) {
    return res.status(500).json({ error });
  }

  res.json({ messages: data });
});

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log("🚀 Server running on port", PORT);
});