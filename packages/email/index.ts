export interface EmailBinding {
  send(message: { from: string; to: string; subject: string; text: string }): Promise<{ messageId: string }>;
}

export function parseEmail(value: unknown): string | null {
  if (typeof value !== 'string' || /[\r\n]/.test(value)) return null;
  const email = value.trim();
  if (email.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(email)) return null;
  const at = email.lastIndexOf('@');
  if (at > 64 || email.startsWith('.') || email[at - 1] === '.' || email.slice(0, at).includes('..')) return null;
  return email.slice(0, at) + email.slice(at).toLowerCase();
}

export function sendTextEmail(binding: EmailBinding, from: string, to: string, subject: string, text: string) {
  return binding.send({ from, to, subject, text });
}
