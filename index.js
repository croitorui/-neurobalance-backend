import express from "express";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import cors from "cors";

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
    const { user_id, message } = req.body;

    if (!user_id || !message) {
      return res.status(400).json({ error: "Lipsește user_id sau mesajul" });
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