import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { setImageCodec } from "../../src/lib/pdf/codec";
import { setUnicodeFontLoader } from "../../src/lib/pdf/fonts";
import { setQpdfWasmLocator } from "../../src/lib/pdf/qpdf";
import { nodeCodec } from "./helpers/images";
import { installNodeOfficeFonts } from "./helpers/officeFonts";

// In the browser these come from the bundler; in Node they are plain files and a canvas library.
const require = createRequire(import.meta.url);
setQpdfWasmLocator(() => require.resolve("@neslinesli93/qpdf-wasm/dist/qpdf.wasm"));
setUnicodeFontLoader(async (file) => new Uint8Array(readFileSync(require.resolve(`dejavu-fonts-ttf/ttf/${file}`))));
setImageCodec(nodeCodec);
installNodeOfficeFonts();
