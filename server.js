import express from "express";
import Stripe from "stripe";
import cors from "cors";
import admin from "firebase-admin";

// Inicializa Firebase Admin (si ya tienes serviceAccount, úsalo aquí)
admin.initializeApp();

const db = admin.firestore();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const app = express();
app.use(cors());

// IMPORTANTE: para webhook usamos body raw. No registres express.json() globalmente antes del webhook.
// Para endpoints normales usamos express.json():
app.use(express.json());

// Crear sesión de checkout para una invoice existente
app.post("/create-checkout-for-invoice", async (req, res) => {
  try {
    const { invoiceId } = req.body;
    if (!invoiceId) return res.status(400).json({ error: "invoiceId requerido" });

    // Leer invoice desde Firestore
    const invRef = db.collection("invoices").doc(invoiceId);
    const invSnap = await invRef.get();
    if (!invSnap.exists) return res.status(404).json({ error: "Invoice no encontrada" });

    const invoice = invSnap.data();

    // Construir line_items a partir de invoice.items
    const line_items = (invoice.items || []).map(item => {
      // currency: si usas USD -> "usd" y unit_amount = price * 100
      // si usas COP -> "cop" y unit_amount = price  (ver nota más abajo)
      return {
        price_data: {
          currency: invoice.currency || "usd",
          product_data: { name: item.desc || "Item" },
          unit_amount: (invoice.currency === "usd") ? Math.round(item.price * 100) : Math.round(item.price)
        },
        quantity: 1
      };
    });

    // crear session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      line_items,
      // metadata para poder relacionar session <-> invoice
      metadata: { invoiceId },
      // success/cancel URLs — cambia a tus urls reales
      success_url: `https://tu-front.com/pago-exitoso?invoiceId=${invoiceId}`,
      cancel_url: `https://tu-front.com/pago-cancelado?invoiceId=${invoiceId}`,
    });

    // Guardar checkoutUrl y stripeSessionId en la invoice
    await invRef.update({
      checkoutUrl: session.url || `https://checkout.stripe.com/pay/${session.id}`,
      stripeSessionId: session.id,
      status: invoice.status || "pending",
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ url: session.url || `https://checkout.stripe.com/pay/${session.id}`, sessionId: session.id });
  } catch (err) {
    console.error("create-checkout error:", err);
    res.status(500).json({ error: String(err) });
  }
});

/*
 * Webhook: stripe envía eventos (checkout.session.completed)
 * IMPORTANTE: Stripe requiere verificar firma. 
 * Para esto usamos express.raw on this route.
 */
app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error("⚠️  Webhook signature verification failed.", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Manejar evento
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const invoiceId = session.metadata?.invoiceId;

    try {
      if (invoiceId) {
        const invRef = db.collection("invoices").doc(invoiceId);
        await invRef.update({
          status: "paid", // o "accepted" si prefieres
          paidAt: admin.firestore.FieldValue.serverTimestamp(),
          paymentInfo: {
            stripeSessionId: session.id,
            amount_total: session.amount_total,
            currency: session.currency,
            customer_email: session.customer_details?.email || null
          }
        });
        console.log("Invoice marcada como pagada:", invoiceId);
      } else {
        console.log("Session completada, pero sin metadata.invoiceId");
      }
    } catch (err) {
      console.error("Error actualizando invoice tras webhook:", err);
    }
  }

  // Responder 200
  res.json({ received: true });
});

// start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on port ${PORT}`));

