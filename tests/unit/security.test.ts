import { describe, expect, it } from "vitest";
import { AppError } from "../../src/lib/errors";
import { hasPdfHeader, probePdf } from "../../src/lib/pdf/inspect";
import { withQpdf } from "../../src/lib/pdf/qpdf";
import { protectPdf, randomPassword, unlockPdf } from "../../src/lib/pdf/security";
import { makeTextPdf, pageTexts } from "./helpers/pdf";

const input = (name: string, bytes: Uint8Array, password?: string) => ({ name, bytes, password });

async function expectAppError(promise: Promise<unknown>, code: string): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
    return error as AppError;
  }
  throw new Error(`expected AppError ${code}, but the call succeeded`);
}

/** qpdf's own description of a file's encryption, to assert permissions really were written. */
async function describeEncryption(bytes: Uint8Array, password: string): Promise<string> {
  return withQpdf((qpdf) => {
    const path = qpdf.put(bytes);
    return qpdf.run([`--password=${password}`, "--show-encryption", path]).output.join("\n");
  });
}

describe("probePdf", () => {
  it("reports page count and no encryption for a normal PDF", async () => {
    const doc = await makeTextPdf("P", 4);
    expect(await probePdf(doc)).toEqual({ state: "ok", pageCount: 4, encrypted: false });
  });

  it("flags empty files and non-PDF content as damaged, with a plain message", async () => {
    expect(await probePdf(new Uint8Array(0))).toMatchObject({ state: "damaged", message: expect.stringMatching(/empty/i) });
    const text = new TextEncoder().encode("hello, I am a text file");
    expect(await probePdf(text)).toMatchObject({ state: "damaged", message: expect.stringMatching(/not a pdf/i) });
  });

  it("flags a file that has the header but no usable structure as damaged", async () => {
    const bad = new TextEncoder().encode("%PDF-1.4\nthis is not really a pdf");
    expect(await probePdf(bad)).toMatchObject({ state: "damaged" });
  });

  it("walks through the password states", async () => {
    const doc = await makeTextPdf("P", 2);
    const locked = await protectPdf(input("p.pdf", doc), { userPassword: "open-sesame" });

    expect(await probePdf(locked.bytes)).toMatchObject({ state: "needs-password" });
    expect(await probePdf(locked.bytes, "nope")).toMatchObject({ state: "wrong-password" });
    expect(await probePdf(locked.bytes, "open-sesame")).toEqual({ state: "ok", pageCount: 2, encrypted: true });
  });

  it("tolerates junk before the %PDF header, as readers do", async () => {
    const doc = await makeTextPdf("P", 1);
    const junk = new Uint8Array(40);
    const withJunk = new Uint8Array(junk.length + doc.length);
    withJunk.set(junk, 0);
    withJunk.set(doc, junk.length);
    expect(hasPdfHeader(withJunk)).toBe(true);
    expect(hasPdfHeader(new TextEncoder().encode("PK\u0003\u0004 not a pdf"))).toBe(false);
  });
});

describe("protectPdf", () => {
  it("produces a file that cannot be opened without the password", async () => {
    const doc = await makeTextPdf("S", 3);
    const out = await protectPdf(input("doc.pdf", doc), { userPassword: "hunter2" });

    expect(out.name).toBe("doc_protected.pdf");
    expect(out.pageCount).toBe(3);
    expect(await probePdf(out.bytes)).toMatchObject({ state: "needs-password" });
    expect(await probePdf(out.bytes, "hunter2")).toMatchObject({ state: "ok", pageCount: 3, encrypted: true });
  });

  it("really encrypts: an independent reader (pdf.js) cannot read it without the password", async () => {
    const doc = await makeTextPdf("MARKER", 1);
    expect(await pageTexts(doc)).toEqual(["MARKER p1"]);
    const out = await protectPdf(input("doc.pdf", doc), { userPassword: "pw" });

    await expect(pageTexts(out.bytes)).rejects.toMatchObject({ name: "PasswordException" });
    await expect(pageTexts(out.bytes, "wrong")).rejects.toMatchObject({ name: "PasswordException" });
    expect(await pageTexts(out.bytes, "pw")).toEqual(["MARKER p1"]);
  });

  it("works with 128-bit keys and with an explicit owner password", async () => {
    const doc = await makeTextPdf("S", 1);
    const out = await protectPdf(input("doc.pdf", doc), { userPassword: "user", ownerPassword: "owner", keyLength: 128 });
    expect(await probePdf(out.bytes, "user")).toMatchObject({ state: "ok" });
    expect(await probePdf(out.bytes, "owner")).toMatchObject({ state: "ok" });
    // qpdf names the scheme rather than the bit length: AESv2 is AES-128 (revision 4).
    const info = await describeEncryption(out.bytes, "user");
    expect(info).toMatch(/R = 4/);
    expect(info).toMatch(/stream encryption method: AESv2/);
    expect(await pageTexts(out.bytes, "user")).toEqual(["S p1"]);
  });

  it("uses AES-256 by default", async () => {
    const doc = await makeTextPdf("S", 1);
    const out = await protectPdf(input("doc.pdf", doc), { userPassword: "user" });
    const info = await describeEncryption(out.bytes, "user");
    expect(info).toMatch(/R = 6/);
    expect(info).toMatch(/stream encryption method: AESv3/);
    expect(await pageTexts(out.bytes, "user")).toEqual(["S p1"]);
  });

  it("accepts unusual passwords, including ones that look like command-line options", async () => {
    const doc = await makeTextPdf("S", 1);
    for (const password of ["--weird", "-x y", "pässwörd", "пароль🔑 with spaces"]) {
      const out = await protectPdf(input("doc.pdf", doc), { userPassword: password });
      expect(await probePdf(out.bytes, password)).toMatchObject({ state: "ok" });
      expect(await probePdf(out.bytes, `${password}x`)).toMatchObject({ state: "wrong-password" });
    }
  });

  it("writes the requested permissions", async () => {
    const doc = await makeTextPdf("S", 1);
    const out = await protectPdf(input("doc.pdf", doc), {
      userPassword: "u",
      ownerPassword: "o",
      allowPrint: false,
      allowCopy: false,
      allowEdit: false,
    });
    const info = await describeEncryption(out.bytes, "u");
    expect(info).toMatch(/print low resolution: not allowed/i);
    expect(info).toMatch(/extract for accessibility: allowed/i); // accessibility is always kept on
    expect(info).toMatch(/extract for any purpose: not allowed/i);
    expect(info).toMatch(/modify other: not allowed/i);
  });

  it("validates passwords before doing any work", async () => {
    const doc = await makeTextPdf("S", 1);
    await expectAppError(protectPdf(input("doc.pdf", doc), { userPassword: "" }), "INVALID_INPUT");
    await expectAppError(protectPdf(input("doc.pdf", doc), { userPassword: "x".repeat(33), keyLength: 128 }), "INVALID_INPUT");
    await expectAppError(protectPdf(input("doc.pdf", doc), { userPassword: "пароль", keyLength: 128 }), "INVALID_INPUT");
    await expectAppError(protectPdf(input("doc.pdf", doc), { userPassword: "x".repeat(128) }), "INVALID_INPUT");
  });

  it("can re-protect an already protected file when its password is given", async () => {
    const doc = await makeTextPdf("S", 1);
    const first = await protectPdf(input("doc.pdf", doc), { userPassword: "one" });
    const second = await protectPdf(input("doc_protected.pdf", first.bytes, "one"), { userPassword: "two" });
    expect(await probePdf(second.bytes, "one")).toMatchObject({ state: "wrong-password" });
    expect(await probePdf(second.bytes, "two")).toMatchObject({ state: "ok" });
  });

  it("generates strong random owner passwords", () => {
    const a = randomPassword();
    const b = randomPassword();
    expect(a).toHaveLength(24);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9]+$/);
  });
});

describe("unlockPdf", () => {
  it("removes the password when the right one is given, keeping the content", async () => {
    const doc = await makeTextPdf("U", 2);
    const locked = await protectPdf(input("doc.pdf", doc), { userPassword: "key" });
    const out = await unlockPdf(input("doc_protected.pdf", locked.bytes), { password: "key", authorized: true });

    expect(out.name).toBe("doc_protected_unlocked.pdf");
    expect(await probePdf(out.bytes)).toEqual({ state: "ok", pageCount: 2, encrypted: false });
    expect(await pageTexts(out.bytes)).toEqual(["U p1", "U p2"]);
  });

  it("explains a wrong or missing password and creates no file", async () => {
    const doc = await makeTextPdf("U", 1);
    const locked = await protectPdf(input("doc.pdf", doc), { userPassword: "key" });
    const wrong = await expectAppError(unlockPdf(input("l.pdf", locked.bytes), { password: "nope", authorized: true }), "WRONG_PASSWORD");
    expect(wrong.message).toMatch(/incorrect/i);
    const missing = await expectAppError(unlockPdf(input("l.pdf", locked.bytes), { authorized: true }), "PASSWORD_REQUIRED");
    expect(missing.message).toMatch(/needs a password/i);
  });

  it("refuses to run without the authorisation flag", async () => {
    const doc = await makeTextPdf("U", 1);
    const locked = await protectPdf(input("doc.pdf", doc), { userPassword: "key" });
    await expectAppError(unlockPdf(input("l.pdf", locked.bytes), { password: "key", authorized: false }), "INVALID_INPUT");
  });

  it("tells the user when there is nothing to unlock instead of returning a copy", async () => {
    const doc = await makeTextPdf("U", 1);
    const error = await expectAppError(unlockPdf(input("plain.pdf", doc), { authorized: true }), "NOT_PROTECTED");
    expect(error.message).toMatch(/nothing to unlock/i);
  });

  it("removes owner-only restrictions from a file that opens without a password", async () => {
    const doc = await makeTextPdf("U", 2);
    // Empty user password + owner password with restrictions: opens freely but is restricted.
    const restricted = await withQpdf((qpdf) => {
      const src = qpdf.put(doc);
      const dst = qpdf.path();
      qpdf.run(["--encrypt", "", "owner-pw", "256", "--print=none", "--modify=none", "--extract=n", "--", src, dst]);
      return qpdf.read(dst).slice();
    });
    expect(await probePdf(restricted)).toEqual({ state: "ok", pageCount: 2, encrypted: true });

    const out = await unlockPdf(input("r.pdf", restricted), { authorized: true });
    expect(await probePdf(out.bytes)).toEqual({ state: "ok", pageCount: 2, encrypted: false });
  });
});

