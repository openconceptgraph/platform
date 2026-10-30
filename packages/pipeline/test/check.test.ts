import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkTopic, normalise, pdfPageText, pdftotextArgs, withoutLayoutBrackets } from "../src/check";
import type { Loaded, TopicFile } from "../src/files";

// An invented curriculum page, laid out the way a PDF's text layer holds a
// real one: blocks out of reading order, list letters and raised characters
// on lines of their own, running heads and the page number among the content.

const page = [
  "EXAMPLE CURRICULUM",
  "Counting with signs",
  "• Add and subtract signed numbers",
  "• Multiply signed numbers",
  "b)",
  "(–2) x (–3) = 6",
  "a)",
  "4 – (–1) = 5",
  "Notes",
  "Squares to at least 15 and their roots",
  "2",
  "-- learners say 3 = 6",
  "2",
  "8",
  "A fraction 4 = 2",
  "7",
].join("\n");

const furniture = ["EXAMPLE CURRICULUM"];

function topic(over: Partial<TopicFile> = {}): Loaded<TopicFile> {
  return {
    file: "t.json",
    name: "t",
    data: {
      document: "doc",
      grade: "8",
      topic: "1.1",
      pages: [7],
      regions: [],
      furniture: [],
      concepts: [
        {
          heading: "Counting with signs",
          statements: [
            { code: "c01", text: "Add and subtract signed numbers", page: 7 },
            { code: "c02", text: "Multiply signed numbers", page: 7 },
          ],
        },
      ],
      notes: [
        {
          heading: "Notes",
          statements: [
            { code: "n01", type: "exemplar", text: "a) 4 – (–1) = 5", page: 7 },
            { code: "n02", type: "exemplar", text: "b) (–2) x (–3) = 6", page: 7 },
            { code: "n03", text: "Squares to at least 15² and their roots", page: 7, eyeChecked: true },
            { code: "n04", text: "learners say 3² = 6", page: 7, eyeChecked: true },
            { code: "n05", text: "A fraction 8⁄4 = 2", page: 7, eyeChecked: true },
          ],
        },
      ],
      ...over,
    },
  };
}

const errors = (t: Loaded<TopicFile>) => checkTopic(t, new Map([[7, page]]), furniture).filter((f) => f.level === "error");
const edit = (code: string, text: string) => {
  const t = topic();
  for (const g of [...t.data.concepts, ...t.data.notes]) for (const s of g.statements) if (s.code === code) s.text = text;
  return t;
};

describe("checking a transcription against its PDF", () => {
  it("passes a faithful transcription, whatever order the text layer holds it in", () => {
    expect(checkTopic(topic(), new Map([[7, page]]), furniture)).toEqual([]);
  });

  it("refuses a changed, added or missing word", () => {
    expect(errors(edit("c02", "Multiply and divide signed numbers"))).not.toEqual([]);
    expect(errors(edit("c02", "Multiply signed number"))).not.toEqual([]);
    expect(errors(edit("c02", "Multiply signed numbers quickly"))).not.toEqual([]);
  });

  it("refuses a changed sign or digit, which matter in mathematics", () => {
    expect(errors(edit("n01", "a) 4 – (–1) = 3"))).not.toEqual([]);
    expect(errors(edit("n01", "a) 4 + (–1) = 5"))).not.toEqual([]);
    expect(errors(edit("n02", "b) (–2) x (–3) = –6"))).not.toEqual([]);
  });

  it("finds an omission: printed text that no statement accounts for", () => {
    const t = topic();
    t.data.concepts[0]!.statements.pop();
    const found = errors(t);
    expect(found.some((f) => f.message.includes("not transcribed") && f.message.includes("Multiply signed numbers"))).toBe(true);
  });

  it("refuses a statement transcribed twice", () => {
    const t = topic();
    t.data.concepts[0]!.statements.push({ code: "c03", text: "Multiply signed numbers", page: 7 });
    expect(errors(t).some((f) => f.message.includes("already is"))).toBe(true);
  });

  it("asks for an eye check where raised characters sit apart, and catches a wrong one", () => {
    const t = topic();
    delete t.data.notes[0]!.statements[2]!.eyeChecked;
    const warnings = checkTopic(t, new Map([[7, page]]), furniture).filter((f) => f.level === "warning");
    expect(warnings.some((f) => f.message.includes("raised characters apart"))).toBe(true);
    expect(errors(edit("n04", "learners say 3³ = 6"))).not.toEqual([]);
  });

  it("checks an eye-checked fraction's characters even when their order cannot be", () => {
    expect(errors(edit("n05", "A fraction 8⁄4 = 3"))).not.toEqual([]);
  });

  it("ignores spacing, list markers, curly quotes and dash widths, but not case", () => {
    expect(normalise("a – b  ‘c’").chars).toBe("a-b'c'");
    expect(normalise("2³ x aᵐ⁺ⁿ").chars).toBe("23xam+n");
    expect(errors(edit("c02", "multiply signed numbers"))).not.toEqual([]);
  });
});

describe("brackets a transcription writes for layout", () => {
  it("are those of a root's bar and of a fraction's numerator and denominator", () => {
    expect(withoutLayoutBrackets("√(16 + 9) = 5")).toBe("√16 + 9 = 5");
    expect(withoutLayoutBrackets("(2 x 2)⁄(2) = 2")).toBe("2 x 2⁄2 = 2");
  });

  it("are not printed brackets", () => {
    expect(withoutLayoutBrackets("(3⁄4)² = (–5) x 2")).toBe("(3⁄4)² = (–5) x 2");
  });
});

describe("a page shared with topics not transcribed with it", () => {
  it("is read only in the region the topic occupies", () => {
    expect(pdftotextArgs("c.pdf", 72)).toEqual(["-f", "72", "-l", "72", "-enc", "UTF-8", "c.pdf", "-"]);
    expect(pdftotextArgs("c.pdf", 72, { x: 0, y: 40, width: 126, height: 750 })).toEqual(
      ["-f", "72", "-l", "72", "-x", "0", "-y", "40", "-W", "126", "-H", "750", "-enc", "UTF-8", "c.pdf", "-"],
    );
  });

  const hasPdftotext = !spawnSync("pdftotext", ["-v"]).error;
  it.skipIf(!hasPdftotext)("leaves out the other topics' text, by pdftotext's crop", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ocg-region-"));
    try {
      const pdf = path.join(dir, "shared.pdf");
      await writeFile(pdf, onePagePdf([
        { x: 50, y: 100, text: "Add and subtract signed numbers" },
        { x: 50, y: 500, text: "Investigate and extend patterns" },
      ]));
      expect(await pdfPageText(pdf, 1)).toMatch(/signed numbers[\s\S]*extend patterns/);
      const region = await pdfPageText(pdf, 1, { x: 0, y: 0, width: 595, height: 300 });
      expect(region).toContain("Add and subtract signed numbers");
      expect(region).not.toContain("patterns");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/** A one-page A4 PDF with lines of Helvetica, each placed in points from the page's top left. */
function onePagePdf(lines: { x: number; y: number; text: string }[]): Buffer {
  const content = lines.map((l) => `BT /F1 12 Tf ${l.x} ${842 - l.y} Td (${l.text}) Tj ET`).join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}
