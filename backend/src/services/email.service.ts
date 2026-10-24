import nodemailer from 'nodemailer';

function isDevMode() {
  const user = process.env.GMAIL_USER || '';
  const pass = process.env.GMAIL_APP_PASSWORD || '';
  return !user || !pass || user.includes('your-email') || pass.includes('your-16');
}

function getTransport() {
  if (isDevMode()) return null;
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
}

export async function sendOtpEmail(to: string, otp: string, name: string) {
  const transport = getTransport();
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

  if (!transport) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Gmail delivery is not configured.');
    }
    console.log(`[EMAIL-DEV] OTP for ${to}: ${otp}`);
    return;
  }
  await transport.sendMail({
    from: `"TrustVault" <${process.env.GMAIL_USER}>`,
    to,
    subject: `${otp} — Your TrustVault verification code`,
    html,
  });
}
