const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const parseEmailRecipients = (value) => [
  ...new Set(
    String(value || "")
      .split(/[,;\n]+/)
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  ),
];

export const normalizeEmailRecipients = (value, { max = 20 } = {}) => {
  const recipients = parseEmailRecipients(value);
  const invalid = recipients.filter((email) => !EMAIL_PATTERN.test(email));
  return {
    recipients,
    invalid,
    tooMany: recipients.length > max,
    value: recipients.join(", "),
  };
};
