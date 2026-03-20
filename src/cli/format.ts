// Terminal formatting helpers for Pennypacker CLI

const COLORS = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
};

export function money(amount: number, showSign = false): string {
  const formatted = Math.abs(amount).toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });

  if (showSign) {
    if (amount > 0) return `${COLORS.green}+$${formatted}${COLORS.reset}`;
    if (amount < 0) return `${COLORS.red}-$${formatted}${COLORS.reset}`;
    return `${COLORS.dim}$0${COLORS.reset}`;
  }

  return `$${formatted}`;
}

export function moneyExact(amount: number): string {
  return `$${Math.abs(amount).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function percent(value: number): string {
  const formatted = value.toFixed(2);
  if (value > 0) return `${COLORS.green}+${formatted}%${COLORS.reset}`;
  if (value < 0) return `${COLORS.red}${formatted}%${COLORS.reset}`;
  return `${COLORS.dim}${formatted}%${COLORS.reset}`;
}

export function heading(text: string): string {
  return `\n${COLORS.bold}${COLORS.cyan}${text}${COLORS.reset}`;
}

export function subheading(text: string): string {
  return `${COLORS.bold}${text}${COLORS.reset}`;
}

export function dim(text: string): string {
  return `${COLORS.dim}${text}${COLORS.reset}`;
}

export function table(headers: string[], rows: string[][], columnAlign?: ("left" | "right")[]): string {
  const align = columnAlign || headers.map(() => "left");

  // Calculate column widths (strip ANSI codes for width calculation)
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
  const widths = headers.map((h, i) => {
    const maxRow = Math.max(...rows.map(r => stripAnsi(r[i] || "").length));
    return Math.max(stripAnsi(h).length, maxRow);
  });

  const pad = (s: string, width: number, direction: "left" | "right") => {
    const len = stripAnsi(s).length;
    const diff = width - len;
    if (diff <= 0) return s;
    const padding = " ".repeat(diff);
    return direction === "right" ? padding + s : s + padding;
  };

  const headerRow = headers.map((h, i) => pad(`${COLORS.bold}${h}${COLORS.reset}`, widths[i] + 8, align[i])).join("  ");
  const separator = widths.map(w => "─".repeat(w)).join("──");
  const dataRows = rows.map(row =>
    row.map((cell, i) => pad(cell, widths[i], align[i])).join("  ")
  );

  return [headerRow, separator, ...dataRows].join("\n");
}

export function sparkline(values: number[]): string {
  if (values.length === 0) return "";
  const chars = "▁▂▃▄▅▆▇█";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  return values
    .map(v => {
      const i = Math.round(((v - min) / range) * (chars.length - 1));
      return chars[i];
    })
    .join("");
}

export function banner(): string {
  return `${COLORS.bold}${COLORS.cyan}
╔══════════════════════════════════════╗
║  H.E. Pennypacker                    ║
║  A Wealthy American Industrialist    ║
╚══════════════════════════════════════╝${COLORS.reset}`;
}
