/**
 * St. Mary's Mukuru — STK Push server (starter)
 * ------------------------------------------------
 * This is the missing piece that makes the "Send" button on the
 * website trigger a real M-Pesa prompt on a donor's phone, instead
 * of sending them into the M-Pesa app to do it themselves.
 *
 * WHY THIS HAS TO BE SEPARATE FROM THE WEBSITE
 * Your Daraja consumer key/secret are secrets — if they lived inside
 * the website's code, anyone could view-source the page and steal
 * them. So this piece runs on its own, quietly, on a server only you
 * control. The website calls this server; this server calls Safaricom.
 *
 * SETUP
 * 1. npm init -y && npm install express axios dotenv
 * 2. Create a .env file next to this one (never commit it) with:
 *      DARAJA_CONSUMER_KEY=...
 *      DARAJA_CONSUMER_SECRET=...
 *      DARAJA_SHORTCODE=4089583      (the parish Paybill number)
 *      DARAJA_PASSKEY=...            (from the Daraja app, Lipa Na M-Pesa Online)
 *      DARAJA_ENV=sandbox            (switch to "production" when you Go Live)
 *      CALLBACK_URL=https://<your-deployed-domain>/stk-callback
 * 3. Run it: node daraja-stk-server.js
 * 4. Deploy it somewhere with a public HTTPS address (Render, Railway,
 *    Fly.io, a small VPS...) — Safaricom's callback can't reach your
 *    laptop or localhost.
 * 5. In the website's <script>, set:
 *      var BACKEND_ENDPOINT = 'https://<your-deployed-domain>/stk-push';
 * 6. Test everything in sandbox first with Safaricom's test numbers.
 *    When it's solid, submit the "Go Live" request from the Daraja
 *    portal to move from sandbox to real money.
 */

require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const {
  DARAJA_CONSUMER_KEY,
  DARAJA_CONSUMER_SECRET,
  DARAJA_SHORTCODE,
  DARAJA_PASSKEY,
  CALLBACK_URL,
  DARAJA_ENV
} = process.env;

const BASE_URL = DARAJA_ENV === 'production'
  ? 'https://api.safaricom.co.ke'
  : 'https://sandbox.safaricom.co.ke';

async function getAccessToken() {
  const auth = Buffer.from(`${DARAJA_CONSUMER_KEY}:${DARAJA_CONSUMER_SECRET}`).toString('base64');
  const { data } = await axios.get(
    `${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${auth}` } }
  );
  return data.access_token;
}

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear().toString() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

// Called by the website when someone taps "Confirm"
app.post('/stk-push', async (req, res) => {
  try {
    const { name, phone, amount } = req.body;

    if (!name || !phone || !amount || Number(amount) <= 0) {
      return res.status(400).json({ ok: false, error: 'name, phone, and amount are required' });
    }

    // Normalise 07XXXXXXXX or +254XXXXXXXXX to 254XXXXXXXXX
    const msisdn = phone.replace(/\s+/g, '').replace(/^\+/, '').replace(/^0/, '254');

    const token = await getAccessToken();
    const ts = timestamp();
    const password = Buffer.from(`${DARAJA_SHORTCODE}${DARAJA_PASSKEY}${ts}`).toString('base64');

    const { data } = await axios.post(
      `${BASE_URL}/mpesa/stkpush/v1/processrequest`,
      {
        BusinessShortCode: DARAJA_SHORTCODE,
        Password: password,
        Timestamp: ts,
        TransactionType: 'CustomerPayBillOnline', // Pay Bill, since the parish has a paybill (4089583), not a till
        Amount: Math.round(Number(amount)),
        PartyA: msisdn,
        PartyB: DARAJA_SHORTCODE,
        PhoneNumber: msisdn,
        CallBackURL: CALLBACK_URL,
        AccountReference: name.slice(0, 12), // the donor's own name, so the parish can reconcile who gave what — Daraja caps this field at 12 characters
        TransactionDesc: 'Church building fund'
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    res.json({ ok: true, checkoutRequestId: data.CheckoutRequestID });
  } catch (err) {
    console.error(err.response ? err.response.data : err.message);
    res.status(500).json({ ok: false, error: 'Could not start the payment. Please try again.' });
  }
});

// Safaricom calls this on its own once the donor enters their PIN
// (or cancels, or the request times out). The donor never sees this
// endpoint directly.
app.post('/stk-callback', (req, res) => {
  const result = req.body && req.body.Body && req.body.Body.stkCallback;
  console.log('STK callback received:', JSON.stringify(result, null, 2));

  res.json({ ResultCode: 0, ResultDesc: 'Received' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`STK push server running on port ${PORT}`));
