// server.js (CommonJS)
const express = require("express");
const Stripe = require("stripe");
const cors = require("cors");
const admin = require("firebase-admin");

const app = express();

// CORS y JSON para endpoints normales
app.use(cors());
app.use(express.json());

// Inicializar Firebase Admin con service account pasado por ENV
// Espera que FIREBASE_SERVICE_ACCOUNT contenga el JSON stringificado
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log("Firebase Admin inicializado con service account desde ENV");
  } catch (err) {
    console.error("FIREBASE_SERVICE_ACCOUNT inválida:", err);
    process.exit(1);
  }
} else {
  // Intentamos inicializar sin credenciales explícitas (no recomendado en Render)
  try {
    admin.initializeApp();
    console.log("Firebase Admin inicializado sin service account explícito");
  } catch (err) {
    console.error("No se pudo inicializar Firebase Admin. Proporciona FIREBASE_SERVICE_ACCOUNT.");
    process.exit(1);
  }
}

const db = admin.firestore();

// Stripe
if (!process.env.STRIPE_SECRET_KEY) {
  console.error("Falta STRIPE_SECRET_KEY en env vars");
  process.exit(1);
}
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// -------- Endpoint para crear checkout de una invoice --------------
app.post("/create-checkout-for-invoice", async (req, res) => {
  try {
    const { invoiceId } = req.body;
    if (!invoiceId) return res.status(400).json({ error: "invoiceId requerido" });

    // Obtener invoice de Firestore
    const invRef = db.collection("invoices").doc(invoiceId);
    const invSnap = await invRef.get();
    if (!invSnap.exists) return res.status(404).json({ error: "Invoice no encontrada" });

    const invoice = invSnap.data();

    const currency = invoice.currency || "usd";
    // crear line_items a partir de invoice.items
    const line_items = (invoice.items || []).map(item => {
      const price = Number(item.price || 0);
      // unit_amount en centavos si USD, en la propia unidad si COP (ver nota abajo)
      let unit_amount = price;
      if (currency === "usd") unit_amount = Math.round(price * 100);
      else unit_amount = Math.round(price);
      return {
        price_data: {
          currency,
          product_data: { name: item.desc || "Item" },
          unit_amount
        },
        quantity: 1
      };
    });

    // URLs de success/cancel (puedes poner tus rutas)
    const success_url = process.env.SUCCESS_URL || `https://tu-front.com/pago-exitoso?invoiceId=${invoiceId}`;
    const cancel_url = process.env.CANCEL_URL || `https://tu-front.com/pago-cancelado?invoiceId=${invoiceId}`;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      line_items,
      metadata: { invoiceId },
      success_url,
      cancel_url,
    });

    // Guardar checkoutUrl y sessionId en la invoice
    await invRef.update({
      checkoutUrl: session.url || `https://checkout.stripe.com/pay/${session.id}`,
      stripeSessionId: session.id,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ url: session.url || `https://checkout.stripe.com/pay/${session.id}`, sessionId: session.id });
  } catch (err) {
    console.error("create-checkout error:", err);
    res.status(500).json({ error: String(err) });
  }
});

// --------------- Webhook (verifica firma) ------------------
// IMPORTANTE: para webhook usamos express.raw para obtener el body en Buffer
app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error("STRIPE_WEBHOOK_SECRET no configurado en env vars");
    return res.status(500).send("Webhook not configured");
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error("⚠️  Webhook signature verification failed.", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Manejar checkout.session.completed
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const invoiceId = session.metadata?.invoiceId;
    console.log("Webhook: checkout.session.completed for session:", session.id, "invoiceId:", invoiceId);

    if (invoiceId) {
      try {
        const invRef = db.collection("invoices").doc(invoiceId);
        await invRef.update({
          status: "paid", // o "accepted" si prefieres otro nombre
          paidAt: admin.firestore.FieldValue.serverTimestamp(),
          paymentInfo: {
            stripeSessionId: session.id,
            amount_total: session.amount_total,
            currency: session.currency,
            customer_email: session.customer_details?.email || null
          },
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        console.log("Invoice marcada como pagada:", invoiceId);
      } catch (err) {
        console.error("Error actualizando invoice tras webhook:", err);
      }
    } else {
      console.log("Session completada sin metadata.invoiceId");
    }
  }

  res.json({ received: true });
});

// root simple para debug
app.get("/", (req, res) => {
  res.send("PCaDomicilio backend running");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server disponible en puerto ${PORT}`);
});

