import express from "express";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import cors from "cors";

const app = express();
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
    if (plan === "CORE") limit = 75;
    if (plan === "EXPERT") limit = 250;

    if ((count || 0) >= limit) {
      return res.status(403).json({
        error: "Ai atins limita zilnică",
        limit,
        used: count || 0
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

    res.json({
      reply,
      plan,
      daily_limit: limit,
      daily_used: (count || 0) + 1,
      daily_remaining: Math.max(limit - ((count || 0) + 1), 0)
    });
  } catch (err) {
    console.error("EROARE:", err);
    res.status(500).json({ error: "Eroare server" });
  }
});

// ================== HISTORY ==================
app.get("/history", authMiddleware, async (req, res) => {
  const user_id = req.user.id;

  const { data, error } = await supabase
    .from("conversations")
    .select("id, created_at")
    .eq("user_id", user_id)
    .order("created_at", { ascending: false });

  if (error) {
    return res.status(500).json({ error });
  }

  res.json({ conversations: data });
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