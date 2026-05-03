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



app.post("/chat", authMiddleware, async (req, res) => {
  try {
    const user_id = req.user.id;
    const supabaseUser = req.supabaseUser;
  const { message, image_url } = req.body;

  // ================= IMAGE CHECK =================
if (image_url) {
  console.log("📸 IMAGE DETECTED");

  let imageCheck = {
    is_food: false,
    confidence: 0
  };

  try {
    const checkRes = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `
Analizezi o imagine.

Returnează DOAR JSON:

{
  "is_food": true/false,
  "confidence": 0-100
}

TRUE doar dacă:
- mâncare
- băutură
- ingrediente
- farfurie cu ceva comestibil

FALSE pentru:
- oameni fără mâncare
- selfie
- obiecte
- peisaje
- orice non-food
`
        },
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: image_url }
            }
          ]
        }
      ],
      temperature: 0
    });

    imageCheck = JSON.parse(checkRes.choices[0].message.content);

  } catch (err) {
    console.error("Image check error:", err);
  }

  console.log("IMAGE CHECK:", imageCheck);

  // HARD BLOCK
  if (!imageCheck.is_food || imageCheck.confidence < 60) {
    return res.json({
      reply: "Această imagine nu este relevantă pentru nutriție."
    });
  }

  // ================= FOOD ANALYSIS =================
  const analysisRes = await openai.chat.completions.create({
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

Fii realist.
`
      },
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: image_url }
          }
        ]
      }
    ]
  });

  const result = analysisRes.choices[0].message.content;

  return res.json({ reply: result });
}

    let language = "ro";
let translated = message || "";

if (message) {
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
      Analizează mesajul userului.

      Returnează DOAR JSON:

      {
        "language": "ro/en/de/...",
        "intent": "dessert | pizza | food | general",
        "eat_out": true/false
      }
      `
          },
         { role: "user", content: translated }
        ],
        temperature: 0
      });

      let analysis = {
        language: "unknown",
        intent: "general",
        eat_out: false
      };

try {
  analysis = JSON.parse(analysisRes.choices[0].message.content);
} catch {}

const { intent, eat_out } = analysis;

console.log("ANALYSIS:", analysis);

  if (!message && !image_url) {
  return res.status(400).json({ error: "Lipsește mesaj sau imagine" });
}
    

    console.log("MESSAGE:", message);
    console.log("ANALYSIS:", analysis);
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

    let systemPrompt = "Ești asistent de nutriție.";

    if (plan === "FREE") {
      systemPrompt =
        "Ești un asistent de nutriție de bază. Răspunde scurt și simplu.";
    } else if (plan === "CORE") {
      systemPrompt =
        "Ești un coach de nutriție profesionist. Răspunde structurat.";
    } else if (plan === "EXPERT") {
      systemPrompt =
        "Ești expert de top în nutriție. Răspunde detaliat și strategic.";
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
        return res.status(500).json({ error: "Nu s-a putut crea conversația", details: newConvError });
      }

      conversation_id = newConv.id;
    } else {
      conversation_id = conv[0].id;
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
    { role: "user", content: message }
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

await supabaseUser.from("messages").insert([
  {
    user_id,
    conversation_id,
    role: "user",
    content: message
  },
  {
    user_id,
    conversation_id,
    role: "assistant",
    content: fullReply
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
    .select("role, content")
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