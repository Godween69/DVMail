import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decryptAuthEnveloped, p7mFromRawMessage, pemToDer, mimeToText } from "../src/smime-gcm.js";

const EXPECTED = "Привет, секретное тело письма.\n";
const dir = mkdtempSync(join(tmpdir(), "dvmail-crypto-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const openssl = (args) => execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
const read = (name) => readFileSync(join(dir, name), "utf8");

// Одноразовая пара «закрытый ключ + сертификат»
function makeIdentity(name) {
  openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", `${name}.key.pem`,
    "-out", `${name}.cert.pem`, "-days", "2", "-subj", `/CN=${name}`]);
  return { key: pemToDer(read(`${name}.key.pem`)), cert: pemToDer(read(`${name}.cert.pem`)) };
}

const alice = makeIdentity("alice");
const bob = makeIdentity("bob");

// Шифруем так же, как это делает Stalwart: AES-256-GCM + RSA-OAEP (SHA-256)
writeFileSync(join(dir, "inner.mime"), `Content-Type: text/plain; charset=utf-8\r\n\r\n${EXPECTED}`);
openssl(["cms", "-encrypt", "-binary", "-aes-256-gcm", "-recip", "alice.cert.pem",
  "-keyopt", "rsa_padding_mode:oaep", "-keyopt", "rsa_oaep_md:sha256", "-keyopt", "rsa_mgf1_md:sha256",
  "-in", "inner.mime", "-out", "enc.eml"]);
const p7m = p7mFromRawMessage(read("enc.eml"));

test("расшифровка возвращает исходный текст", async () => {
  const plain = await decryptAuthEnveloped(p7m, alice.key, alice.cert);
  assert.equal(mimeToText(plain), EXPECTED);
});

test("подмена в конце письма (тег GCM) обнаруживается", async () => {
  const bad = new Uint8Array(p7m);
  bad[bad.length - 5] ^= 1;
  await assert.rejects(decryptAuthEnveloped(bad, alice.key, alice.cert));
});

test("подмена в шифртексте обнаруживается", async () => {
  const bad = new Uint8Array(p7m);
  bad[bad.length - 30] ^= 1;
  await assert.rejects(decryptAuthEnveloped(bad, alice.key, alice.cert));
});

test("чужой ключ не расшифровывает", async () => {
  await assert.rejects(decryptAuthEnveloped(p7m, bob.key, bob.cert), /не для этого ключа/);
});

test("несоответствие ключа и сертификата не расшифровывает", async () => {
  await assert.rejects(decryptAuthEnveloped(p7m, bob.key, alice.cert));
});
