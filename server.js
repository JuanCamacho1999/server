// server.js
const express = require("express");
const Stripe = require("stripe");
const cors = require("cors");
const admin = require("firebase-admin");

const app = express();
app.use(cors());

// Guardar raw body para poder verificar firmas de Stripe
app.use(express.json({
  verify: (req, res, buf) => {
    // Guardamos el Buffer original en req.rawBody
    if (buf && buf.length) {
      req.rawBody = buf;
    }
  }
}));

// Inicializa Firebase (igual que antes)
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    console.log("Firebase Admin inicializado desde ENV");
  } catch (err) {
    console.error("FIREBASE_SERVICE_ACCOUNT inválida:", err);
    process.exit(1);
  }
} else {
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

// --- Endpoint normal: create-checkout-for-invoice (usa req.body normalmente) ---
app.post("/create-checkout-for-invoice", async (req, res) => {
  try {
    const { invoiceId } = req.body;
    if (!invoiceId) return res.status(400).json({ error: "invoiceId requerido" });

    const invRef = db.collection("invoices").doc(invoiceId);
    const invSnap = await invRef.get();
    if (!invSnap.exists) return res.status(404).json({ error: "Invoice no encontrada" });

    const invoice = invSnap.data();
    const currency = invoice.currency || "usd";

    const line_items = (invoice.items || []).map(item => {
      const price = Number(item.price || 0);
      let unit_amount = (currency === "usd") ? Math.round(price * 100) : Math.round(price);
      return {
        price_data: {
          currency,
          product_data: { name: item.desc || "Item" },
          unit_amount
        },
        quantity: 1
      };
    });

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

// --- Webhook: verificar firma usando req.rawBody (guardado por express.json verify) ---
app.post("/webhook", (req, res) => {
  const sig = req.headers["stripe-signature"];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error("⚠️ STRIPE_WEBHOOK_SECRET no configurado.");
    return res.status(500).send("Webhook not configured");
  }

  let event;
  try {
    // IMPORTANT: usamos req.rawBody (Buffer) para la verificación
    event = stripe.webhooks.constructEvent(req.rawBody, sig, webhookSecret);
  } catch (err) {
    console.error("⚠️ Webhook signature verification failed:", err.message);
    // Log del rawBody sólo temporalmente si lo necesitas
    try { console.error("Raw body length:", req.rawBody ? req.rawBody.length : "no raw"); } catch(e){}
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log("📥 Webhook recibido:", event.type);

  (async () => {
    try {
      if (event.type === "checkout.session.completed") {
        const session = event.data.object;
        const invoiceId = session.metadata?.invoiceId;
        const sessionId = session.id;

        if (invoiceId) {
          const invRef = db.collection("invoices").doc(invoiceId);
          await invRef.update({
            status: "paid",
            paidAt: admin.firestore.FieldValue.serverTimestamp(),
            paymentInfo: {
              stripeSessionId: sessionId,
              amount_total: session.amount_total,
              currency: session.currency,
              customer_email: session.customer_details?.email || null
            },
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });
          console.log("✅ Invoice actualizada por metadata:", invoiceId);
        } else {
          // Fallback: buscar invoice por stripeSessionId
          const q = await db.collection("invoices").where("stripeSessionId", "==", sessionId).limit(1).get();
          if (!q.empty) {
            const doc = q.docs[0];
            await doc.ref.update({
              status: "paid",
              paidAt: admin.firestore.FieldValue.serverTimestamp(),
              paymentInfo: {
                stripeSessionId: sessionId,
                amount_total: session.amount_total,
                currency: session.currency,
                customer_email: session.customer_details?.email || null
              },
              updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            console.log("✅ Invoice actualizada por stripeSessionId (doc):", doc.id);
          } else {
            console.warn("❗ No se encontró invoice por stripeSessionId:", sessionId);
          }
        }
      } else {
        console.log("Evento no manejado:", event.type);
      }
    } catch (err) {
      console.error("❌ Error procesando webhook:", err);
      // no marcar recibido si hay error de procesamiento
      return res.status(500).send("Error processing webhook");
    }

    // Si todo OK
    res.json({ received: true });
  })();
});

// root simple
app.get("/", (req, res) => res.send("PCaDomicilio backend running"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server en puerto ${PORT}`));

