// Расшифровка письма S/MIME формата CMS AuthEnvelopedData (RFC 5083):
// шифр AES-256-GCM, ключ письма защищён RSA-OAEP (SHA-256, MGF1-SHA-256).
// Работает и в браузере, и в Node: только asn1js (BSD-3) и WebCrypto.
import * as asn1js from "asn1js";

const OID_AUTH_ENVELOPED = "1.2.840.113549.1.9.16.1.23";
const OID_RSA_OAEP = "1.2.840.113549.1.1.7";
const OID_AES256_GCM = "2.16.840.1.101.3.4.1.46";
const OID_SHA256 = "2.16.840.1.101.3.4.2.1";

// base64 -> байты (без Buffer, чтобы то же самое работало в браузере)
export function b64ToBytes(b64) {
  const bin = atob(b64.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function pemToDer(pem) {
  return b64ToBytes(pem.replace(/-----[^-]+-----/g, ""));
}

const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");

function sliceBuf(u8) {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

// Серийный номер сертификата (hex без ведущих нулей) для выбора своего получателя
export function certSerialHex(certDer) {
  const c = asn1js.fromBER(sliceBuf(certDer));
  const tbs = c.result.valueBlock.value[0].valueBlock.value;
  const serialNode = tbs[0].idBlock.tagClass === 3 && tbs[0].idBlock.tagNumber === 0 ? tbs[1] : tbs[0];
  return hex(new Uint8Array(serialNode.valueBlock.valueHexView)).replace(/^0+/, "");
}

// Достаёт тело smime.p7m (base64 после пустой строки) из сырого письма
export function p7mFromRawMessage(raw) {
  const text = typeof raw === "string" ? raw : new TextDecoder("latin1").decode(raw);
  const m = text.match(/\r?\n\r?\n([\s\S]*)$/);
  if (!m) throw new Error("не найдено тело письма");
  return b64ToBytes(m[1]);
}

// Основная функция. privateKeyPkcs8Der: Uint8Array (PKCS#8), certDer: Uint8Array (сертификат получателя)
export async function decryptAuthEnveloped(p7m, privateKeyPkcs8Der, certDer) {
  const parsed = asn1js.fromBER(sliceBuf(p7m));
  if (parsed.offset === -1) throw new Error("не удалось разобрать ASN.1");
  const ci = parsed.result.valueBlock.value;
  if (ci[0].valueBlock.toString() !== OID_AUTH_ENVELOPED) throw new Error("это не AuthEnvelopedData");
  // [0] EXPLICIT -> AuthEnvelopedData
  const aed = ci[1].valueBlock.value[0].valueBlock.value;
  let i = 1; // aed[0] = version
  if (aed[i].idBlock.tagClass === 3 && aed[i].idBlock.tagNumber === 0) i++; // originatorInfo (необязательно)
  const recipients = aed[i++].valueBlock.value;
  const eci = aed[i++].valueBlock.value; // AuthEncryptedContentInfo
  let authAttrs = null;
  if (aed[i].idBlock.tagClass === 3 && aed[i].idBlock.tagNumber === 1) authAttrs = aed[i++];
  const tag = new Uint8Array(aed[i++].valueBlock.valueHexView); // MAC = тег GCM

  // 1) выбираем получателя по серийному номеру сертификата
  const mySerial = certSerialHex(certDer);
  let encKey = null;
  for (const r of recipients) {
    const k = r.valueBlock.value;
    if (r.idBlock.tagClass !== 1 || k.length < 4) continue; // KeyTransRecipientInfo = SEQUENCE
    const serial = hex(new Uint8Array(k[1].valueBlock.value[1].valueBlock.valueHexView)).replace(/^0+/, "");
    if (serial !== mySerial) continue;
    const alg = k[2].valueBlock.value;
    if (alg[0].valueBlock.toString() !== OID_RSA_OAEP) throw new Error("защита ключа не RSA-OAEP");
    // хеш OAEP: [0] hashAlgorithm; по умолчанию SHA-1, мы требуем SHA-256
    const params = alg[1] ? alg[1].valueBlock.value : [];
    const h = params.find((p) => p.idBlock.tagClass === 3 && p.idBlock.tagNumber === 0);
    const hashOid = h ? h.valueBlock.value[0].valueBlock.value[0].valueBlock.toString() : null;
    if (hashOid !== OID_SHA256) throw new Error("хеш OAEP не SHA-256: " + hashOid);
    encKey = new Uint8Array(k[3].valueBlock.valueHexView);
  }
  if (!encKey) throw new Error("письмо зашифровано не для этого ключа");

  // 2) снимаем RSA-OAEP: получаем ключ содержимого
  const subtle = globalThis.crypto.subtle;
  const rsaKey = await subtle.importKey("pkcs8", privateKeyPkcs8Der, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["decrypt"]);
  const cek = new Uint8Array(await subtle.decrypt({ name: "RSA-OAEP" }, rsaKey, encKey));

  // 3) параметры GCM: nonce и длина тега
  const cAlg = eci[1].valueBlock.value;
  if (cAlg[0].valueBlock.toString() !== OID_AES256_GCM) throw new Error("шифр не AES-256-GCM");
  const gp = cAlg[1].valueBlock.value;
  const nonce = new Uint8Array(gp[0].valueBlock.valueHexView);
  const icvLen = gp[1] ? Number(gp[1].valueBlock.valueDec) : 12;
  if (tag.length !== icvLen) throw new Error("длина тега не совпала");
  // зашифрованное содержимое: [0] IMPLICIT OCTET STRING (может быть составным)
  const ec = eci[2];
  let ct;
  if (ec.idBlock.isConstructed) {
    const parts = ec.valueBlock.value.map((p) => new Uint8Array(p.valueBlock.valueHexView));
    ct = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { ct.set(p, o); o += p.length; }
  } else ct = new Uint8Array(ec.valueBlock.valueHexView);

  // 4) дополнительные данные GCM: если есть authAttrs, это их DER с тегом SET (0x31)
  let aad;
  if (authAttrs) {
    const der = new Uint8Array(authAttrs.toBER(false));
    der[0] = 0x31;
    aad = der;
  }

  // 5) AES-GCM: WebCrypto ждёт «шифртекст + тег»
  const aes = await subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["decrypt"]);
  const joined = new Uint8Array(ct.length + tag.length);
  joined.set(ct, 0); joined.set(tag, ct.length);
  const plain = await subtle.decrypt({ name: "AES-GCM", iv: nonce, tagLength: icvLen * 8, additionalData: aad }, aes, joined);
  return new Uint8Array(plain);
}

// Внутреннее письмо (MIME-часть) -> текст
export function mimeToText(u8) {
  const s = new TextDecoder("latin1").decode(u8);
  const m = s.match(/\r?\n\r?\n/);
  if (!m) return new TextDecoder("utf-8").decode(u8);
  const head = s.slice(0, m.index);
  const bodyStart = m.index + m[0].length;
  if (/base64/i.test(head)) return new TextDecoder("utf-8").decode(b64ToBytes(s.slice(bodyStart)));
  return new TextDecoder("utf-8").decode(u8.slice(bodyStart));
}
