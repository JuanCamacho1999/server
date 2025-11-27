// server.js
// Backend para crear sesiones de Stripe y manejar webhooks, integrado con Firestore.
// Asegúrate de configurar en Render las env vars:
// - STRIPE_SECRET_KEY
// - STRIPE_WEBHOOK_SECRET
// - FIREBASE_SERVICE_ACCOUNT (JSON stringificado)
// Opcional: SUCCESS_URL, CANCEL_URL

const express = require("express");
const Stripe = require("stripe");
const cors = require("cors");
const admin = require("firebase-admin");

const app = express();
app.use(cors());

// Guardar raw body para poder verificar la firma de Stripe más adelante.
// Esto mantiene req.body parseado para el resto de endpoints y además
// deja req.rawBody (Buffer) disponible para el webhook.
app.use(express.json({
  verify: (req, res, buf) => {
    if (buf && buf.length) {
      req.rawBody = buf;
    }
  }
}));

// ---------- Inicializar Firebase Admin ----------
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
  // Intentar inicializar con credenciales por defecto (no recomendado en producción)
  try {
    admin.initializeApp();
    console.log("Firebase Admin inicializado con credenciales por defecto");
  } catch (err) {
    console.error("No se pudo inicializar Firebase Admin. Proporciona FIREBASE_SERVICE_ACCOUNT.");
    process.exit(1);
  }
}

const db = admin.firestore();

// ---------- Inicializar Stripe ----------
if (!process.env.STRIPE_SECRET_KEY) {
  console.error("Falta STRIPE_SECRET_KEY en env vars");
  process.exit(1);
}
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// ---------- Endpoint: crear checkout para una invoice ----------
app.post("/create-checkout-for-invoice", async (req, res) => {
  try {
    const { invoiceId } = req.body;
    if (!invoiceId) return res.status(400).json({ error: "invoiceId requerido" });

    // Leer invoice desde Firestore
    const invRef = db.collection("invoices").doc(invoiceId);
    const invSnap = await invRef.get();
    if (!invSnap.exists) return res.status(404).json({ error: "Invoice no encontrada" });

    const invoice = invSnap.data();

    // Determinar currency (por defecto "usd")
    const currency = invoice.currency || "usd";

    // Construir line_items desde invoice.items
    const line_items = (invoice.items || []).map(item => {
      const price = Number(item.price || 0);
      // Si usas USD, Stripe espera centavos -> price * 100
      const unit_amount = (currency === "usd") ? Math.round(price * 100) : Math.round(price);
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

    // Crear session en Stripe, incluimos metadata.invoiceId para relacionar luego
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      line_items,
      metadata: { invoiceId },
      success_url,
      cancel_url,
    });

    // Guardar checkoutUrl y stripeSessionId en Firestore (invoice)
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

// ---------- Webhook: verificar firma usando req.rawBody ----------
app.post("/webhook", (req, res) => {
  const sig = req.headers["stripe-signature"];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error("⚠️ STRIPE_WEBHOOK_SECRET no configurado.");
    return res.status(500).send("Webhook not configured");
  }

  if (!req.rawBody) {
    console.error("⚠️ No se encontró req.rawBody. Asegúrate de usar express.json with verify para guardar raw body.");
    return res.status(400).send("Raw body required for signature verification");
  }

  let event;
  try {
    // Usar la raw body (Buffer) para la verificación
    event = stripe.webhooks.constructEvent(req.rawBody, sig, webhookSecret);
  } catch (err) {
    console.error("⚠️ Webhook signature verification failed:", err.message);
    // Loguear longitud del raw body para debug (temporal)
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

        console.log("Procesando checkout.session.completed. sessionId:", sessionId, "metadata.invoiceId:", invoiceId);

        if (invoiceId) {
          // Actualizar invoice por metadata
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
          console.log("⚠️ metadata.invoiceId ausente. Buscando invoice por stripeSessionId...");
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
        console.log("Evento no manejado por este webhook:", event.type);
      }
    } catch (err) {
      console.error("❌ Error procesando webhook:", err);
      return res.status(500).send("Error processing webhook");
    }

    // Responder OK a Stripe
    res.json({ received: true });
  })();
});

// ---------- Endpoint de debug (temporal): marcar una invoice como pagada ----------
// NOTA: Este endpoint es solo para pruebas. No dejar sin autenticación en producción.
app.post("/debug/mark-paid", express.json(), async (req, res) => {
  try {
    const { invoiceId } = req.body;
    if (!invoiceId) return res.status(400).json({ error: "invoiceId requerido" });
    const invRef = db.collection("invoices").doc(invoiceId);
    await invRef.update({
      status: "paid",
      paidAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("debug mark-paid error:", err);
    res.status(500).json({ error: String(err) });
  }
});

// ---------- Root simple para debug ----------
app.get("/", (req, res) => res.send("PCaDomicilio backend running"));

// ---------- Start ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server disponible en puerto ${PORT}`));
