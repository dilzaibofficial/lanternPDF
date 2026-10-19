import { PDFDocument } from "@cantoo/pdf-lib";
import { describe, expect, it } from "vitest";
import { AppError } from "../../src/lib/errors";
import { probePdf } from "../../src/lib/pdf/inspect";
import { repairPdf } from "../../src/lib/pdf/repair";
import { protectPdf } from "../../src/lib/pdf/security";
import { makeTextPdf, pageTexts } from "./helpers/pdf";

const input = (name: string, bytes: Uint8Array, password?: string) => ({ name, bytes, password });
// Buffer's "latin1" maps every byte 1:1. (TextDecoder("latin1") is really windows-1252 and would
// corrupt binary stream data on the way back, which would make the "damaged" fixture meaningless.)
const latin1 = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1");
const fromLatin1 = (text: string) => new Uint8Array(Buffer.from(text, "latin1"));

/** A 3-page PDF saved with or without object streams (two different on-disk layouts). */
async function layout(useObjectStreams: boolean): Promise<Uint8Array> {
  const doc = await PDFDocument.load(await makeTextPdf("R", 3));
  return doc.save({ useObjectStreams });
}

describe("repairPdf", () => {
  it("rewrites a healthy file and says nothing was wrong", async () => {
    const doc = await makeTextPdf("R", 2);
    const result = await repairPdf(input("ok.pdf", doc));
    expect(result.method).toBe("rewrite");
    expect(result.notes).toEqual([expect.stringMatching(/no structural problems/i)]);
    expect(result.file).toMatchObject({ name: "ok_repaired.pdf", pageCount: 2 });
    expect(await pageTexts(result.file.bytes)).toEqual(["R p1", "R p2"]);
  });

  for (const [label, useObjectStreams] of [
    ["classic xref table", false],
    ["compressed object streams", true],
  ] as const) {
    describe(`with ${label}`, () => {
      it("recovers a file whose startxref offset is wrong", async () => {
        const doc = await layout(useObjectStreams);
        const damaged = fromLatin1(latin1(doc).replace(/startxref\s+\d+/, "startxref\n12"));
        expect((await probePdf(damaged)).state).toBe("damaged");

        const result = await repairPdf(input("bad-offset.pdf", damaged));
        expect(result.method).toBe("rebuild");
        expect(result.file.pageCount).toBe(3);
        expect(await pageTexts(result.file.bytes)).toEqual(["R p1", "R p2", "R p3"]);
        expect(await probePdf(result.file.bytes)).toMatchObject({ state: "ok", pageCount: 3 });
      });

      it("recovers a file cut short before its end markers", async () => {
        const doc = await layout(useObjectStreams);
        const cut = doc.slice(0, latin1(doc).lastIndexOf("startxref"));
        expect((await probePdf(cut)).state).toBe("damaged");

        const result = await repairPdf(input("cut.pdf", cut));
        expect(result.file.pageCount).toBe(3);
        expect(await pageTexts(result.file.bytes)).toEqual(["R p1", "R p2", "R p3"]);
      });
    });
  }

  it("explains that missing content cannot be restored", async () => {
    const doc = await layout(false);
    const damaged = fromLatin1(latin1(doc).replace(/startxref\s+\d+/, "startxref\n12"));
    const { notes } = await repairPdf(input("x.pdf", damaged));
    expect(notes.join(" ")).toMatch(/cannot be restored/i);
  });

  it("fails honestly when no page structure can be found", async () => {
    const garbage = new TextEncoder().encode("%PDF-1.4\n" + "x".repeat(500));
    try {
      await repairPdf(input("garbage.pdf", garbage));
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("DAMAGED_PDF");
      expect((error as AppError).fileName).toBe("garbage.pdf");
      return;
    }
    throw new Error("expected repair to fail");
  });

  it("asks for the password of an encrypted file instead of misreporting damage", async () => {
    const doc = await makeTextPdf("R", 1);
    const locked = await protectPdf(input("l.pdf", doc), { userPassword: "pw" });
    await expect(repairPdf(input("l.pdf", locked.bytes))).rejects.toMatchObject({ code: "PASSWORD_REQUIRED" });
    const ok = await repairPdf(input("l.pdf", locked.bytes, "pw"));
    expect(await probePdf(ok.file.bytes)).toMatchObject({ state: "ok", encrypted: false });
  });
});
