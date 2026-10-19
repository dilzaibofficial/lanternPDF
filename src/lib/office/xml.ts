/**
 * A small XML reader for Office documents (.docx, .xlsx, .pptx are ZIP files of XML parts).
 *
 * It runs anywhere (page, Web Worker, tests): `DOMParser` does not exist in workers, and these parts are regular
 * enough that a compact parser is enough. It reads elements, attributes, text and CDATA. It deliberately ignores
 * DOCTYPE declarations, so a document cannot define its own entities (no "billion laughs").
 */

export interface XNode {
  /** The tag name as written, prefix included: "w:p", "a:t", "sheetData". */
  name: string;
  attrs: Record<string, string>;
  children: XChild[];
}

export type XChild = XNode | string;

const NAMED_ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const code = entity[1] === "x" || entity[1] === "X" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      try {
        return String.fromCodePoint(code);
      } catch {
        return "";
      }
    }
    return NAMED_ENTITIES[entity] ?? match;
  });
}

const MAX_DEPTH = 256;

export class XmlError extends Error {}

/** Parses one XML document and returns its root element. */
export function parseXml(source: string): XNode {
  let text = source;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const length = text.length;
  const root: XNode = { name: "#document", attrs: {}, children: [] };
  const stack: XNode[] = [root];
  let position = 0;

  const top = (): XNode => stack[stack.length - 1] as XNode;

  while (position < length) {
    const open = text.indexOf("<", position);
    if (open === -1) {
      const tail = text.slice(position);
      if (tail.trim() !== "") top().children.push(decodeEntities(tail));
      break;
    }
    if (open > position) top().children.push(decodeEntities(text.slice(position, open)));

    if (text.startsWith("<!--", open)) {
      const end = text.indexOf("-->", open + 4);
      if (end === -1) throw new XmlError("Unterminated comment");
      position = end + 3;
    } else if (text.startsWith("<![CDATA[", open)) {
      const end = text.indexOf("]]>", open + 9);
      if (end === -1) throw new XmlError("Unterminated CDATA section");
      top().children.push(text.slice(open + 9, end));
      position = end + 3;
    } else if (text.startsWith("<?", open)) {
      const end = text.indexOf("?>", open + 2);
      if (end === -1) throw new XmlError("Unterminated processing instruction");
      position = end + 2;
    } else if (text.startsWith("<!", open)) {
      // DOCTYPE: skip it, including an internal subset in [ ... ]. Nothing in it is used.
      let depth = 0;
      let index = open + 2;
      for (; index < length; index += 1) {
        const char = text[index];
        if (char === "[") depth += 1;
        else if (char === "]") depth -= 1;
        else if (char === ">" && depth <= 0) break;
      }
      position = index + 1;
    } else if (text[open + 1] === "/") {
      const end = text.indexOf(">", open + 2);
      if (end === -1) throw new XmlError("Unterminated closing tag");
      const name = text.slice(open + 2, end).trim();
      const current = top();
      if (stack.length === 1 || current.name !== name) throw new XmlError(`Mismatched closing tag </${name}>`);
      stack.pop();
      position = end + 1;
    } else {
      // An opening tag: name, attributes, then ">" or "/>".
      let index = open + 1;
      while (index < length && !/[\s/>]/.test(text[index] as string)) index += 1;
      const name = text.slice(open + 1, index);
      if (name === "") throw new XmlError("Empty tag name");
      const attrs: Record<string, string> = {};
      let selfClosing = false;
      for (;;) {
        while (index < length && /\s/.test(text[index] as string)) index += 1;
        const char = text[index];
        if (char === undefined) throw new XmlError("Unterminated tag");
        if (char === ">") {
          index += 1;
          break;
        }
        if (char === "/") {
          selfClosing = true;
          index = text.indexOf(">", index);
          if (index === -1) throw new XmlError("Unterminated tag");
          index += 1;
          break;
        }
        const equals = text.indexOf("=", index);
        if (equals === -1) throw new XmlError("Attribute without a value");
        const attrName = text.slice(index, equals).trim();
        index = equals + 1;
        while (index < length && /\s/.test(text[index] as string)) index += 1;
        const quote = text[index];
        if (quote !== '"' && quote !== "'") throw new XmlError("Attribute value is not quoted");
        const close = text.indexOf(quote, index + 1);
        if (close === -1) throw new XmlError("Unterminated attribute value");
        attrs[attrName] = decodeEntities(text.slice(index + 1, close));
        index = close + 1;
      }
      const node: XNode = { name, attrs, children: [] };
      top().children.push(node);
      if (!selfClosing) {
        if (stack.length > MAX_DEPTH) throw new XmlError("The document is nested too deeply");
        stack.push(node);
      }
      position = index;
    }
  }

  if (stack.length !== 1) throw new XmlError("The document ends before every tag is closed");
  const rootElement = root.children.find((child): child is XNode => typeof child !== "string");
  if (!rootElement) throw new XmlError("The document has no root element");
  return rootElement;
}

// ---- Reading helpers ---------------------------------------------------------------------------------

/** The child elements of `node` with this tag name. */
export function kids(node: XNode | undefined, name: string): XNode[] {
  if (!node) return [];
  const found: XNode[] = [];
  for (const child of node.children) if (typeof child !== "string" && child.name === name) found.push(child);
  return found;
}

/** The first child element with this tag name. */
export function kid(node: XNode | undefined, name: string): XNode | undefined {
  if (!node) return undefined;
  for (const child of node.children) if (typeof child !== "string" && child.name === name) return child;
  return undefined;
}

/** All child elements, in order. */
export function elements(node: XNode | undefined): XNode[] {
  if (!node) return [];
  return node.children.filter((child): child is XNode => typeof child !== "string");
}

/** Follows a path of child names, "a/b/c". */
export function dig(node: XNode | undefined, path: string): XNode | undefined {
  let current = node;
  for (const part of path.split("/")) {
    current = kid(current, part);
    if (!current) return undefined;
  }
  return current;
}

export function attr(node: XNode | undefined, name: string): string | undefined {
  return node?.attrs[name];
}

/** The text directly inside `node` and all its descendants. */
export function textOf(node: XNode | undefined): string {
  if (!node) return "";
  let out = "";
  for (const child of node.children) out += typeof child === "string" ? child : textOf(child);
  return out;
}

/** Every descendant element with this name, in document order. */
export function descendants(node: XNode | undefined, name: string, into: XNode[] = []): XNode[] {
  if (!node) return into;
  for (const child of node.children) {
    if (typeof child === "string") continue;
    if (child.name === name) into.push(child);
    descendants(child, name, into);
  }
  return into;
}

/** A numeric attribute, or `fallback` when it is missing or not a number. */
export function num(node: XNode | undefined, name: string, fallback: number): number {
  const raw = node?.attrs[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}
