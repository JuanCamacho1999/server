import express from "express";
import Stripe from "stripe";
import dotenv from "dotenv";
import bodyParser from "body-parser";
import cors from "cors";

dotenv.config();

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ⚠️ Importante: NO usar express.json() antes del webhook

app.use(cors());

// ---------------------------------------------------------
//  WEBHOOK: usa RAW BODY o Stripe no puede verificar la firma
// ---------------------------------------------------------
app.post(
  "/webhook",
  bodyParser.raw({ type: "application/json" }), // RAW BODY
  (req, res) => {
    const sig = req.headers["stripe-signature"];

    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body, // raw body
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("❌ Webhook signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    console.log("✅ Webhook recibido:", event.type);

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      console.log("💰 Pago confirmado:", session.id);
      console.log("🧾 Cliente:", session.customer_details.email);
      console.log("📦 Producto:", session.metadata.productName);
      console.log("💵 Monto:", session.amount_total / 100);
    }

    res.json({ received: true });
  }
);

// ---------------------------------------------------------
//  Resto de Endpoints (estos YA PUEDEN usar JSON normal)
// ---------------------------------------------------------
app.use(express.json()); // JSON normal DESPUÉS del webhook

app.post("/create-checkout-session", async (req, res) => {
  try {
    const { productName, price } = req.body;

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: productName },
            unit_amount: price * 100,
          },
          quantity: 1,
        },
      ],
      success_url: "https://tuapp.com/success",
      cancel_url: "https://tuapp.com/cancel",
      metadata: {
        productName,
      },
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error("Error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// ---------------------------------------------------------

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor iniciado en puerto ${PORT}`));

