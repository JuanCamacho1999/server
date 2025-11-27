import express from "express";
import cors from "cors";
import Stripe from "stripe";

const app = express();
app.use(cors());
app.use(express.json());

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Crear sesión de pago
app.post("/create-checkout-session", async (req, res) => {
  try {
    const { servicio, precio } = req.body;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: servicio },
            unit_amount: precio * 100,
          },
          quantity: 1,
        },
      ],
      success_url: "https://TU_DOMINIO/success",
      cancel_url: "https://TU_DOMINIO/cancel",
    });

    res.json({ sessionId: session.id });

  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Puerto
app.listen(3000, () => console.log("Servidor listo en puerto 3000"));
