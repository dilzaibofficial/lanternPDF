/**
 * Tells the converters where the font files are, in the browser. Only the page's bundler can turn a font file into a URL
 * (the `?url` imports), so this module is loaded by the worker and not by the converters themselves, which keeps the
 * converters usable in Node, where tests give them the font files from node_modules instead.
 */
import arimoBold from "@expo-google-fonts/arimo/700Bold/Arimo_700Bold.ttf?url";
import arimoBoldItalic from "@expo-google-fonts/arimo/700Bold_Italic/Arimo_700Bold_Italic.ttf?url";
import arimoRegular from "@expo-google-fonts/arimo/400Regular/Arimo_400Regular.ttf?url";
import arimoItalic from "@expo-google-fonts/arimo/400Regular_Italic/Arimo_400Regular_Italic.ttf?url";
import caladeaBold from "@expo-google-fonts/caladea/700Bold/Caladea_700Bold.ttf?url";
import caladeaBoldItalic from "@expo-google-fonts/caladea/700Bold_Italic/Caladea_700Bold_Italic.ttf?url";
import caladeaRegular from "@expo-google-fonts/caladea/400Regular/Caladea_400Regular.ttf?url";
import caladeaItalic from "@expo-google-fonts/caladea/400Regular_Italic/Caladea_400Regular_Italic.ttf?url";
import carlitoBold from "@expo-google-fonts/carlito/700Bold/Carlito_700Bold.ttf?url";
import carlitoBoldItalic from "@expo-google-fonts/carlito/700Bold_Italic/Carlito_700Bold_Italic.ttf?url";
import carlitoRegular from "@expo-google-fonts/carlito/400Regular/Carlito_400Regular.ttf?url";
import carlitoItalic from "@expo-google-fonts/carlito/400Regular_Italic/Carlito_400Regular_Italic.ttf?url";
import cousineBold from "@expo-google-fonts/cousine/700Bold/Cousine_700Bold.ttf?url";
import cousineBoldItalic from "@expo-google-fonts/cousine/700Bold_Italic/Cousine_700Bold_Italic.ttf?url";
import cousineRegular from "@expo-google-fonts/cousine/400Regular/Cousine_400Regular.ttf?url";
import cousineItalic from "@expo-google-fonts/cousine/400Regular_Italic/Cousine_400Regular_Italic.ttf?url";
import tinosBold from "@expo-google-fonts/tinos/700Bold/Tinos_700Bold.ttf?url";
import tinosBoldItalic from "@expo-google-fonts/tinos/700Bold_Italic/Tinos_700Bold_Italic.ttf?url";
import tinosRegular from "@expo-google-fonts/tinos/400Regular/Tinos_400Regular.ttf?url";
import tinosItalic from "@expo-google-fonts/tinos/400Regular_Italic/Tinos_400Regular_Italic.ttf?url";
import dejavuBoldOblique from "dejavu-fonts-ttf/ttf/DejaVuSans-BoldOblique.ttf?url";
import dejavuBold from "dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf?url";
import dejavuOblique from "dejavu-fonts-ttf/ttf/DejaVuSans-Oblique.ttf?url";
import dejavu from "dejavu-fonts-ttf/ttf/DejaVuSans.ttf?url";
import { AppError } from "../errors";
import { type FamilyId, type FontFileLoader, type Variant, setOfficeFontLoader } from "./fontLibrary";

const URLS: Record<FamilyId, Record<Variant, string>> = {
  arimo: { regular: arimoRegular, bold: arimoBold, italic: arimoItalic, boldItalic: arimoBoldItalic },
  caladea: { regular: caladeaRegular, bold: caladeaBold, italic: caladeaItalic, boldItalic: caladeaBoldItalic },
  carlito: { regular: carlitoRegular, bold: carlitoBold, italic: carlitoItalic, boldItalic: carlitoBoldItalic },
  cousine: { regular: cousineRegular, bold: cousineBold, italic: cousineItalic, boldItalic: cousineBoldItalic },
  tinos: { regular: tinosRegular, bold: tinosBold, italic: tinosItalic, boldItalic: tinosBoldItalic },
  dejavu: { regular: dejavu, bold: dejavuBold, italic: dejavuOblique, boldItalic: dejavuBoldOblique },
};

const loader: FontFileLoader = async (family, variant) => {
  const response = await fetch(URLS[family][variant]);
  if (!response.ok) throw new AppError("ENGINE_FAILED", "A built-in font could not be loaded.", { details: `HTTP ${response.status}` });
  return new Uint8Array(await response.arrayBuffer());
};

export function installBrowserFonts(): void {
  setOfficeFontLoader(loader);
}
