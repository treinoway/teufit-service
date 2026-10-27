const MAX_CONFIRMATION_WORDS = 8;

const CONFIRMATION_WORDS = new Set([
  "sim", "ok", "okay", "confirmo", "confirma", "confirmado", "pode", "podes", "faz", "fazer", "faca",
  "manda", "vai", "bora", "beleza", "certo", "combinado", "claro", "perfeito", "exato", "isso", "confirmar",
  "fechado", "yes", "sure", "ahead", "confirm",
]);

const BLOCKING_WORDS = new Set([
  "nao", "cancela", "cancelar", "espera", "aguarde", "pare", "mas", "porem", "depois", "antes", "talvez", "duvida",
  "vez", "troca", "trocar", "troque", "muda", "mudar", "mude", "altera", "alterar", "altere", "nem", "pera", "calma",
  "errado", "errada", "nope", "wait", "instead",
]);

const CONFIRMATION_REQUEST = /confirm|\b(posso|devo|quer que eu|seguimos|prosseguir|executo|crio|altero|adiciono|renomeio)\b[^?]*\?/i;

// Lowercases, strips accents and punctuation, and splits a message into words.
function toWords(message) {
  return String(message ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^a-z0-9\s?]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

// Tells whether the last message explicitly confirms an action: short, affirmative, no question or negation.
export function isExplicitConfirmation(message) {
  const words = toWords(message);
  if (words.length === 0 || words.length > MAX_CONFIRMATION_WORDS) return false;
  if (String(message).includes("?")) return false;
  if (words.some((word) => BLOCKING_WORDS.has(word))) return false;
  return words.some((word) => CONFIRMATION_WORDS.has(word));
}

// Reads the text of a history entry (plain string or provider content blocks).
function entryText(entry) {
  if (typeof entry.content === "string") return entry.content;
  if (!Array.isArray(entry.content)) return "";
  return entry.content.filter((block) => block?.type === "text").map((block) => block.text ?? "").join(" ");
}

// Tells whether the most recent assistant message in the history asked the trainer to confirm something.
export function lastAssistantAskedForConfirmation(history) {
  const last = [...(history ?? [])].reverse().find((entry) => entry.role === "assistant");
  return last ? CONFIRMATION_REQUEST.test(entryText(last)) : false;
}
