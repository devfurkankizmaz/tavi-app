import nodemailer from 'nodemailer'

const host = process.env.SMTP_HOST

const transport = host
  ? nodemailer.createTransport({
      host,
      port: Number(process.env.SMTP_PORT ?? 587),
      secure: process.env.SMTP_SECURE === '1',
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
    })
  : null

export const mailEnabled = !!transport

/**
 * Skips silently when SMTP is not configured; a mail failure never takes the app down.
 * When HTML is given it travels alongside plain text: mail that is HTML only
 * gets treated as spam.
 */
export async function sendMail(to: string, subject: string, text: string, html?: string): Promise<void> {
  if (!transport) return
  try {
    await transport.sendMail({
      from: process.env.SMTP_FROM ?? 'Tavi <no-reply@localhost>',
      to,
      subject,
      text,
      html,
    })
  } catch (err) {
    console.error('could not send mail:', err)
  }
}
