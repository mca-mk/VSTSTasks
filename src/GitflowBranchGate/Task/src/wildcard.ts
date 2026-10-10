// Mirrors PowerShell's case-insensitive -like operator: * ? [abc] [a-z] and ` escapes.
export function isLike(value: string, pattern: string | undefined): boolean {
  return toRegExp(pattern ?? "").test(value);
}

function toRegExp(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "`" && i + 1 < pattern.length) {
      source += escapeRegExp(pattern[++i]);
    } else if (c === "*") {
      source += "[\\s\\S]*";
    } else if (c === "?") {
      source += "[\\s\\S]";
    } else if (c === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end === -1) {
        source += "\\[";
      } else {
        const body = pattern.slice(i + 1, end).replace(/[\\\]^]/g, "\\$&");
        source += `[${body}]`;
        i = end;
      }
    } else {
      source += escapeRegExp(c);
    }
  }
  return new RegExp(`^${source}$`, "i");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
}

// Mirrors PowerShell's case-insensitive -eq for strings.
export function equalsIgnoreCase(a: string | undefined, b: string | undefined): boolean {
  return (a ?? "").toLowerCase() === (b ?? "").toLowerCase();
}
