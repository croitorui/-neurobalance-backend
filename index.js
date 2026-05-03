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
    const { message } = req.body;

    const { language, translated } = await detectAndTranslate(message);

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
          { role: "user", content: message }
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

    if (!message) {
      return res.status(400).json({ error: "Lipsește mesajul" });
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

      if (
      (intent === "dessert" || intent === "pizza") &&
      req.body.location
    ) 
{
          const { lat, lng } = req.body.location;

        const type =
          intent === "dessert" ? "bakery" : "restaurant";

        const keyword =
          intent === "dessert"
            ? "dessert cafe ice cream"
            : "pizza";

          const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=3000&type=${type}&keyword=${keyword}&key=${process.env.GOOGLE_PLACES_KEY}`;

          const response = await fetch(url);
          const data = await response.json();

          if (data.status !== "OK") {
              console.error("GOOGLE ERROR:", data);
            }

          console.log("GOOGLE STATUS:", data.status);
            console.log("GOOGLE RESULTS:", data.results?.length);
            console.log("GOOGLE DATA:", data);

          const places = data.results?.slice(0, 5) || [];

          const formattedPlaces = places.map(p => ({
            name: p.name,
            rating: p.rating,
            address: p.vicinity
          }));

           systemPrompt += `
              IMPORTANT:

              Utilizatorul caută locuri reale din oraș.

              Trebuie să folosești DOAR locațiile de mai jos.
              NU inventa nume de locații.
              NU presupune orașul.
              NU da sugestii generale.

              Dacă lista este goală → spune clar:
              "Nu am găsit locații în apropierea ta."

              Locații:
              ${JSON.stringify(formattedPlaces)}

              Alege 1-2 și recomandă concret ce să mănânce acolo.
              `;

              systemPrompt += `
                Răspunde STRICT în limba utilizatorului: ${language}
                `;
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