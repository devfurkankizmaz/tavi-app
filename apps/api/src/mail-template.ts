/**
 * Email body.
 *
 * Mail clients do not know modern CSS, so the layout is tables and every
 * style is inline. Colours come from the brand amber, but nothing trusts a
 * dark theme: light ground, dark text, the same in every client.
 * Every message also carries a plain-text part, because HTML-only mail lands
 * in the spam folder.
 */

const ACCENT = '#a86107'
const INK = '#1c1917'
const MUTED = '#6b6560'
const LINE = '#e7e2db'

const escape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export interface MailContent {
  /** The single-line heading above the body. */
  heading: string
  /** One or two paragraphs. */
  lines: string[]
  /** Small fact rows like a task key: ["Due", "Sep 4"] */
  facts?: [string, string][]
  /** The button's label and where it leads. */
  action?: { label: string; url: string }
}

export function renderMail(content: MailContent): { html: string; text: string } {
  const facts = (content.facts ?? []).filter(([, v]) => v)

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${escape(content.heading)}</title></head>
<body style="margin:0;padding:0;background:#faf7f2;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#faf7f2;">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background:#ffffff;border:1px solid ${LINE};border-radius:14px;">
  <tr><td style="padding:22px 26px 0;">
    <span style="font:600 15px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:${ACCENT};letter-spacing:-0.01em;">Tavi</span>
  </td></tr>
  <tr><td style="padding:14px 26px 0;">
    <h1 style="margin:0;font:600 20px/1.35 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:${INK};letter-spacing:-0.02em;">${escape(content.heading)}</h1>
  </td></tr>
${content.lines.map(line => `  <tr><td style="padding:10px 26px 0;">
    <p style="margin:0;font:400 15px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:${INK};">${escape(line)}</p>
  </td></tr>`).join('\n')}
${facts.length ? `  <tr><td style="padding:16px 26px 0;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-top:1px solid ${LINE};">
${facts.map(([k, v]) => `      <tr>
        <td style="padding:8px 0 0;font:400 13px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:${MUTED};">${escape(k)}</td>
        <td align="right" style="padding:8px 0 0;font:600 13px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:${INK};">${escape(v)}</td>
      </tr>`).join('\n')}
    </table>
  </td></tr>` : ''}
${content.action ? `  <tr><td style="padding:22px 26px 0;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
      <td style="background:${ACCENT};border-radius:9px;">
        <a href="${escape(content.action.url)}" style="display:inline-block;padding:11px 20px;font:600 15px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#fffdf9;text-decoration:none;">${escape(content.action.label)}</a>
      </td>
    </tr></table>
  </td></tr>` : ''}
  <tr><td style="padding:24px 26px 22px;">
    <p style="margin:0;font:400 12px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:${MUTED};">
      Sent by Tavi.${content.action ? ` If the button does not work, open<br><a href="${escape(content.action.url)}" style="color:${ACCENT};">${escape(content.action.url)}</a>` : ''}
    </p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`

  const text = [
    content.heading,
    '',
    ...content.lines,
    ...(facts.length ? ['', ...facts.map(([k, v]) => `${k}: ${v}`)] : []),
    ...(content.action ? ['', content.action.label + ':', content.action.url] : []),
    '',
    '—',
    'Sent by Tavi.',
  ].join('\n')

  return { html, text }
}
