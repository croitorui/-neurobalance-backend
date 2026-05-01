import express from "express";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import cors from "cors";

const app = express();
app.use(express.json());
app.use(cors());

// Conectare Supabase (din ENV)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// OpenAI (din ENV)
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

app.post("/chat", async (req, res) => {
  try {
    const { user_id, message } = req.body;

    if (!user_id || !message) {
      return res.status(400).json({ error: "Lipsește user_id sau mesajul" });
    }

    // 1. Luăm planul userului
    const { data, error } = await supabase
      .from("subscriptions")
      .select("plan")
      .eq("user_id", user_id)
      .eq("is_active", true)
      .single();

    if (error || !data) {
      return res.status(500).json({ error: "Nu există abonament pentru acest user" });
    }

    const plan = data.plan;

    // 2. Prompt diferit în funcție de plan
    let systemPrompt = "";

    if (plan === "FREE") {
      systemPrompt =
        "Ești un asistent de nutriție de bază. Răspunde scurt, simplu și clar, în limba română. Nu oferi detalii complexe.";
    } else if (plan === "CORE") {
      systemPrompt =
        "Ești un coach de nutriție profesionist. Oferă sfaturi structurate și utile, în limba română.";
    } else if (plan === "EXPERT") {
      systemPrompt =
        "Ești un expert de top în nutriție. Oferă răspunsuri detaliate, personalizate și strategice, în limba română.";
    } else {
      systemPrompt =
        "Ești un asistent de nutriție. Răspunde în limba română.";
    }

    // 3. Apel AI
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: systemPrompt + " Explică simplu și pe înțelesul oricui."
        },
        {
          role: "user",
          content: message
        }
      ]
    });

    const reply = response.choices[0].message.content;

    // 4. Trimitem răspunsul
    res.json({ reply });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Eroare server" });
  }
});

// Start server
app.listen(3000, () => {
  console.log("Serverul rulează pe portul 3000");
});