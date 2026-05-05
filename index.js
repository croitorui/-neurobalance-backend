// ================== SETUP ==================
import dotenv from "dotenv";
dotenv.config();

import express from "express";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import cors from "cors";
import Stripe from "stripe";
import fetch from "node-fetch";

const app = express();

// ================== MIDDLEWARE ==================
app.use(express.json());
app.use(cors());

// ================== CLIENTS ==================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ================== AUTH ==================
async function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "No token" });

  const supabaseUser = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY,
    {
      global: {
        headers: { Authorization: `Bearer ${token}` }
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

// ================== UTILS ==================
function safeJSONParse(text) {
  try {
    return JSON.parse(
      text.replace(/```json/g, "").replace(/```/g, "").trim()
    );
  } catch {
    return null;
  }
}

// ================== PROMPTS (OPTIMIZATE) ==================
const PROMPTS = {
  FREE: `
Ești NeuroBalance Coach.

INTERDICȚII:
- NU medicamente
- NU suplimente

STRUCTURĂ:

Problema:
...

Explicație:
...

Recomandări:
1.
2.

REGULI:
- max 2 recomandări
- scurt și clar
`,

  CORE: `
Ești NeuroBalance Coach.

INTERDICȚII:
- NU medicamente
- NU suplimente

STRUCTURĂ:

Ce se întâmplă:
...

Cauza:
...

Recomandări:
1.
2.
3.

Mini ghid:
...

REGULI:
- max 3 recomandări
- clar și aplicabil
`,

  EXPERT: `
Ești NeuroBalance Coach.

INTERDICȚII:
- NU medicamente
- NU suplimente

STRUCTURĂ:

Analiză:
...

Cauză:
...

Recomandări:
1.
2.
3.
4.

Mini-plan:
Dimineață:
Prânz:
Seară:

REGULI:
- fără extreme
- aplicabil imediat
`
};

// ================== CHAT ==================
app.post("/chat", authMiddleware, async (req, res) => {
  try {
    const { message, image_url, type } = req.body;
    const user_id = req.user.id;
    const supabaseUser = req.supabaseUser;

    const finalImageUrl = image_url || (type === "image" ? message : null);

    if (!message && !finalImageUrl) {
      return res.status(400).json({ error: "Lipsește input" });
    }

    // ================== CONVERSATION ==================
    let { data: conv } = await supabaseUser
      .from("conversations")
      .select("id")
      .eq("user_id", user_id)
      .order("created_at", { ascending: false })
      .limit(1);

    let conversation_id;

    if (!conv || conv.length === 0) {
      const { data } = await supabaseUser
        .from("conversations")
        .insert([{ user_id }])
        .select("id")
        .single();

      conversation_id = data.id;
    } else {
      conversation_id = conv[0].id;
    }

    // ================== IMAGE ==================
    if (finalImageUrl) {
      const imageRes = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "Analizează imaginea simplu." },
          {
            role: "user",
            content: [{ type: "image_url", image_url: { url: finalImageUrl } }]
          }
        ]
      });

      const result = imageRes.choices[0].message.content;

      await supabaseUser.from("messages").insert([
        { user_id, conversation_id, role: "user", content: finalImageUrl, type: "image" },
        { user_id, conversation_id, role: "assistant", content: result, type: "text" }
      ]);

      return res.json({ reply: result });
    }

    // ================== ANALYSIS ==================
    const analysisRes = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "Returnează JSON cu language și translated" },
        { role: "user", content: message }
      ]
    });

    const parsed = safeJSONParse(analysisRes.choices[0].message.content) || {};
    const translated = parsed.translated || message;

    // ================== PLAN ==================
    const { data: sub } = await supabase
      .from("subscriptions")
      .select("plan")
      .eq("user_id", user_id)
      .eq("is_active", true)
      .maybeSingle();

    const plan = String(sub?.plan || "FREE").toUpperCase();
    let systemPrompt = PROMPTS[plan] || PROMPTS.FREE;

    // ================== HISTORY ==================
    const { data: history } = await supabaseUser
      .from("messages")
      .select("role, content")
      .eq("conversation_id", conversation_id)
      .order("created_at", { ascending: true })
      .limit(10);

    // ================== AI ==================
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        ...(history || []),
        { role: "user", content: translated }
      ]
    });

    const fullReply = completion.choices[0].message.content;

    // ================== SAVE ==================
    await supabaseUser.from("messages").insert([
      { user_id, conversation_id, role: "user", content: message, type: "text" },
      { user_id, conversation_id, role: "assistant", content: fullReply, type: "text" }
    ]);

    return res.json({ reply: fullReply });

  } catch (err) {
    console.error("ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ================== STRIPE ==================
app.post("/create-checkout-session", authMiddleware, async (req, res) => {
  try {
    const { plan } = req.body;

    const priceId =
      plan === "CORE"
        ? process.env.STRIPE_CORE_PRICE_ID
        : plan === "EXPERT"
        ? process.env.STRIPE_EXPERT_PRICE_ID
        : null;

    if (!priceId) {
      return res.status(400).json({ error: "Plan invalid" });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${process.env.FRONTEND_URL}/success`,
      cancel_url: `${process.env.FRONTEND_URL}/cancel`,
      metadata: { user_id: req.user.id, plan }
    });

    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================== SERVER ==================
const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log("🚀 Server running on", PORT);
});