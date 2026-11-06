import nodemailer from "nodemailer";
import { parseEmailRecipients } from "./lib/email-recipients";

const escapeHtml = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

const smtpConfiguration = () => {
  const host = String(process.env.SMTP_HOST || "").trim();
  const user = String(process.env.SMTP_USER || "").trim();
  const rawPassword = String(process.env.SMTP_PASSWORD || "");
  const secure =
    String(process.env.SMTP_SECURE || "true").toLowerCase() === "true";
  const port = Number(process.env.SMTP_PORT || (secure ? 465 : 587));
  const password = host.includes("gmail.com")
    ? rawPassword.replace(/\s+/g, "")
    : rawPassword;

  if (!host || !user || !password || !Number.isInteger(port)) return null;

  return {
    host,
    port,
    secure,
    auth: { user, pass: password },
    fromAddress: String(process.env.MAIL_FROM || user).trim(),
    fromName: String(process.env.MAIL_FROM_NAME || "Repro Graphics").trim(),
  };
};

const productText = (product, index) => {
  const options = Object.entries(product.options || {})
    .map(([name, value]) => `    ${name}: ${value}`)
    .join("\n");
  const files = (product.artwork?.uploadedFiles || [])
    .map((file) => `    ${file}`)
    .join("\n");

  return [
    `${index + 1}. ${product.title}`,
    `   Type: ${product.type}`,
    `   Quantities: ${product.quantities.join(", ")}`,
    product.shipping ? `   Shipping: ${product.shipping}` : "",
    product.requiredBy ? `   Required by: ${product.requiredBy}` : "",
    product.url ? `   Product: ${product.url}` : "",
    options ? `   Options:\n${options}` : "",
    product.additionalDetails
      ? `   Additional details: ${product.additionalDetails}`
      : "",
    product.customSpecifications
      ? `   Custom specifications: ${product.customSpecifications}`
      : "",
    product.artwork?.helpRequired
      ? `   Artwork: ${product.artwork.helpRequired}`
      : "",
    product.artwork?.brief ? `   Artwork brief: ${product.artwork.brief}` : "",
    files ? `   Uploaded files:\n${files}` : "",
    product.artwork?.sharedFileLink
      ? `   Shared files: ${product.artwork.sharedFileLink}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
};

const productHtml = (product, index) => {
  const rows = [
    ["Type", product.type],
    ["Quantities", product.quantities.join(", ")],
    ["Shipping", product.shipping],
    ["Required by", product.requiredBy],
    ["Additional details", product.additionalDetails],
    ["Custom specifications", product.customSpecifications],
    ["Artwork", product.artwork?.helpRequired],
    ["Artwork brief", product.artwork?.brief],
  ];
  const options = Object.entries(product.options || {}).map(([name, value]) => [
    name,
    value,
  ]);
  const detailRows = [...rows, ...options]
    .filter(([, value]) => value)
    .map(
      ([name, value]) =>
        `<tr><td style="padding:5px 12px 5px 0;color:#66756f;vertical-align:top">${escapeHtml(name)}</td><td style="padding:5px 0;color:#202b27">${escapeHtml(value)}</td></tr>`,
    )
    .join("");
  const uploadedFiles = (product.artwork?.uploadedFiles || [])
    .map(
      (url, fileIndex) =>
        `<a href="${escapeHtml(url)}" style="color:#007a5c">Artwork file ${fileIndex + 1}</a>`,
    )
    .join(" &nbsp; ");

  return `<section style="margin:18px 0;padding:18px;border:1px solid #dce5e1;border-left:4px solid #008060;border-radius:10px">
    <h3 style="margin:0 0 10px;color:#17211e;font-size:17px">${index + 1}. ${escapeHtml(product.title)}</h3>
    <table role="presentation" style="border-collapse:collapse;font-size:14px">${detailRows}</table>
    ${product.url ? `<p style="margin:12px 0 0"><a href="${escapeHtml(product.url)}" style="color:#007a5c">Open product</a></p>` : ""}
    ${uploadedFiles ? `<p style="margin:10px 0 0">${uploadedFiles}</p>` : ""}
    ${product.artwork?.sharedFileLink ? `<p style="margin:10px 0 0"><a href="${escapeHtml(product.artwork.sharedFileLink)}" style="color:#007a5c">Shared artwork folder</a></p>` : ""}
  </section>`;
};

export async function sendQuoteRequestNotification({
  quote,
  products,
  requestId,
  notificationTo,
}) {
  const config = smtpConfiguration();
  if (!config) return { sent: false, reason: "not_configured" };

  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.auth,
  });
  const customer = [
    quote.contactName,
    quote.contactCompany,
    quote.contactEmail,
    quote.contactPhone,
  ]
    .filter(Boolean)
    .join(" · ");
  const textProducts = products.map(productText).join("\n\n");
  const htmlProducts = products.map(productHtml).join("");

  const configuredRecipients =
    String(notificationTo || "").trim() ||
    String(process.env.QUOTE_NOTIFICATION_TO || "").trim() ||
    config.auth.user;
  const recipients = parseEmailRecipients(configuredRecipients);

  const info = await transporter.sendMail({
    from: { name: config.fromName, address: config.fromAddress },
    to: recipients,
    replyTo: quote.contactEmail,
    subject: `New quote request from ${quote.contactName}`,
    text: `New quote request\n\nCustomer: ${customer}\nCustomer type: ${quote.customerType}\nMarketing consent: ${quote.marketingConsent ? "Yes" : "No"}\nQuote ID: ${quote.id}\nRequest ID: ${requestId}\n\nProducts\n${textProducts}\n\nSource: ${quote.source}${quote.pageUrl ? `\nPage: ${quote.pageUrl}` : ""}`,
    html: `<div style="margin:0 auto;max-width:720px;font-family:Arial,sans-serif;color:#303030;line-height:1.5">
      <div style="padding:22px 24px;border-radius:12px 12px 0 0;background:#006b57;color:#fff">
        <p style="margin:0 0 4px;font-size:12px;letter-spacing:.08em;text-transform:uppercase">Customer enquiry</p>
        <h2 style="margin:0;font-size:24px">New quote request</h2>
      </div>
      <div style="padding:22px 24px;border:1px solid #dce5e1;border-top:0;border-radius:0 0 12px 12px">
        <h3 style="margin:0 0 10px">Customer details</h3>
        <p style="margin:0 0 4px"><strong>${escapeHtml(quote.contactName)}</strong>${quote.contactCompany ? ` · ${escapeHtml(quote.contactCompany)}` : ""}</p>
        <p style="margin:0 0 4px"><a href="mailto:${escapeHtml(quote.contactEmail)}" style="color:#007a5c">${escapeHtml(quote.contactEmail)}</a>${quote.contactPhone ? ` · ${escapeHtml(quote.contactPhone)}` : ""}</p>
        <p style="margin:0 0 18px;color:#66756f">${escapeHtml(quote.customerType)} · Marketing consent: ${quote.marketingConsent ? "Yes" : "No"}</p>
        <h3 style="margin:0">Requested products (${products.length})</h3>
        ${htmlProducts}
        <p style="margin:18px 0 0;color:#66756f;font-size:12px">Quote ID: ${escapeHtml(quote.id)}<br>Request ID: ${escapeHtml(requestId)}<br>Source: ${escapeHtml(quote.source)}${quote.pageUrl ? `<br><a href="${escapeHtml(quote.pageUrl)}" style="color:#007a5c">Open source page</a>` : ""}</p>
      </div>
    </div>`,
  });

  return { sent: true, messageId: info.messageId };
}
