// 最小的 CSV 读写（RFC 4180 的常用部分：逗号分隔、双引号包字段、引号里的 "" 表示一个引号、引号内可换行）。
// 不引入库：导入的是样例级别的文件；Excel 另存为 CSV 即可。读取时去掉开头的 BOM。
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i += 1;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== "") rows.push(row);
  }
  return rows;
}

/** 第一行是表头；返回每行的 {列名: 值}。 */
export function parseCsvRecords(text: string): Array<Record<string, string>> {
  const [header, ...rows] = parseCsv(text);
  if (!header) return [];
  const names = header.map((h) => h.trim());
  return rows.map((r) => Object.fromEntries(names.map((n, i) => [n, (r[i] ?? "").trim()])));
}

/** 导出：含逗号、引号、换行的字段加引号；以公式字符开头的字段前面加单引号，防止在 Excel 里被当成公式执行。 */
export function toCsv(header: string[], rows: Array<Array<string | number | null | undefined>>): string {
  const cell = (v: string | number | null | undefined) => {
    let s = v === null || v === undefined ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}
