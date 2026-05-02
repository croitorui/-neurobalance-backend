import dotenv from "dotenv";
dotenv.config();

import express from "express";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import cors from "cors";
import Stripe from "stripe";

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

app.post("/chat", authMiddleware, async (req, res) => {
  try {
    const user_id = req.user.id;
    const supabaseUser = req.supabaseUser;
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ error: "Lipsește mesajul" });
    }

    const { data: sub, error: subError } = await supabaseUser
      .from("subscriptions")
      .select("plan")
      .eq("user_id", user_id)
      .eq("is_active", true)
      .single();

    if (subError || !sub) {
      return res.status(400).json({ error: "Nu există abonament" });
    }

    const plan = sub.plan;

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

    let { data: conv, error: convError } = await supabaseUser
      .from("conversations")
      .select("id")
      .eq("user_id", user_id)
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
    if (plan === "CORE") limit = 5;
    if (plan === "EXPERT") limit = 5;

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
      .order("created_at", { ascending: true })
      .limit(10);

    if (historyError) {
      return res.status(500).json({ error: "Eroare istoric", details: historyError });
    }

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        ...(history || []),
        { role: "user", content: message }
      ]
    });

    const reply = response.choices[0].message.content;

    const { error: saveError } = await supabaseUser.from("messages").insert([
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
        content: reply
      }
    ]);

    if (saveError) {
      return res.status(500).json({ error: "Eroare salvare mesaje", details: saveError });
    }

  const nextUsed = (count || 0) + 1;

res.json({
  reply,
  plan,
  daily_limit: limit,
  daily_used: nextUsed,
  daily_remaining: Math.max(limit - nextUsed, 0),
  limit_reached: nextUsed >= limit,
});

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
      success_url: `${process.env.FRONTEND_URL}/success`,
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

    const { data: sub, error: subError } = await supabaseUser
      .from("subscriptions")
      .select("plan")
      .eq("user_id", user_id)
      .eq("is_active", true)
      .single();

    if (subError || !sub) {
      return res.status(400).json({
        error: "Nu există abonament",
      });
    }

    const plan = String(sub.plan || "FREE").toUpperCase();

    let dailyLimit = 7;

    if (plan === "CORE") {
      dailyLimit = 75;
    }

    if (plan === "EXPERT") {
      dailyLimit = 250;
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

  const { data, error } = await supabase
    .from("messages")
    .select("role, content")
    .eq("conversation_id", id)
    .order("created_at", { ascending: true });

  if (error) {
    return res.status(500).json({ error });
  }

  res.json({ messages: data });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Serverul rulează pe portul ${PORT}`);
});