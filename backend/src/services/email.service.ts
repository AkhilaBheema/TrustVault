import nodemailer from 'nodemailer';

const EMAIL_TIMEOUT_MS = 10_000;

function isDevMode() {
  const user = process.env.GMAIL_USER?.trim() || '';
  const pass = process.env.GMAIL_APP_PASSWORD?.replace(/\s/g, '') || '';
  return !user || !pass || user.includes('your-email') || pass.includes('your-16');
}

function getResendConfig() {
  const apiKey = process.env.RESEND_API_KEY?.trim() || '';
  const from = process.env.EMAIL_FROM?.trim() || '';
  return apiKey && from ? { apiKey, from } : null;
}

function getTransport() {
  if (isDevMode()) return null;
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      user: process.env.GMAIL_USER?.trim(),
      pass: process.env.GMAIL_APP_PASSWORD?.replace(/\s/g, ''),
    },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
}

async function sendWithResend(
  to: string,
  subject: string,
  html: string,
  apiKey: string,
  from: string
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EMAIL_TIMEOUT_MS);
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to: [to], subject, html }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const details = await response.text();
      throw new Error(`Resend returned ${response.status}: ${details.slice(0, 300)}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

export async function sendOtpEmail(to: string, otp: string, name: string) {
  const resend = getResendConfig();
  const html = `
    <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px;background:#0f1a16;color:#e2e8f0;border-radius:12px">
      <div style="text-align:center;margin-bottom:24px">
        <div style="display:inline-flex;align-items:center;gap:8px">
          <span style="font-size:22px;font-weight:800;color:#34d399">trust<span style="color:#fff">vault</span></span>
        </div>
      </div>
      <h2 style="color:#fff;margin:0 0 8px">Your one-time code</h2>
      <p style="color:#94a3b8;margin:0 0 24px">Hi${name ? ' ' + name : ''},<br>Use this code to verify your identity. It expires in <strong style="color:#f59e0b">10 minutes</strong>.</p>
      <div style="background:#1e2d27;border:1px solid #2d4a3e;border-radius:10px;padding:24px;text-align:center;margin-bottom:24px">
        <span style="font-size:36px;font-weight:800;letter-spacing:12px;color:#34d399">${otp}</span>
      </div>
      <p style="color:#64748b;font-size:12px">If you didn't request this, ignore this email. Never share this code.</p>
    </div>`;

  const subject = `${otp} — Your TrustVault verification code`;
  if (resend) {
    await sendWithResend(to, subject, html, resend.apiKey, resend.from);
    return;
  }

  const transport = getTransport();
  if (!transport) {
    if (process.env.NODE_ENV === 'production') {
    throw new Error('Email delivery is not configured. Set RESEND_API_KEY and EMAIL_FROM.');
    }
    console.log(`[EMAIL-DEV] OTP for ${to}: ${otp}`);
    return;
  }
  await transport.sendMail({
    from: `"TrustVault" <${process.env.GMAIL_USER?.trim()}>`,
    to,
    subject,
    html,
  });
}
