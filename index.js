import express from "express";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import cors from "cors";
import jwt from "jsonwebtoken";

const app = express();
app.use(express.json());
app.use(cors());

// DEBUG (poți șterge după)
console.log("SUPABASE_URL:", process.env.SUPABASE_URL);
console.log("SUPABASE_KEY exists:", !!process.env.SUPABASE_KEY);
console.log("OPENAI_API_KEY exists:", !!process.env.OPENAI_API_KEY);

// Conectare Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Endpoint chat
app.post("/chat", async (req, res) => {
  try {
   const token = req.headers.authorization?.split(" ")[1];

if (!token) {
  return res.status(401).json({ error: "No token" });
}

const decoded = jwt.decode(token);

const user_id = decoded.sub;
const { message } = req.body;

if (!message) {
  return res.status(400).json({ error: "Lipsește mesajul" });
}

    // Luăm planul
const { data, error } = await supabase
  .from("subscriptions")
  .select("plan")
  .eq("user_id", user_id)
  .eq("is_active", true);

console.log("SUB DATA:", data);
console.log("SUB ERROR:", error);

if (error) {
  return res.status(500).json({ error: "Eroare DB", details: error });
}

if (!data || data.length === 0) {
  return res.status(400).json({ error: "Nu există abonament pentru acest user" });
}

const plan = data[0].plan;

    let systemPrompt = "";

    if (plan === "FREE") {
      systemPrompt =
        "Ești un asistent de nutriție de bază. Răspunde scurt și simplu, în limba română.";
    } else if (plan === "CORE") {
      systemPrompt =
        "Ești un coach de nutriție profesionist. Răspunde structurat și util, în limba română.";
    } else if (plan === "EXPERT") {
      systemPrompt =
        "Ești expert de top în nutriție. Răspunde detaliat și strategic, în limba română.";
    } else {
      systemPrompt = "Ești asistent de nutriție. Răspunde în română.";
    }

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: systemPrompt
        },
        {
          role: "user",
          content: message
        }
      ]
    });

   const reply = response.choices[0].message.content;

// ================== NEW ==================

// 1. găsim sau creăm conversația
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

// 2. salvăm mesajele
await supabase.from("messages").insert([
  {
    conversation_id,
    role: "user",
    content: message
  },
  {
    conversation_id,
    role: "assistant",
    content: reply
  }
]);

// ================== PÂNĂ AICI ==================

// 3. răspuns către client
res.json({ reply });

  } catch (err) {
    console.error("EROARE:", err);
    res.status(500).json({ error: "Eroare server" });
  }
});

// PORT corect pentru Railway
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Serverul rulează pe portul ${PORT}`);
});