import express from "express";
import Stripe from "stripe";
import dotenv from "dotenv";
import bodyParser from "body-parser";
import cors from "cors";
import admin from "firebase-admin";

dotenv.config();

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ---------- Firebase Admin init (desde env FIREBASE_SERVICE_ACCOUNT) ----------
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.warn("FIREBASE_SERVICE_ACCOUNT no definido en env");
} else {
  try {
    const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(svc)
    });
    console.log("✅ Firebase Admin inicializado");
  } catch (e) {
    console.error("❌ Error inicializando Firebase Admin:", e.message);
  }
}

const db = admin.firestore();

// ⚠️ Importante: NO usar express.json() antes del webhook

app.use(cors());

// ---------------------------------------------------------
//  WEBHOOK: usa RAW BODY o Stripe no puede verificar la firma
// ---------------------------------------------------------
app.post(
  "/webhook",
  bodyParser.raw({ type: "application/json" }), // RAW BODY
  async (req, res) => {
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

    try {
      if (event.type === "checkout.session.completed") {
        const session = event.data.object;
        console.log("💰 checkout.session.completed - Session ID:", session.id);
        // si pusiste metadata con invoiceId, puedes actualizar la invoice
        if (session.metadata && session.metadata.invoiceId) {
          const invoiceId = session.metadata.invoiceId;
          try {
            await db.collection("invoices").doc(invoiceId).update({
              status: "paid",
              paidAt: admin.firestore.FieldValue.serverTimestamp(),
              paymentMethod: "checkout.session",
              stripeSessionId: session.id
            });
            console.log(`Invoice ${invoiceId} marcada como paid (checkout.session)`);
          } catch (e) {
            console.error("Error actualizando invoice desde checkout.session:", e.message);
          }
        }
      }

      if (event.type === "payment_intent.succeeded") {
        const pi = event.data.object;
        const metadata = pi.metadata || {};
        const invoiceId = metadata.invoiceId;
        console.log("💳 payment_intent.succeeded - PI ID:", pi.id, "invoiceId:", invoiceId);
        if (invoiceId) {
          try {
            await db.collection("invoices").doc(invoiceId).update({
              status: "paid",
              paidAt: admin.firestore.FieldValue.serverTimestamp(),
              paymentIntentId: pi.id,
              amountReceived: pi.amount_received || pi.amount,
              paymentMethod: "payment_intent"
            });
            console.log(`Invoice ${invoiceId} marcada como paid (payment_intent)`);
          } catch (e) {
            console.error("Error actualizando invoice desde payment_intent:", e.message);
          }
        } else {
          console.warn("payment_intent.succeeded sin metadata.invoiceId");
        }
      }

      // Puedes manejar más eventos si lo necesitas
    } catch (e) {
      console.error("Error manejando evento webhook:", e);
    }

    res.json({ received: true });
  }
);

// ---------------------------------------------------------
//  Resto de Endpoints (estos YA PUEDEN usar JSON normal)
// ---------------------------------------------------------
app.use(express.json()); // JSON normal DESPUÉS del webhook

// Endpoint nuevo: crear PaymentIntent para una invoice
app.post("/create-payment-intent", async (req, res) => {
  try {
    const { invoiceId } = req.body;
    if (!invoiceId) return res.status(400).json({ error: "invoiceId requerido" });

    // Leer invoice desde Firestore (ajusta colección/nombres a tu modelo)
    const invRef = db.collection("invoices").doc(invoiceId);
    const snap = await invRef.get();
    if (!snap.exists) return res.status(404).json({ error: "Invoice not found" });

    const data = snap.data() || {};
    // Suponemos que 'total' está guardado como number (ej: 120.5)
    let total = 0;
    if (data.total !== undefined) {
      if (typeof data.total === "number") {
        total = data.total;
      } else if (typeof data.total === "string") {
        total = parseFloat(data.total || "0");
      }
    }

    if (!total || isNaN(total) || total <= 0) {
      return res.status(400).json({ error: "Invoice tiene total inválido" });
    }

    // decidir moneda (ajusta si usas COP u otra moneda)
    const currency = (data.currency && typeof data.currency === "string") ? data.currency : "usd";

    // crear PaymentIntent en cents (Stripe espera integer)
    const amount = Math.round(total * 100);

    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency,
      metadata: {
        invoiceId: invoiceId
      }
    });

    return res.json({ clientSecret: paymentIntent.client_secret });
  } catch (error) {
    console.error("Error create-payment-intent:", error);
    return res.status(500).json({ error: error.message || "stripe error" });
  }
});

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


