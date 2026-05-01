import express from "express";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import cors from "cors";

const app = express();
app.use(express.json());
app.use(cors());

// ================== SUPABASE ==================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ================== AUTH ==================
async function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];

  if (!token) {
    return res.status(401).json({ error: "No token" });
  }

  // creezi un client NOU cu tokenul userului
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

  // fără token param!
  const { data, error } = await supabaseUser.auth.getUser();

  if (error || !data?.user) {
    return res.status(401).json({ error: "Invalid token" });
  }

  req.user = data.user;
  next();
}
// ================== OPENAI ==================
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// ================== CHAT ==================
app.post("/chat", authMiddleware, async (req, res) => {
  try {
    const user_id = req.user.id;
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ error: "Lipsește mesajul" });
    }

    // ================== PLAN ==================
    const { data: sub, error: subError } = await supabase
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

    // ================== CONVERSATION ==================
    let { data: conv } = await supabase
      .from("conversations")
      .select("id")
      .eq("user_id", user_id)
      .limit(1);

    let conversation_id;

    if (!conv || conv.length === 0) {
      const { data: newConv } = await supabase
        .from("conversations")
        .insert([{ user_id }])
        .select();

      conversation_id = newConv[0].id;
    } else {
      conversation_id = conv[0].id;
    }

// ================== LIMITĂ ZILNICĂ ==================

const today = new Date();
today.setHours(0, 0, 0, 0);

// luăm toate conversațiile userului
const { data: conversations } = await supabase
  .from("conversations")
  .select("id")
  .eq("user_id", user_id);

// extragem id-urile
const conversationIds = conversations.map(c => c.id);

// numărăm mesajele de tip USER azi
const { count } = await supabase
  .from("messages")
  .select("*", { count: "exact", head: true })
  .in("conversation_id", conversationIds)
  .eq("role", "user")
  .gte("created_at", today.toISOString());

// limite per plan
let limit = 7;

if (plan === "CORE") limit = 75;
if (plan === "EXPERT") limit = 250;

// verificare
if (count >= limit) {
  return res.status(403).json({
    error: "Ai atins limita zilnică"
  });
}
    // ================== HISTORY ==================
    const { data: history } = await supabase
      .from("messages")
      .select("role, content")
      .eq("conversation_id", conversation_id)
      .order("created_at", { ascending: true })
      .limit(10);

    // ================== AI ==================
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        ...(history || []),
        { role: "user", content: message }
      ]
    });

    const reply = response.choices[0].message.content;

   // ================== SAVE ==================
await supabase.from("messages").insert([
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
    // ================== RESPONSE ==================
    res.json({ reply });

  } catch (err) {
    console.error("EROARE:", err);
    res.status(500).json({ error: "Eroare server" });
  }
});

// ================== SERVER ==================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Serverul rulează pe portul ${PORT}`);
});