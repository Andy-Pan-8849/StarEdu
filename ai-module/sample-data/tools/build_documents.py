#!/usr/bin/env python3
"""Build the StarIT sample documents in mixed formats from Markdown sources.

Reads  ../_markdown-source/<domain>/*.md   (YAML-ish front matter + Markdown)
Writes ../documents/<domain>/<doc_id>_<slug>.<ext>   (ext chosen by `format:` in front matter)
       ../documents/manifest.csv                     (metadata for the ingestion pipeline)

Only the Python standard library is used. Converters:
  docx -> macOS `textutil` (HTML -> DOCX)
  pdf  -> headless Google Chrome (HTML -> PDF)
  md / txt -> written directly
On a non-macOS machine, set the format to md/txt, or swap the two converter functions.
"""
import csv
import html
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "_markdown-source"
OUT = ROOT / "documents"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

CSS = """
body{font-family:Helvetica,Arial,sans-serif;font-size:11pt;line-height:1.45;margin:0}
h1{font-size:20pt;margin:0 0 6pt} h2{font-size:14pt;margin:16pt 0 4pt} h3{font-size:12pt;margin:12pt 0 3pt}
table{border-collapse:collapse;margin:6pt 0} td,th{border:1px solid #888;padding:4pt 6pt;font-size:10pt;text-align:left}
th{background:#e8e8e8} .meta td{font-size:9pt;color:#333}
"""


def parse(path):
    text = path.read_text(encoding="utf-8")
    m = re.match(r"^---\n(.*?)\n---\n(.*)$", text, re.S)
    if not m:
        raise ValueError(f"{path}: missing front matter")
    meta = {}
    for line in m.group(1).splitlines():
        k, _, v = line.partition(":")
        meta[k.strip()] = v.strip()
    return meta, m.group(2).strip() + "\n", text


def inline(s):
    s = html.escape(s)
    s = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", s)
    s = re.sub(r"`(.+?)`", r"<code>\1</code>", s)
    return s


def md_to_html(body):
    out, lines, i = [], body.splitlines(), 0
    list_tag = None

    def close_list():
        nonlocal list_tag
        if list_tag:
            out.append(f"</{list_tag}>")
            list_tag = None

    while i < len(lines):
        ln = lines[i]
        if ln.startswith("|"):
            close_list()
            rows = []
            while i < len(lines) and lines[i].startswith("|"):
                rows.append([c.strip() for c in lines[i].strip().strip("|").split("|")])
                i += 1
            head, rest = rows[0], [r for r in rows[2:]]
            out.append("<table><tr>" + "".join(f"<th>{inline(c)}</th>" for c in head) + "</tr>")
            for r in rest:
                out.append("<tr>" + "".join(f"<td>{inline(c)}</td>" for c in r) + "</tr>")
            out.append("</table>")
            continue
        h = re.match(r"^(#{1,3}) (.*)", ln)
        b = re.match(r"^- (.*)", ln)
        n = re.match(r"^\d+\. (.*)", ln)
        if h:
            close_list()
            out.append(f"<h{len(h.group(1))}>{inline(h.group(2))}</h{len(h.group(1))}>")
        elif b or n:
            tag = "ul" if b else "ol"
            if list_tag != tag:
                close_list()
                out.append(f"<{tag}>")
                list_tag = tag
            out.append(f"<li>{inline((b or n).group(1))}</li>")
        elif ln.strip():
            close_list()
            out.append(f"<p>{inline(ln)}</p>")
        else:
            close_list()
        i += 1
    close_list()
    return "\n".join(out)


def meta_table(meta):
    cells = [("Document ID", "doc_id"), ("Version", "version"), ("Status", "status"),
             ("Effective", "effective_date"), ("Audience", "access"), ("Campus scope", "campus_scope")]
    rows = "".join(f"<tr><td><b>{a}</b></td><td>{html.escape(meta.get(k, ''))}</td></tr>" for a, k in cells)
    return f'<table class="meta">{rows}</table>'


def full_html(meta, body):
    return (f'<html><head><meta charset="utf-8"><style>{CSS}</style></head><body>'
            f"{meta_table(meta)}{md_to_html(body)}</body></html>")


def to_plain(meta, body):
    t = re.sub(r"\*\*(.+?)\*\*", r"\1", body)
    t = re.sub(r"`(.+?)`", r"\1", t)
    t = re.sub(r"^#{1,3} ", "", t, flags=re.M)
    head = "\n".join(f"{k}: {meta.get(k, '')}" for k in
                     ["doc_id", "version", "status", "effective_date", "access", "campus_scope"])
    return head + "\n\n" + t


def build_docx(htm, dest):
    with tempfile.TemporaryDirectory() as td:
        src = Path(td) / "d.html"
        src.write_text(htm, encoding="utf-8")
        subprocess.run(["textutil", "-convert", "docx", str(src), "-output", str(dest)], check=True)


def build_pdf(htm, dest):
    with tempfile.TemporaryDirectory() as td:
        src = Path(td) / "d.html"
        src.write_text(htm, encoding="utf-8")
        subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--no-pdf-header-footer",
                        f"--print-to-pdf={dest}", src.as_uri()],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def main():
    if OUT.exists():
        shutil.rmtree(OUT)
    manifest = []
    for md in sorted(SRC.glob("*/*.md")):
        meta, body, raw = parse(md)
        domain = md.parent.name
        fmt = meta.get("format", "md")
        dest_dir = OUT / domain
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = dest_dir / f"{md.stem}.{fmt}"
        if fmt == "md":
            dest.write_text(raw, encoding="utf-8")
        elif fmt == "txt":
            dest.write_text(to_plain(meta, body), encoding="utf-8")
        elif fmt == "docx":
            build_docx(full_html(meta, body), dest)
        elif fmt == "pdf":
            build_pdf(full_html(meta, body), dest)
        else:
            sys.exit(f"{md}: unknown format {fmt}")
        manifest.append({"file": str(dest.relative_to(OUT)), "domain": domain, "title": meta.get("title", ""),
                         **{k: meta.get(k, "") for k in
                            ["doc_id", "version", "status", "effective_date", "access", "campus_scope"]},
                         "format": fmt})
        print("built", dest.relative_to(ROOT))
    with open(OUT / "manifest.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(manifest[0].keys()))
        w.writeheader()
        w.writerows(manifest)
    print(f"{len(manifest)} documents; manifest written")


if __name__ == "__main__":
    main()
