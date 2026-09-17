import TurndownService from "turndown";
const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
  br: "\n"
});
turndown.addRule("paragraph", {
  filter: "p",
  replacement(content) {
    return `

${content}

`;
  }
});
turndown.addRule("div", {
  filter: "div",
  replacement(content) {
    return `

${content.trim()}

`;
  }
});
turndown.addRule("heading", {
  filter: ["h1", "h2", "h3", "h4", "h5", "h6"],
  replacement(content, node) {
    const level = Number(node.nodeName.charAt(1));
    return `

${"#".repeat(level)} ${content}

`;
  }
});
turndown.addRule("list", {
  filter: ["ul", "ol"],
  replacement(content, node) {
    const parent = node.parentNode;
    if (parent && (parent.nodeName === "LI" || parent.nodeName === "UL" || parent.nodeName === "OL")) {
      return `
${content}`;
    }
    return `

${content}

`;
  }
});
turndown.addRule("table", {
  filter: "table",
  replacement(_content, node) {
    const table = node;
    const rows = Array.from(table.querySelectorAll("tr"));
    if (rows.length === 0) return "";
    const result = [];
    for (let i = 0; i < rows.length; i++) {
      const cells = Array.from(rows[i].querySelectorAll("th, td"));
      const line = cells.map((c) => turndown.turndown(c.innerHTML ?? c.textContent ?? "").replace(/\n+/g, " ").trim()).join(" | ");
      result.push(`| ${line} |`);
      if (i === 0) {
        result.push(`| ${cells.map(() => "---").join(" | ")} |`);
      }
    }
    return `

${result.join("\n")}

`;
  }
});
turndown.addRule("link", {
  filter: "a",
  replacement(content) {
    const trimmed = content.trim();
    if (!trimmed) return "";
    if (/^\[?\d+\]?$/.test(trimmed)) return "";
    return content;
  }
});
turndown.addRule("image", { filter: "img", replacement: () => "" });
turndown.addRule("figure", { filter: "figure", replacement: () => "" });
turndown.addRule("picture", { filter: "picture", replacement: () => "" });
turndown.addRule("video", { filter: "video", replacement: () => "" });
turndown.addRule("iframe", { filter: "iframe", replacement: () => "" });
turndown.addRule("sup", { filter: "sup", replacement: () => "" });
turndown.addRule("carousel", {
  filter(node) {
    const el = node;
    const cn = el.className || "";
    return el.nodeName === "DIV" && (cn.includes("carousel") || cn.includes("gallery") || cn.includes("slider") || cn.includes("swiper"));
  },
  replacement: () => ""
});
export {
  turndown
};
