#!/usr/bin/env node
/**
 * Prints candidate .com names (one per line, without ".com") for a free PDF toolkit.
 * Built from plain English words, so every name can be read aloud and spelled from hearing it.
 *
 *   node scripts/seo/domain-candidates.mjs > candidates.txt
 *
 * This only makes a list. Whether a name is free is a separate question: see rdap-check.mjs.
 */

// The product's current name, in the shapes people tend to type.
const SHEAF = ["sheafpdf", "pdfsheaf", "getsheaf", "trysheaf", "usesheaf", "mysheaf", "thesheaf", "sheaftools", "sheafdocs", "sheafapp", "sheafhq", "sheafkit", "sheafdesk", "sheafpages", "sheafonline", "sheafweb"];

// Places and things you work at. Each one is a common word.
const PLACES = [
  "desk", "dock", "nest", "bench", "loft", "studio", "works", "workshop", "forge", "mint", "pilot", "harbor", "haven", "room", "space", "bay",
  "hub", "suite", "lab", "box", "toolbox", "kit", "craft", "cove", "shelf", "drawer", "press", "path", "point", "port", "stack", "shed",
  "shop", "spot", "stand", "vault", "yard", "zone", "wise", "smith", "wright", "mate", "pal", "buddy", "helper", "handy", "garage", "atelier", "corner", "depot",
];

// Words that mean documents.
const DOCS = ["paper", "page", "doc", "file", "folio", "leaf", "sheet", "form", "note", "ink", "print", "binder", "folder", "ledger"];

// Plain describing words, used on their own with "pdf".
const MOODS = [
  "quick", "swift", "tidy", "neat", "handy", "simple", "easy", "smart", "clear", "clean", "bright", "fresh", "open", "free", "super", "prime", "pure",
  "true", "plain", "kind", "calm", "brisk", "nimble", "agile", "rapid", "sharp", "light", "easyto", "daily", "everyday", "friendly", "gentle",
];

// Things you do to a document.
const VERBS = ["stitch", "bind", "fold", "trim", "shrink", "stamp", "sign", "seal", "fix", "mend", "clip", "sort", "polish", "shape", "mold", "weave", "knit", "press"];

const out = new Set(SHEAF);

for (const place of PLACES) {
  out.add(`pdf${place}`);
  out.add(`${place}pdf`);
}
for (const doc of DOCS) {
  for (const place of PLACES) out.add(`${doc}${place}`);
}
for (const mood of MOODS) {
  out.add(`${mood}pdf`);
  out.add(`pdf${mood}`);
}
for (const verb of VERBS) {
  out.add(`${verb}pdf`);
  out.add(`pdf${verb}`);
  out.add(`${verb}pages`);
  out.add(`${verb}docs`);
  out.add(`${verb}papers`);
}

// A few that do not fit the patterns above.
for (const extra of ["pdfandfiles", "pdfwithease", "pdfforall", "pdfsmith", "pdfatelier", "pdffolio", "pdfsheet", "pagetools", "doctools", "filetools", "papertools", "paperworks", "pageworks", "docworks"]) out.add(extra);

// Second list ("words"): one friendly, everyday English word beside "pdf". Easy to say, spell and remember.
const WORDS = [
  // animals
  "otter", "fox", "owl", "finch", "heron", "crane", "wren", "robin", "lark", "kite", "hawk", "panda", "koala", "lynx", "badger", "beaver", "puffin", "penguin", "gecko", "swan", "dove", "duck", "lamb", "pony", "bison", "llama", "alpaca", "camel", "zebra", "tiger", "lion", "bear", "wolf", "hare", "rabbit", "mole", "mouse", "falcon", "eagle", "raven", "crow", "magpie", "swallow", "sparrow", "osprey", "ibis", "egret", "stork",
  // plants
  "maple", "cedar", "birch", "willow", "aspen", "elm", "oak", "pine", "ivy", "fern", "moss", "clover", "daisy", "lotus", "orchid", "tulip", "poppy", "lily", "rose", "sage", "mint", "basil", "thyme", "olive", "cherry", "apple", "peach", "plum", "lemon", "lime", "mango", "berry", "hazel", "juniper", "linden", "alder", "spruce", "bamboo",
  // places in nature
  "river", "brook", "creek", "lake", "glen", "vale", "dale", "ridge", "peak", "summit", "cliff", "meadow", "prairie", "island", "canyon", "valley", "hill", "hollow", "grove", "glade", "field", "forest", "desert", "delta", "dune", "reef", "shore", "tide", "wave", "spring", "falls", "bridge", "trail", "lane", "plaza", "square",
  // everyday objects
  "lantern", "compass", "anchor", "beacon", "kettle", "pebble", "button", "thimble", "needle", "thread", "quilt", "ribbon", "bobbin", "spool", "basket", "bucket", "ladder", "window", "door", "gate", "key", "lock", "bell", "clock", "lamp", "candle", "mirror", "brush", "pencil", "crayon", "marker", "chalk", "eraser", "ruler", "stapler", "clipboard",
  // sky
  "cloud", "breeze", "aurora", "comet", "orbit", "nova", "lunar", "solar", "star", "moon", "sun", "sky", "rain", "snow", "frost", "storm", "wind",
  // colours
  "indigo", "teal", "amber", "coral", "ivory", "jade", "azure", "cobalt", "saffron", "ruby", "pearl", "silver", "golden", "scarlet", "crimson", "violet", "lilac", "mauve",
  // cheerful describing words
  "bright", "calm", "clever", "cosy", "eager", "glad", "happy", "jolly", "keen", "lucky", "merry", "noble", "proud", "rosy", "snug", "sunny", "vivid", "witty", "zesty",
];

let list;
if (process.argv[2] === "words") {
  list = new Set();
  for (const word of WORDS) {
    list.add(`${word}pdf`);
    list.add(`pdf${word}`);
  }
} else {
  list = out;
}

// Short enough to say and type: at most 14 letters before ".com".
const keep = [...list].filter((name) => name.length >= 5 && name.length <= 14 && !name.includes("easyto")).sort();
console.log(keep.join("\n"));
