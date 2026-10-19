import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { type FamilyId, type Variant, setOfficeFontLoader } from "../../../src/lib/office/fontLibrary";

const require = createRequire(import.meta.url);
const PACKAGE: Record<Exclude<FamilyId, "dejavu">, [string, string]> = { carlito: ["carlito", "Carlito"], arimo: ["arimo", "Arimo"], tinos: ["tinos", "Tinos"], cousine: ["cousine", "Cousine"], caladea: ["caladea", "Caladea"] };
const FOLDER: Record<Variant, string> = { regular: "400Regular", bold: "700Bold", italic: "400Regular_Italic", boldItalic: "700Bold_Italic" };
const DEJAVU: Record<Variant, string> = { regular: "DejaVuSans.ttf", bold: "DejaVuSans-Bold.ttf", italic: "DejaVuSans-Oblique.ttf", boldItalic: "DejaVuSans-BoldOblique.ttf" };
const cache = new Map<string, Uint8Array>();

/** In the browser the fonts come from the bundler; in Node they are the files in node_modules. */
export function installNodeOfficeFonts(): void {
  setOfficeFontLoader(async (family, variant) => {
    const key = `${family}:${variant}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const path = family === "dejavu" ? require.resolve(`dejavu-fonts-ttf/ttf/${DEJAVU[variant]}`) : require.resolve(`@expo-google-fonts/${PACKAGE[family][0]}/${FOLDER[variant]}/${PACKAGE[family][1]}_${FOLDER[variant]}.ttf`);
    const bytes = new Uint8Array(readFileSync(path));
    cache.set(key, bytes);
    return bytes;
  });
}
